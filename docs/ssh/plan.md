# SSH 远程访问开发计划（方案 A：系统 sshd + 特权 helper）

日期：2026-11-04
状态：待开发
关联：`docs/ssh/research.md`
目标：在设置中启用/停用宿主机 OpenSSH Server，并支持「app 运行时」与「后台常驻」两种生命周期。

> 执行方式：按 Task 顺序推进；Task 4 与 Task 5 可并行；Task 6 在 Task 3 的 IPC 契约稳定后即可并行。每个 Task 完成后再进入依赖它的 Task，不跨阶段提前接平台代码。

## 0. 已定决策

| 项 | 决策 |
|---|---|
| 架构 | 系统 sshd + 特权 helper；helper 只做控制面，不托管 sshd 进程 |
| sshd 来源 | macOS 系统内置；Windows 首选 OS 可选功能，失败时可用随包固定版 MSI 或官网手动安装；安装后都是系统级 sshd |
| Windows 安装来源 | 优先系统可选功能（FoD）；失败时 UI 提供“官网下载”和“内置安装（随包固定版 MSI）”；不静默安装随包版本 |
| macOS 支持 | 功能限定 macOS 13+（SMAppService）；更低版本隐藏该功能，不引入 SMJobBless |
| Windows 支持 | Windows 10 1809+ / Windows 11；Home 是否可用由 Task 0 实测确认 |
| 账户要求 | v1 仅管理员账户可操作；标准用户显示明确提示，不做降权授权代理 |
| 端口 | 默认 22；Windows 支持自定义（1–65535）；macOS v1 固定 22，自定义端口需自建 LaunchDaemon，单独立项 |
| 端口占用 | 开启/改端口前检测；被其它进程占用时返回 `port_in_use`，显示端口/PID/进程名并阻止应用；被本机 sshd 占用且为目标端口时按幂等处理 |
| 认证 | 使用 OS 账户 + 密码/公钥；不接入现有分享的 PIN/账号体系 |
| 默认状态 | 关闭；首次开启需二次确认 |
| 默认生命周期 | `app`（退出即关，最安全）；用户可切到 `persistent` |
| helper 安装时机 | 首次开启时安装/注册，不在应用安装阶段静默安装 |
| 多实例 | helper 按连接引用计数；最后一个客户端退出后才按 `app` 生命周期关闭 |
| 非目标 | 公网穿透、端口转发 UI、SFTP 文件浏览、托盘常驻、自研 SSH 服务、macOS 自定义端口（v1 固定 22；需另立 `com.shrinkdrop.sshd`） |

## 1. 里程碑与依赖

```text
T0 平台 PoC/门禁
  ↓
T1 Helper 协议与状态契约
  ↓
T2 设置模型与领域模型
  ↓
T3 SshManager / 命令 / 假后端测试
  ├── T4 macOS helper 与后端
  ├── T5 Windows helper 与后端
  └── T6 设置界面（可在 T3 后并行启动）
        ↓
T7 生命周期与异常路径（跨平台）
        ↓
T8 打包、签名、升级、卸载
        ↓
T9 E2E 与安全评审
        ↓
T10 文档与发布
```

## 2. 任务

### Task 0 平台 PoC 与门禁

**Files:** `docs/ssh/poc.md`（新建）、`scripts/ssh-poc/`（可选）

- [ ] macOS 13/14/15/26 各跑一遍 `launchctl enable/bootstrap` 与 `bootout/disable`。
- [ ] 验证 System Settings → Sharing → Remote Login 开关是否与 launchctl 状态一致。
- [ ] 验证 `Allow access for` / `com.apple.access_ssh` 的实际生效；管理员与非管理员账户分别测试。
- [ ] 验证应用防火墙放行、重启保持、关闭时现有 SSH 会话行为。
- [ ] 验证 FileVault 重启后本地解锁前的 SSH 可达性。
- [ ] 验证未签名 app 通过 `osascript` 提权；记录 SMAppService 在未签名/临时签名下的报错。
- [ ] 验证从 DMG 直接运行（app translocation）时能否注册 helper；记录是否需要强制移动到 `/Applications`。
- [ ] Windows 11 Pro 与 Home 各一台/VM：安装 OpenSSH Server 可选功能、启动 `sshd`、验证防火墙规则、重启保持。
- [ ] Windows 验证非管理员查询状态、UAC 安装 helper、命名管道 ACL、离线/WSUS 失败表现。
- [ ] macOS 验证在 `/etc/ssh/sshd_config.d/` 写 `Port 2222` 后 stock socket-activated listener 是否变化（预期不变）；记录自定义 LaunchDaemon 方案的可行性。
- [ ] Windows 验证自定义端口 2222：改 `sshd_config`、重启服务、防火墙规则、22 是否停止监听。
- [ ] Windows 验证随包 MSI 方案：固定版本下载、SHA256/Authenticode 校验、`msiexec /qn` 安装、服务名/端口、与 FoD 已装的冲突、卸载行为。
- [ ] Windows 验证端口占用检测：先占用 2222，再开启，确认可拿到 PID/进程名并阻止；释放后成功。
- [ ] 把命令、输出、结论写入 `docs/ssh/poc.md`。

