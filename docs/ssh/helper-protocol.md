# SSH helper 协议与状态契约

日期：2026-11-04
状态：v1 定稿；编解码与共享类型已落在 `src-tauri/ssh-core`，helper 端实现属于 `docs/ssh/plan.md` 的 T4/T5。
关联：`docs/ssh/plan.md`、`docs/ssh/research.md`

本文件是 app 与特权 helper 之间的唯一契约。helper 只做控制面（开关系统 sshd、记录所有权），不托管 sshd 进程，也不提供通用命令执行。

## 1. 传输与帧

| 项 | 约定 |
|---|---|
| 编码 | newline-delimited JSON（UTF-8），一行一帧 |
| 单帧上限 | 64 KiB（含换行）。超限只写 helper 日志并断连，不回包（此时没有可信 `id`） |
| 请求 | `{ "id": <u64>, "verb": "<固定动词>", ...参数 }` |
| 响应 | `{ "id": <u64>, "payload": { "type": "...", ... } }` |
| `payload.type` | `hello` / `status` / `ack` / `error` |
| 大小限制的落点 | `ssh_core::read_frame` / `write_frame`；两端都必须用同一实现 |

### 错误如何回包

| 情况 | 处理 |
|---|---|
| 帧超限 / 不是合法 JSON / 缺 `id` | 写 helper 日志（`frame_too_large` / `invalid_frame`），断开连接，**不回包** |
| `id` 可读但动词未知 | 回 `{ "id": <id>, "payload": { "type": "error", "code": "unsupported_verb" } }`，会话可继续 |
| 出现协议外字段（`command`/`path`/`shell` 等） | `Request` 使用 `deny_unknown_fields`，按上一条回 `unsupported_verb` |
| 已验证的固定动词但参数非法（如 `port: 0`） | 回 `unsupported_custom_port`，不改系统状态 |

`read_request`（`ssh_core`）就是按这张表实现的：先解析出 `id`，再严格解析请求。

## 2. 握手

```json
→ {"id":1,"verb":"hello","protocol":1,"app_version":"0.1.6"}
← {"id":1,"payload":{"type":"hello","helper_version":"0.1.6","protocol":1}}
```

- `protocol` 不匹配：回 `helper_version_mismatch`，不断连，便于 UI 展示“需要更新辅助服务”。
  不匹配的会话只允许 `hello` 与 `status`（字段形状固定、用于诊断）；其它动词一律回 `helper_version_mismatch`，不执行特权操作。
- app 在每次会话的第一个请求必须是 `hello`；helper 拒绝 `hello` 之前的任何其它动词。

## 3. 固定动词

| 动词 | 参数 | 语义 |
|---|---|---|
| `status` | — | 返回 `status` payload：实际端口、监听状态、安装来源、随包版本、端口占用详情、host key 指纹 |
| `enable` | `lifetime`, `port` | 幂等开启；已开启时不得重复启动，也不得改写 `owned` |
| `disable` | — | 只在 `owned=true` 时停止系统 sshd |
| `set_lifetime` | `lifetime` | 切换 `app` / `persistent`；`app` 时把服务设为按需启动 |
| `set_port` | `port` | 仅 Windows；macOS 非 22 回 `unsupported_custom_port` |
| `attach` | — | 声明一个客户端会话（引用计数 +1），用于 `lifetime=app` 的退出关闭 |
| `detach` | — | 会话结束（引用计数 -1）；计数归零后按生命周期决定是否关闭 |
| `shutdown_helper` | — | helper 自行退出，由 launchd / SCM 拉起新版本（升级用） |

禁止的参数形态：没有 `command`/`shell`/`path` 字段，没有任意 URL；端口只接受 1–65535 的整数（`0` 由 helper 拒绝并回 `unsupported_custom_port`）。`Request` 开启 `deny_unknown_fields`，多出来的字段直接判为非法帧，不会被静默忽略。

## 4. 错误码

`unsupported_os`、`unsupported_custom_port`、`needs_admin`、`helper_unavailable`、`helper_version_mismatch`、`feature_missing`、`service_missing`、`service_start_failed`、`service_stop_failed`、`firewall_blocked`、`policy_blocked`、`port_in_use`、`busy`、`internal`、`unsupported_verb`、`frame_too_large`、`timeout`。

规则：

- 错误码是 UI 的文案键（`src/core/ssh/messages.ts`），`detail` 只写日志，不下发到设置窗口。
- `frame_too_large` 不会经回包到达 UI（只写日志）；文案表保留该键只为兜底。`unsupported_verb` 只会在协议实现错误时出现，正常路径不展示。
- 特权失败不得让 app 把 `enabled=true` 写进 `settings.json`。
- 失败路径不重试、不提升权限、不扩大操作范围。

## 5. `status` 返回

```json
{
  "enabled": true,        // helper 期望状态
  "os_enabled": true,     // 系统实际状态（launchd job 已加载 / 服务已启动）
  "listening": true,      // 目标端口在监听
  "port": 22,
  "owned": true,          // 是否由本 app 的 helper 开启
  "lifetime": "app",
  "install_source": "system",   // system | fod | bundled
  "bundled_version": null,
  "port_in_use": { "port": 2222, "pid": 921, "process": "nginx" },
  "fingerprint": "SHA256:..."
}
```

`port_in_use` 只在端口被**其它**进程占用时出现；被本机 sshd 占用且就是目标端口时按幂等处理，`os_enabled=true`、`owned` 保持原值。

