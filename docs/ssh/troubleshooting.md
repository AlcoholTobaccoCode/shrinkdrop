# SSH 远程访问故障排查

日期：2026-11-04
适用：设置 → 远程访问（Windows 全功能；macOS 13+ 只读）

## 连不上

按顺序排除，每一步都有可观察结果：

1. **状态卡是否是「已开启（由 shrinkdrop 管理）」或「系统已启用」**。
   `无法确认` 表示端口被别的进程占用或没有权限，此时不要假设 SSH 开着。
2. **端口是否在监听**：Windows 上 `netstat -ano | findstr :22`（自定义端口换成对应端口），
   看到 `LISTENING` 且 PID 属于 `sshd.exe`。
3. **防火墙**：Windows 上 `netsh advfirewall firewall show rule name=OpenSSH-Server-In-TCP`
   与 `name=shrinkdrop-ssh-<port>`。规则存在但 `Enabled: No` 时，功能会被判定为
   `firewall_blocked`。
4. **同一局域网**：连接命令里的地址来自本机网卡；手机要连同一个 Wi-Fi，公司网络常开客户端隔离。
5. **机器是否睡眠 / FileVault 是否已解锁**：睡眠或未解锁时 SSH 不可达，这是系统行为。
   macOS 可在 设置 → 锁定屏幕 里调整；Windows 检查电源计划。

## 开启失败

| 错误码 | 含义与处理 |
|---|---|
| `port_in_use` | 端口被其它进程占用。面板会显示进程名与 PID；换端口或先结束该进程。 |
| `feature_missing` | 系统没有 OpenSSH Server。Windows：设置 → 可选功能里安装，或用面板的「官网下载 / 内置安装」。 |
| `service_missing` | 系统里没有 `sshd` 服务。同上。 |
| `service_start_failed` | 服务起不来。常见原因：`sshd_config` 被别的工具改坏（helper 已在改前备份、失败回滚）、端口刚被抢占。 |
| `firewall_blocked` | 防火墙规则缺失或被禁用。改端口后没放行也会出现。 |
| `needs_admin` | 当前账户不是管理员，或 UAC 被取消。 |
| `policy_blocked` | 组策略 / MDM 禁止。需要管理员在域策略里放开。 |
| `helper_unavailable` | 辅助服务未安装或没在运行。Windows：在面板点「安装辅助服务」并允许 UAC。 |
| `helper_version_mismatch` | 辅助服务与 app 版本不一致。重装一次辅助服务。 |
| `busy` | 上一个操作还没结束；等几秒重试。 |
| `read_only` | macOS 未签名构建：只能读状态，请在 系统设置 → 通用 → 共享 → 远程登录 里操作。 |

## 辅助服务

- Windows 首次安装会弹 UAC，显示“未知发布者”是因为当前版本未签名；确认后服务以
  LocalSystem 运行，只监听本机命名管道 `\\.\pipe\shrinkdrop-ssh-helper`。
- 服务已装但面板显示未安装：服务可能被停掉了。`sc query ShrinkdropSshHelper` 看状态，
  `sc start ShrinkdropSshHelper` 启动，或在面板里卸载后重装。
- 卸载辅助服务会：关闭由 shrinkdrop 开启的 SSH、还原 `sshd_config` 与启动类型、
  删除 `shrinkdrop-ssh-<port>` 防火墙规则。**不会**删除系统 OpenSSH，也不会动你自己开启的实例。
- macOS 未签名构建不安装任何 helper，卸载应用不会留下守护进程。

## 改端口

- 只影响 Windows；macOS 的 stock Remote Login 固定 22。
- 改端口会重启 `sshd`，现有 SSH 会话断开。
- 失败会自动回滚到旧端口：新端口没监听，或旧端口没释放，都算失败。
- 改完记得确认防火墙里有 `shrinkdrop-ssh-<newport>`，旧规则已被删除。

## 崩溃与退出

- `仅应用运行时`：应用退出或被强杀后，辅助服务在连接断开时立即关闭自己开启的 SSH。
- `后台常驻`：应用退出后仍可连；重启机器后 `sshd` 也会自动启动（服务启动类型为自动）。
- 两种模式都不会关闭你自己在系统里开的实例。

## 还是不行

收集这些信息再反馈：面板上的状态文案与错误码、`port`、`os_state`、
`sc query sshd` / `sc query ShrinkdropSshHelper` 的输出（Windows），
以及 `launchctl print system/com.openssh.sshd | head -20` 的输出（macOS）。
不要贴出私钥、密码或 `authorized_keys` 内容。