**Gate G1：** 如果 macOS `launchctl` 路径在目标版本不可靠，先决定回退到 `systemsetup` + Full Disk Access 引导，还是缩小功能范围；不要带着未验证路径进入实现。
**Gate G2：** 如果 Windows Home 不可用，功能在 Home 上隐藏；支持矩阵按实测结果写死。
**Gate G3：** 确认 macOS helper 必须在 Developer ID 签名下才能工作；未签名包不作为发布候选。

**Acceptance:** 所有 Gate 有结论；研究文档中的“待验证”项有实测记录。

---

### Task 1 Helper 协议与状态契约

**Files:** `docs/ssh/helper-protocol.md`（新建）

- [ ] 定义消息帧：newline-delimited JSON，单条上限 64 KiB，请求/响应带 `id`。
- [ ] 定义握手：`hello { protocol, appVersion }`，helper 返回 `{ helperVersion, protocol }`；版本不匹配时返回 `helper_version_mismatch`。
- [ ] 定义固定动词：`status`、`enable`、`disable`、`set_lifetime`、`attach`、`detach`、`shutdown_helper`；禁止任意命令/路径参数。卸载 helper 不走 IPC，由 app/安装器的提权流程单独处理。
- [ ] `enable` 携带 `lifetime` 与 `port`；`status` 返回实际端口、监听状态、安装来源（FoD/standalone/bundled）、随包版本与 `port_in_use` 详情（port/pid/process）。
- [ ] 定义错误码：`unsupported_os`、`unsupported_custom_port`、`needs_admin`、`helper_unavailable`、`helper_version_mismatch`、`feature_missing`、`service_missing`、`service_start_failed`、`service_stop_failed`、`firewall_blocked`、`policy_blocked`、`port_in_use`、`busy`、`internal`。
- [ ] 定义状态文件：`version`、`desired`、`lifetime`、`port`、`owned`、`installed_by_app`、`enabled_at`、`previous_start_type`、`previous_config_path`、`last_error`；root/SYSTEM 所有，原子写。
- [ ] 定义所有权/引用计数：只有 `owned=true` 且 `lifetime=app` 才在最后一个客户端退出后关闭；用户手动开启的实例不自动关闭。
- [ ] 定义心跳与超时：心跳 5s，helper 宽限 15s；命令超时 10s；连接超时 2s。
- [ ] 定义 IPC 认证：
  - macOS：Unix socket 仅本机；校验 peer UID 属于 admin 组且属于当前 console 会话；socket 权限 0600/0660。
  - Windows：命名管道拒绝远程客户端；ACL 仅 SYSTEM、Administrators、当前 console 用户 SID；helper 再用 linked token 复核调用方是管理员。
- [ ] 定义日志与脱敏：不记录凭据、不记录完整环境变量；记录动词、结果、错误码；单文件大小上限与轮转。
- [ ] 威胁模型：本地低权限进程、同用户恶意进程、路径注入、命令注入、状态文件篡改、版本降级。

**Acceptance:** 协议文档评审通过；app 与 helper 可独立按文档实现；没有“执行任意命令”的接口。

---

### Task 2 设置模型与领域模型

**Files:** `src-tauri/src/settings.rs`、`src-tauri/src/ssh/mod.rs`、`src-tauri/ssh-core/src/lib.rs`、`src/core/settings/types.ts`