app 侧：`ssh_status` 返回 `SshSnapshot { runtime, ssh }`，把 `status` 的真实现状与 `settings.json` 里的期望状态（`enabled`/`lifetime`/`port`）一起交给设置窗口；helper 的 `enabled`/`lifetime` 用于 helper 自检与对齐，不以它覆盖用户期望。

## 6. 状态文件

路径：macOS `/Library/Application Support/shrinkdrop/ssh-state.json`；Windows `%ProgramData%\shrinkdrop\ssh-state.json`。root/SYSTEM 所有，原子写（临时文件 + rename），普通用户不可写。

```json
{
  "version": 1,
  "desired": true,
  "lifetime": "app",
  "port": 22,
  "owned": true,
  "installed_by_app": false,
  "enabled_at": 1762000000,
  "previous_start_type": "demand",
  "previous_config_path": null,
  "last_error": null
}
```

字段缺失按默认值处理（`version=1`、`desired=false`、`port=22`、`lifetime=app`）。`version` 是状态文件格式版本（`STATE_VERSION`），与协议 `PROTOCOL` 独立演进。helper 崩溃后靠这个文件在下次启动对齐；`previous_*` 用于回滚用户原始配置，`previous_start_type` 取值 `auto` / `demand` / `disabled`。

## 7. 所有权与引用计数

1. 开启前先读系统状态；已开启则 `owned=false`，不改写任何系统配置。
2. 只有 `owned=true` 且 `lifetime=app` 才允许在最后一个客户端退出后关闭。
3. 用户从 System Settings / 服务管理器手动开关后，helper 只报告状态，不抢控制权。
4. app 以**进程**为粒度持有一个 helper 会话：本地 `attach` 计数只决定何时发 `detach`（0→1 发一次 `attach`，1→0 发一次 `detach`），主窗口与设置窗口共享同一会话。
5. 崩溃兜底：心跳超时后视作最后一个客户端退出。
6. helper 侧按连接计数的多实例保护属于 T7（未实现）；在它落地前，多开 app 实例时的引用计数没有 helper 侧保障。

## 8. 超时与心跳

| 项 | 值 |
|---|---|
| 连接超时 | 2s |
| 单条命令超时 | 10s |
| 心跳间隔 | 5s（`status`） |
| 宽限期 | 15s（心跳丢失后关闭 `lifetime=app` 的实例） |

超时回 `timeout`，不重试；UI 显示“辅助服务响应超时”。

## 9. IPC 认证

macOS：

- Unix domain socket，仅本机路径；权限 `0660`，属主 root、属组管理员组。
- 非管理员进程在 `connect` 阶段就失败，因此 macOS 上没有“已连接但回 `needs_admin`”这回事；`needs_admin` 用在 Windows，以及已连接的 peer 不属于 admin 组 / 不等于当前 console 用户的情况。
- 取 peer 凭据用 `getpeereid()` 或 `LOCAL_PEERCRED`（macOS 没有 Linux 的 `SO_PEERCRED`）；判定是“UID 等于当前 console 用户”，不是“属于会话”。

Windows：

- 命名管道 `\\.\pipe\shrinkdrop-ssh-helper`，`PIPE_REJECT_REMOTE_CLIENTS`。
- DACL 只允许 SYSTEM、Administrators、当前 console 用户 SID。
- 从客户端 PID 取 token，用 linked token 复核 Administrators 组；不能只依赖 UI 判断。

## 10. 日志与脱敏

- 记录：动词、结果、错误码、耗时。不记录：凭据、完整环境变量、`authorized_keys` 内容。
- 不记录用户输入的自由文本（协议本来也没有）。
- 单文件上限 1 MB，保留 1 份轮转；写入权限仅 root/SYSTEM。

## 11. 威胁模型

| 威胁 | 处理 |
|---|---|
| 本地低权限进程连 socket | macOS：socket `0660` 直接拒绝连接；Windows：命名管道 ACL + 管理员组复核，回 `needs_admin` |
| 同用户恶意进程冒充 app | 只接受固定动词；不能借 helper 执行任意命令或改任意文件 |
| 路径注入 | 协议里没有路径参数；helper 内部使用固定常量路径 |
| 命令注入 | 不拼 shell 字符串；`launchctl` / `sc` 全部固定 argv |
| 状态文件篡改 | root 所有 + 原子写；读取时校验字段范围，非法值回退默认并记日志 |
| 版本降级 | 握手校验 `protocol`；不匹配只读降级，不执行特权操作 |
| 特权放大 | helper 只开关系统 sshd 与自身状态；不代理任意权限 |

## 12. 实现状态

| 项 | 状态 |
|---|---|
| 帧编解码、共享类型、错误码、严格请求解析 | 已实现（`src-tauri/ssh-core`，含单测） |
| `ssh_status` / `ssh_*` 命令、`SshSnapshot` / `SshOutcome` 契约 | 已实现（`src-tauri/src/ssh/mod.rs`） |
| app 侧状态机 / 所有权 / 进程内会话计数 / 失败不落盘 | 已实现（假后端单测；真实配置/防火墙回滚属 helper） |
| app 侧 helper 客户端（连接、hello、帧收发、2s/10s/5s/15s 超时与心跳） | 未实现（当前默认后端是 `UnavailableBackend`） |
| helper 二进制、SMAppService / Windows 服务 | 未开始（T4/T5；依赖 T0 PoC 与 Developer ID 签名） |