- [ ] 新增 `SshLifetime { App, Persistent }`，serde 序列化为 `app` / `persistent`。
- [ ] 新增 `SshSettings { enabled, lifetime, port }`，默认 `enabled=false`、`lifetime=App`、`port=22`。
- [ ] 端口校验：1–65535；macOS v1 只接受 22；非法值不写入。
- [ ] `Settings` 增加 `ssh` 字段；旧 `settings.json` 缺失该字段时使用默认值。
- [ ] 新增 `SshRuntime`：`supported`、`platform`、`helperInstalled`、`helperApproved`、`osEnabled`、`owned`、`listening`、`address`、`port`、`installSource`、`bundledVersion`、`fingerprint`、`error`。
- [ ] 新增 `SshErrorCode`，与协议错误码一一对应。
- [ ] `SettingsView` 包含 `ssh`；`SettingsUpdatePayload` 不包含 `ssh`，避免通用“保存设置”覆盖 SSH 运行态；`enabled`/`lifetime` 都走专用 `ssh_*` 命令持久化。
- [ ] 前端 `SettingsView` / `defaultSettings()` 同步类型。
- [ ] 单元测试：默认值、旧 JSON 反序列化、roundtrip、非法 lifetime 拒绝。

**Acceptance:** `cargo test` 通过；现有设置文件可无损加载；前端类型检查通过。

---

### Task 3 SshManager、命令与假后端测试

**Files:** `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/ssh-core/Cargo.toml`、`src-tauri/ssh-helper/Cargo.toml`、`src-tauri/src/ssh/mod.rs`、`src-tauri/src/ssh/backend.rs`、`src-tauri/src/lib.rs`

- [ ] 定义 `SshBackend` trait：`status`、`enable`、`disable`、`set_lifetime`、`set_port`、`install_helper`、`uninstall_helper`。
- [ ] 建立 workspace：`src-tauri/Cargo.toml` 增加 `[workspace] members = ["ssh-core", "ssh-helper"]`、`default-members = ["."]`（根 package 自动是成员）；app 通过 path 依赖 `shrinkdrop-ssh-core`。
- [ ] `ssh-helper` 是独立 bin crate，不依赖 `tauri`/`shrinkdrop_lib`，只依赖 `ssh-core` 与平台 crate；避免 helper 链接 GUI 依赖。
- [ ] 提供构建命令/脚本：`cargo build -p shrinkdrop-ssh-helper`；macOS universal 合并留给 Task 8。
- [ ] 实现 `SshManager`：持有 runtime、helper 连接、引用计数、最后一次错误。
- [ ] 状态机：`disabled → enabling → enabled → disabling → disabled`，附错误态。
- [ ] `enable`：先读 OS 状态；已开启则 `owned=false`，不重复操作；关闭则开启并置 `owned=true`。
- [ ] 端口预检：开启/改端口前检查目标端口；被其它进程占用返回 `port_in_use`（含 PID/进程名），不写配置、不启动；被本机 sshd 占用且为目标端口则按幂等处理。
- [ ] `set_port`：未开启时只持久化；已开启时 Windows 预检并重配/重启，macOS 端口非 22 直接 `unsupported_custom_port`。
- [ ] 失败回滚：配置/防火墙/服务启动失败时恢复到操作前状态，不把 `enabled=true` 写入 settings。
- [ ] `disable`：仅 `owned=true` 时关闭 OS；否则只清 desired，UI 提示“仍由系统开启”。
- [ ] `set_lifetime`：`app` 时 attach 并让后端把 Windows 服务设为按需启动；`persistent` 时 detach、保持开启并设为自动启动。
- [ ] `reconcile`：启动/聚焦时读取 helper 与 OS 状态，更新 runtime；不覆盖用户手动状态。
- [ ] 启动时仅当 `enabled=true` 且 helper 已安装/已批准才 attach；helper 缺失时只显示错误，不在启动阶段弹管理员授权。
- [ ] `address` 复用分享服务的局域网地址探测（`if-addrs`/`share::net`），`username` 取当前系统用户。
- [ ] 能力门禁：macOS `>= 13`、Windows build `>= 17763`；不满足时 `supported=false`，UI 隐藏/禁用，不尝试安装 helper。
- [ ] `shutdown`：`lifetime=app` 且 owned 时请求关闭；`persistent` 时只 detach；失败只记录，不阻塞关窗。
- [ ] 注册命令：`ssh_status`、`ssh_enable`、`ssh_disable`、`ssh_set_lifetime`、`ssh_set_port`、`ssh_install_helper`、`ssh_uninstall_helper`。
- [ ] `lib.rs`：`.manage(SshManager::default())`；启动时 reconcile；`CloseRequested` 调用 shutdown，注意幂等。
- [ ] 覆盖 Cmd+Q/系统退出：如 Tauri 提供 `RunEvent::ExitRequested`，同样调用幂等 shutdown；不能只依赖窗口关闭事件。
- [ ] 假后端测试：已开启不抢占、关闭只关自己、两种生命周期、helper 缺失、版本不匹配、超时、手动覆盖、重复 enable/disable、多客户端引用计数。
- [ ] 失败语义：特权操作失败时不得把 `enabled=true` 写入 settings；返回错误码给 UI。

**Acceptance:** 纯逻辑单测覆盖所有状态转移；`cargo test` 通过；无平台特权操作进入测试。

---

### Task 4 macOS helper 与后端

**Files:** `src-tauri/ssh-helper/src/main.rs`、`src-tauri/ssh-helper/src/macos.rs`、`src-tauri/src/ssh/macos.rs`、`src-tauri/installer/macos/com.shrinkdrop.ssh-helper.plist`、`scripts/ssh-helper-dev.sh`

- [ ] helper 二进制：Unix socket server、JSON 协议、状态文件、日志、固定动词。
- [ ] peer 认证：校验 peer UID 属于 admin 组，且属于当前 console 会话；非管理员返回 `needs_admin`；socket 权限按协议文档。
- [ ] 控制面：`launchctl enable/bootstrap`、`bootout/disable`，全部使用固定参数；幂等处理“未加载/已加载”。
- [ ] 端口：v1 固定 22；收到非 22 返回 `unsupported_custom_port`，不修改 `sshd_config`/plist。
- [ ] 端口预检：开启前检查 22；被其它进程占用返回 `port_in_use`；被 `com.openssh.sshd` 占用按幂等处理；用 `lsof`/`libproc` 尝试返回 PID/进程名，拿不到就只报端口占用。
- [ ] 状态读取：`launchctl print system/com.openssh.sshd`、`launchctl print-disabled system`、`nc`/TCP 连接 22；不要依赖 `systemsetup`（FDA）。
- [ ] host key：读取 `/etc/ssh/ssh_host_ed25519_key.pub`（缺失时尝试 RSA/ECDSA），计算 SHA256 指纹返回给 UI；没有 key 时返回 null。
- [ ] 输出诊断：端口占用、防火墙、`com.apple.access_ssh`、MDM 策略。
- [ ] LaunchDaemon plist：`Label=com.shrinkdrop.ssh-helper`、`BundleProgram=Contents/Resources/shrinkdrop-ssh-helper`、`RunAtLoad=true`、`KeepAlive=true`。
- [ ] `SMAppService.daemon("com.shrinkdrop.ssh-helper.plist")` 注册/注销/状态查询；`requiresApproval` 时引导到登录项设置。
- [ ] SMAppService 绑定优先用 `objc2` + ServiceManagement；若绑定成本过高，增加最小 Swift/ObjC shim（只做注册/状态，不做 IPC）。
- [ ] 开发模式：`SHRINKDROP_SSH_DEV=1` 时允许手动安装到 `/Library/LaunchDaemons`，不要求 Developer ID；生产模式禁止。
- [ ] 升级：app 更新后 helper 版本不一致时，请求 helper 退出并由 launchd 拉起新二进制，或重新注册。
- [ ] 单元测试：协议解析、状态机、launchctl 输出解析（fixture）。
- [ ] 手工 E2E：开启/关闭、System Settings 同步、app 退出、崩溃、重启保持、手动覆盖、helper 批准/拒绝。

**Acceptance:** macOS 上可完成一次真实 SSH 登录；`app` 生命周期退出后 22 关闭；`persistent` 重启后仍可连；用户手动开启时不会被误关；非 22 端口明确拒绝。

---

### Task 5 Windows helper 与后端

**Files:** `src-tauri/ssh-helper/src/main.rs`、`src-tauri/ssh-helper/src/windows.rs`、`src-tauri/src/ssh/windows.rs`、`scripts/ssh-helper-dev.ps1`

- [ ] helper Windows 服务：`ShrinkdropSshHelper`，LocalSystem，`SERVICE_AUTO_START`。
- [ ] 命名管道：`\\.\pipe\shrinkdrop-ssh-helper`，`PIPE_REJECT_REMOTE_CLIENTS`；ACL 仅 SYSTEM、Administrators、当前 console 用户 SID。
- [ ] 调用方鉴权：从客户端 PID 取 token，使用 linked token 校验 Administrators 组；非管理员一律 `needs_admin`，不能只依赖 UI。
- [ ] 服务控制：`OpenSCManager` / `OpenService("sshd")` / `StartService` / `ControlService(STOP)` / `ChangeServiceConfig` / `QueryServiceStatusEx`。
- [ ] 启动类型：`persistent` 设 `SERVICE_AUTO_START`；`app` 设 `SERVICE_DEMAND_START`，退出停止；记录并恢复原始启动类型，避免永久改坏用户配置。
- [ ] 可选功能：检测 `OpenSSH.Server~~~~0.0.1.0`；缺失时通过 DISM API 或 `%SystemRoot%\System32\dism.exe` 固定参数安装；处理离线/WSUS/策略失败。
- [ ] 安装来源优先级：已有 `sshd` 服务 → 直接用；否则尝试 FoD；FoD 失败时 UI 提供“官网下载”和“内置安装”，不静默安装随包版本。
- [ ] 官网下载：打开 `https://github.com/PowerShell/Win32-OpenSSH/releases`；用户手动安装后“重新检测”服务/二进制；不自动运行下载的文件。
- [ ] 内置安装：随包固定版 `OpenSSH-Win64-v<version>.msi`；安装前校验 SHA256（若 MSI 有 Authenticode 签名则一并校验）；`msiexec /i ... /qn /norestart`；映射 0/3010/1603/1618 错误；记录 `installedByApp`。
- [ ] 冲突保护：系统里已有 `sshd` 服务时禁止再装随包 MSI；避免 FoD 与 standalone 两套 OpenSSH 抢服务名/端口。
- [ ] 防火墙：校验 `OpenSSH-Server-In-TCP` 存在且启用；缺失时用固定参数创建（仅入站 TCP 22）。
- [ ] 自定义端口：解析 `%ProgramData%\ssh\sshd_config` 的 active `Port` 行，写入带标记的托管块；改前备份，`sshd -t` 校验，重启 `sshd`，失败回滚。
- [ ] 端口占用：用 `GetExtendedTcpTable`（或等价 API）查监听者；被其它进程占用返回 `port_in_use`（port/pid/process），不写配置、不启服务；被本机 `sshd` 占用且为目标端口按幂等处理。
- [ ] 端口防火墙：自定义端口创建独立规则（如 `shrinkdrop-ssh-<port>`），不改 stock `OpenSSH-Server-In-TCP`；关闭/卸载/换端口时删除自己创建的规则。
- [ ] 端口生效校验：服务启动后确认目标端口在监听、22 不再监听（自定义端口时）；失败回滚配置/防火墙并返回错误。
- [ ] host key：读取 `%ProgramData%\ssh\ssh_host_ed25519_key.pub`（缺失时尝试 RSA/ECDSA），计算 SHA256 指纹返回给 UI；没有 key 时返回 null。
- [ ] 安装/卸载：`--install-service --allow-sid <SID>`、`--uninstall-service`；服务 exe 放 `%ProgramData%\shrinkdrop\ssh-helper\<version>\`，该目录 ACL 只允许 SYSTEM/Administrators 写，避免升级时文件锁与普通用户替换。
- [ ] 升级：版本不一致时安装新 helper、切换服务路径、停止旧服务、清理旧目录。
- [ ] 状态读取：`Get-Service`/`sc query` 非管理员可用；能力检测用文件/服务存在性，不强制 `Get-WindowsCapability`。
- [ ] 单元测试：协议、SCM 状态映射、错误码映射（fixture/假 API）。
- [ ] 手工 E2E：Win11 Pro、Win11 Home（若 Gate G2 通过）、开启/关闭、UAC、app 退出、崩溃、重启、卸载。

**Acceptance:** Windows 上可完成一次真实 SSH 登录；`app` 生命周期退出后服务停止；`persistent` 重启后仍可连；自定义端口生效且占用时被拦截；卸载后服务与状态清理干净。

---

### Task 6 设置界面与前端适配

**Files:** `src/SettingsApp.vue`、`src/core/settings/types.ts`、`src/core/settings/session.ts`、`src/platform/native.ts`、`src/core/i18n.ts`、`tests/core/ssh-settings.test.ts`

- [ ] 新增“远程访问”设置分组（建议放在“分享”和“关于”之间）。
- [ ] 主开关：`role="switch"`；首次开启弹二次确认，说明使用 OS 账户、局域网暴露、睡眠/FileVault 限制。
- [ ] 生命周期二段选择：`仅应用运行时` / `后台常驻`；`app` 需要 helper，未安装时置灰并给出安装入口。
- [ ] 端口输入：Windows 可编辑（1–65535，默认 22）；macOS 只读显示 22；非法值不提交。
- [ ] 端口占用提示：开启/修改端口时显示“端口被 <进程> (PID) 占用”，阻止应用并允许重试；不使用模态阻塞整个设置窗口。
- [ ] 已开启时改端口：二次确认会断开现有 SSH 会话；失败时恢复旧端口并展示错误。
- [ ] 状态卡：已开启/系统已开启/需要管理员/受策略管理/helper 未安装/监听中/错误码。
- [ ] 非管理员账户：禁用开关并说明“SSH 需要管理员账户”，不弹无意义的 UAC/授权。
- [ ] 展示 `ssh user@ip`、端口、host key 指纹；提供复制命令。
- [ ] macOS 提供“打开 Sharing 设置”；Windows 提供“打开服务/可选功能”说明。
- [ ] helper 安装/卸载入口：安装时解释 UAC/管理员授权；卸载时说明会关闭 SSH（若 owned）。
- [ ] Windows 缺少 sshd 时的两手准备：
  - “官网下载”：打开 `https://github.com/PowerShell/Win32-OpenSSH/releases`，用户手动装完点“重新检测”；URL 固定在后端，前端不能传任意 URL；同时给出 Windows 设置 → 可选功能的微软官方步骤；
  - “内置安装（随包）”：UI 可叫“内置下载”，实际是运行随包 MSI；展示随包版本，调用 helper 校验并运行 MSI；显示安装中/失败/需要重启；
  - 两者都失败时保留错误详情，不循环重试。
- [ ] 适配器方法：`sshStatus`、`sshEnable`、`sshDisable`、`sshSetLifetime`、`sshSetPort`、`sshInstallHelper`、`sshUninstallHelper`、`sshInstallBundledOpenSsh`、`sshOpenOpenSshDownload`、`sshRecheckOpenSsh`。
- [ ] 事件同步：`ssh-status` 推送到设置窗口与主窗口；窗口聚焦时刷新。
- [ ] 错误码到中英文文案的映射；不显示内部路径/命令输出。
- [ ] 测试：关闭默认、首次确认、取消不产生特权操作、lifetime 切换、helper 缺失、错误态、键盘/aria。
- [ ] 现有分享/压缩设置回归：新增字段不影响 `settings_update`。

**Acceptance:** 设置界面可完成 enable/disable/切换生命周期/设置端口；端口占用有明确提示；所有状态有明确文案；Vitest 与类型检查通过。

---

### Task 7 生命周期与异常路径（跨平台）

**Files:** `src-tauri/src/ssh/mod.rs`、平台 helper、`tests/core/ssh-settings.test.ts`、`docs/ssh/helper-protocol.md`

- [ ] 多实例：helper 引用计数；最后一个客户端退出才按 `app` 关闭。
- [ ] 正常退出：主窗口关闭 → detach → helper 宽限后关闭；不阻塞窗口退出。
- [ ] 崩溃/强杀：helper 心跳超时后关闭（仅 owned + app）。
- [ ] 手动覆盖：用户从 System Settings/服务管理器开启或关闭后，app 重新对齐，不抢控制权。
- [ ] 持久模式：helper 不主动覆盖用户手动关闭；app 启动时只报告状态。
- [ ] 睡眠/唤醒、网络切换后刷新 address；不尝试唤醒主机。
- [ ] 已开启时改端口：Windows 重配并重启服务，确认新端口监听、旧端口释放；失败回滚；macOS 拒绝非 22。
- [ ] Windows 网络配置切换（Private/Public/Domain）后重新校验防火墙规则；规则被禁用时报告 `firewall_blocked`。
- [ ] 目标端口被其他进程占用：enable/set_port 失败，返回 `port_in_use`，不误判为 SSH 开启。
- [ ] helper 版本不匹配/未批准/被策略禁用：降级为只读状态，不循环重试。
- [ ] 卸载：停止服务、注销 LaunchDaemon、删除状态/日志；owned 时先关闭 SSH。
- [ ] 平台 E2E 记录：normal / crash / reboot / manual override / uninstall 五种场景。

**Acceptance:** 两种生命周期的行为与文档一致；异常路径不留下“以为关了但其实还开着”的状态。

---

### Task 8 打包、签名、升级、卸载

**Files:** `.github/workflows/release.yml`、`scripts/build-macos-pkg.mjs`、`src-tauri/tauri.conf.json`、`scripts/collect-installers.mjs`

- [ ] macOS：构建 universal helper（arm64 + x86_64），`lipo` 合并；放入 `Contents/Resources`。
- [ ] macOS：plist 放入 `Contents/Library/LaunchDaemons`；确认 Tauri bundler 不会丢掉该目录，必要时在打包脚本中补。
- [ ] macOS：按“helper → framework → app”顺序签名；hardened runtime；公证与 staple；`codesign --verify --deep --strict`、`spctl -a -vv`、`stapler validate`。
- [ ] macOS：CI 增加 Developer ID 证书与公证密钥；当前未签名构建不得作为 SSH 功能的发布候选。
- [ ] macOS：检测 app 是否从 DMG/非 `/Applications` 运行；需要时引导移动，避免 SMAppService 注册失败。
- [ ] macOS：处理 app 被移动/删除后的 LaunchDaemon 残留：启动时检测并重新注册；helper 在 app bundle 不存在时退出，避免 KeepAlive crash loop；文档给出登录项清理步骤。
- [ ] Windows：签名 app 与 helper（Authenticode + 时间戳）；配置 Tauri Windows 签名。
- [ ] Windows：随包固定版 `OpenSSH-Win64-v<version>.msi` + SHA256 manifest + OpenSSH LICENCE；构建时校验哈希（若有签名一并校验），失败则阻断发布；体积增加约 7 MB。
- [ ] Windows：随包 MSI 只在用户点击“内置安装”时运行；不静默安装；卸载 app 不自动删除系统级 OpenSSH。
- [ ] Windows：helper 放入安装包/ProgramData；首次提权安装；升级时替换服务二进制。
- [ ] Windows：NSIS/MSI 卸载路径停止并删除服务；恢复 `sshd_config` 备份；删除 `shrinkdrop-ssh-<port>` 防火墙规则；保留/清理状态按产品决定。
- [ ] 版本握手：app/helper 版本不一致时给“更新辅助服务”入口，不静默失败。
- [ ] 体积与启动开销：记录 helper 大小、服务常驻内存、开启耗时。

**Acceptance:** 签名安装包在干净 macOS/Windows 上可完成首次开启；升级后 helper 仍可用；卸载后无残留服务/LaunchDaemon。

---

### Task 9 E2E 与安全评审

**Files:** `docs/ssh/verification.md`（新建）、`docs/ssh/helper-protocol.md`

- [ ] macOS 13/14/15/26，Intel + Apple Silicon：clean install、enable、SSH 登录、disable、app quit、crash、reboot、manual override、uninstall。
- [ ] Windows 10/11 Home/Pro：clean install、FoD 安装、enable、SSH 登录、disable、app quit、crash、reboot、uninstall。
- [ ] Windows 自定义端口：22 → 2222 生效，22 不再监听，防火墙同步，重启保持；改回 22 正常。
- [ ] Windows 安装来源：FoD 成功；FoD 离线/WSUS 失败出现两个兜底；官网链接可打开；随包 MSI 安装成功。
- [ ] 随包 MSI：哈希/签名不匹配拒绝；已有 `sshd` 服务时禁止重复安装；3010/1603/1618 错误文案正确；卸载 app 不误删系统 OpenSSH。
- [ ] 端口占用：被其它进程占用时阻止并显示进程；被本机 sshd 占用按幂等；非法端口/权限错误有明确文案。
- [ ] 配置回滚：`sshd -t` 失败、服务启动失败、防火墙创建失败时恢复原配置并返回错误。
- [ ] macOS 非 22 端口：返回 `unsupported_custom_port`，不改系统文件。
- [ ] 管理员与非管理员账户；UAC 取消；helper 批准/拒绝；MDM/GPO 禁用。
- [ ] 防火墙开启/关闭；目标端口被占用；自定义端口下的防火墙规则；离线/WSUS 环境。
- [ ] 安全评审：
  - [ ] IPC 仅本机、认证有效、无任意命令。
  - [ ] 状态文件/日志权限正确，无凭据泄漏。
  - [ ] helper 二进制路径不可被普通用户替换；服务/LaunchDaemon 配置不可篡改。
  - [ ] 关闭/卸载不会误关用户手动开启的 SSH。
  - [ ] 失败路径不扩大权限、不循环重试。
- [ ] 回归：压缩、分享、防休眠、设置窗口、应用退出不受影响。
- [ ] 记录已知限制（睡眠、FileVault、Home、策略）。

**Acceptance:** 验收矩阵有结果；无 P0/P1 安全问题；已知限制写入用户文档。

---

### Task 10 文档与发布

**Files:** `README.md`、`docs/ssh/research.md`、`docs/ssh/plan.md`、`docs/privacy.md`、`docs/release-checklist.md`

- [ ] 用户文档：如何开启、两种生命周期、端口设置（Windows 自定义 / macOS 固定 22）、如何连接、如何关闭、如何卸载 helper。
- [ ] 故障排查：连不上、端口占用、端口改后未放行防火墙、睡眠、FileVault、非管理员、策略禁用、helper 未批准。
- [ ] Windows 安装兜底说明：FoD 失败时“官网下载”链接、随包 MSI 版本/哈希、内置安装步骤、UAC/重启提示、卸载 app 不自动删除 OpenSSH。
- [ ] 隐私说明：SSH 使用 OS 账户；应用不收集凭据；日志只在本地。
- [ ] 安全说明：建议仅可信局域网、优先公钥、host key 指纹核对。
- [ ] README 功能与平台支持矩阵；更新 release checklist。
- [ ] 发布说明与版本号；首次发布标注 helper 安装/授权步骤。
- [ ] 若功能受 Gate 影响未全平台开放，明确写“macOS 13+ / Windows 10 1809+”。

**Acceptance:** 文档与实际行为一致；新用户按文档可完成一次真实连接；卸载步骤可复现。

## 3. 测试策略

- **纯逻辑单测**：状态机、所有权、引用计数、协议序列化、错误映射、设置迁移。
- **假后端**：`SshBackend` 的内存实现覆盖所有状态转移，不触碰特权 API。
- **协议测试**：内存 duplex / 临时 socket，覆盖超时、半包、超大帧、非法动词、版本不匹配。
- **平台集成**：macOS 手动 LaunchDaemon（开发模式）与 SMAppService（签名后）；Windows 服务与命名管道。
- **E2E**：真实 SSH 客户端登录，验证 22 监听、退出关闭、重启保持、手动覆盖。
- **CI**：只跑纯逻辑与构建；不在 CI 执行 `launchctl`、`sc`、UAC、服务安装。
- **回归**：现有 `cargo test`、`pnpm test`、`vue-tsc`、打包脚本。

## 4. 风险与回退

| 风险 | 影响 | 回退/缓解 |
|---|---|---|
| macOS `launchctl` 路径在某个版本失效 | 无法自动开关 | Task 0 Gate；回退 `systemsetup` + FDA 引导，或暂时只做手动开启引导 |
| SMAppService 需要签名，当前包未签名 | helper 无法交付 | Task 8 先完成签名；未签名构建隐藏该功能 |
| Windows Home 不支持可选功能 | 部分用户不可用 | Gate G2；按 SKU 隐藏并提示 |
| 企业 GPO/MDM 禁用 | 功能不可用 | 明确错误态；不反复重试 |
| helper 被 AV/SmartScreen 拦截 | 安装失败 | Authenticode 签名；安装说明；错误码可诊断 |
| helper 升级时文件锁 | 更新后 helper 不可用 | 版本化目录 + 服务路径切换；先停旧服务 |
| 用户手动开启 SSH 被误关 | 破坏用户环境 | ownership + refcount；只关自己开启的实例 |
| 关闭 SSH 断开用户会话 | 数据/任务中断 | 二次确认；错误文案；不静默关闭 |
| 睡眠/FileVault 导致不可达 | 用户以为功能坏了 | 文档与 UI 提示；不承诺“随时可连” |
| 目标端口被占用 | 开启失败 | `port_in_use`；提示检查现有 sshd/进程 |

## 5. Definition of Done

- [ ] 设置中可开启/关闭，并能在两种生命周期之间切换。
- [ ] Windows 可自定义端口；开启/改端口前检测占用，被占用时明确提示并阻止；macOS 非 22 明确不支持。
- [ ] Windows FoD 失败时，“官网下载”和“内置安装（随包 MSI）”可用；随包版本有哈希/签名校验；不静默安装。
- [ ] 端口变更失败时配置/防火墙回滚，旧端口状态可恢复。
- [ ] `app` 生命周期：正常退出与崩溃后，owned 的 SSH 在宽限期内关闭。
- [ ] `persistent` 生命周期：app 退出后仍可连，重启后仍可连。
- [ ] 用户手动开启的 SSH 不会被 app 误关。
- [ ] helper 仅本机 IPC、固定动词、有认证、无任意命令执行。
- [ ] macOS helper 走 SMAppService，签名/公证通过；Windows helper 走签名服务，安装/卸载干净。
- [ ] 真实 SSH 登录验证通过；错误路径有可操作文案。
- [ ] 现有压缩、分享、防休眠、设置与退出流程回归通过。
- [ ] 文档、隐私说明、故障排查与发布检查表更新。