# 宿主机 SSH 开关调研（macOS / Windows）

日期：2026-11-04
状态：调研完成；已选定方案 A（系统 sshd + 特权 helper），开发计划见 `docs/ssh/plan.md`
范围：在设置中启用/停用宿主机的系统 OpenSSH Server（sshd），并选择生命周期；不包含自研 SSH/SFTP 服务、反向隧道、公网穿透。

## 结论

| 问题 | 结论 |
|---|---|
| 协议层是否支持 | 支持。macOS 自带 OpenSSH Server；Windows 10 1809+/11 以可选功能提供 OpenSSH Server；两边都是 SSH-2，带 SFTP 子系统。 |
| 策略层是否支持 | 有条件支持。启用/停用都需要管理员权限；macOS 官方 `systemsetup` 还要求 Full Disk Access，不能直接给普通 app 用；Windows 需要装可选功能、起服务、过防火墙。 |
| “后台常驻” | 系统原生支持，不需要自写 daemon。macOS 保持 Remote Login 开启后由 launchd 按连接拉起 sshd；Windows 把 `sshd` 服务设为 Automatic 即可。 |
| 自定义端口 | Windows 支持：改 `sshd_config` 的 `Port`、重启服务、同步防火墙。macOS v1 不支持：stock Remote Login 的监听端口由 launchd 的 `SockServiceName=ssh` 决定，改端口需要自建 LaunchDaemon，已超出“系统 Remote Login”模型。 |
| Windows 安装来源 | 优先系统可选功能（FoD）；失败时提供“官网下载”和“内置安装（随包固定版 MSI）”；不静默安装随包版本。 |
| “app 运行时” | 要“app 退出后无提示关闭”，必须有常驻特权 helper（macOS LaunchDaemon / Windows LocalSystem service）。没有 helper 也能做，但退出时要再弹一次管理员授权，体验不可接受。 |
| 最大阻塞 | 当前安装包未签名、未公证（README 已注明）。macOS 的 SMAppService helper 需要 Developer ID 签名与 Team ID 关联；Windows 服务虽可未签名安装，但 SmartScreen/AV/企业策略会拦。 |
| 能否上 Mac App Store | 不行。沙箱 app 不能安装 LaunchDaemon，也不能修改 Remote Login；只能 Developer ID 直发。 |
| 能否复用现有 PIN/账号 | 不能。系统 sshd 使用 OS 账户 + 密码/公钥；分享功能的 PIN/账号体系只属于 axum 分享服务。要 app 管理凭据只能自研 SSH 服务，成本高且不再是“宿主机 ssh”。 |
| 建议 | 不托管自己的 sshd；helper 只做控制面。先做“后台常驻”验证，再做 helper 支持“app 运行时”。 |

证据标记：`[实测]` 本机 macOS 26.2；`[官方]` Apple/微软 文档；`[社区]` 第三方实践或发行版实现；`[推断]` 工程判断，需 PoC 确认。

## 与现有架构的关系

- Tauri 2.11 + Rust + Vue，分享服务是进程内 axum，关窗即停；没有常驻托盘、没有独立守护进程。见 `docs/share/design.md`。
- 设置持久化在 `settings.json`，窗口关闭时统一停分享、释放防休眠。见 `src-tauri/src/lib.rs` 的 `CloseRequested`。
- 启动时已有 `SleepInhibitor.reconcile(...)` 的先例，SSH 也可以按“启动对齐系统状态、退出按生命周期收尾”的方式接入。
- 安装包为 macOS 通用（Intel/Apple Silicon）DMG/PKG、Windows NSIS/MSI，当前未签名；README 明确写明“暂未配置开发者签名及 macOS 公证”。

## sshd 从哪里来、谁启动

| | macOS | Windows |
|---|---|---|
| sshd 来源 | 系统内置 `/usr/sbin/sshd` | Windows 可选功能 `OpenSSH.Server` |
| 是否由 app 下载 | 否，系统自带 | 首选 FoD；失败时可运行随包固定版 MSI，或跳官网手动下载 |
| 谁启动 | launchd job `com.openssh.sshd`，按连接拉起 | SCM 服务 `sshd`，常驻 |
| 运行身份 | root | 系统服务账户（通常 LocalSystem） |
| 配置文件 | `/etc/ssh/sshd_config` + `sshd_config.d/` | `%ProgramData%\ssh\sshd_config` |
| 认证 | macOS 本地账户 / PAM | Windows 本地账户 / 密码或公钥 |

- **不用用户自己装的 sshd**（例如 Homebrew 的 OpenSSH），也不走用户 PATH；固定使用系统路径/系统服务。
- **不是 app 私有 sshd**：host key、账户、PAM/服务权限都在系统层；app 只做开关、生命周期、端口和状态展示。Windows 的随包 MSI 只是安装介质，装完仍是系统级 `sshd` 服务。
- macOS 端口 22 的 listener 由 launchd 持有；Windows 的 `sshd` 由服务管理器持有。helper 只控制它们，不托管 sshd 进程。
- 如果用户机器上已有别的 sshd 占用目标端口，按 `port_in_use` 处理；不接管、不杀进程。

## macOS

### 机制

| 项 | 事实 | 证据 |
|---|---|---|
| 服务 | 系统自带 OpenSSH 10.0p2，`/usr/sbin/sshd` | `[实测] ssh -V` |
| launchd job | `/System/Library/LaunchDaemons/ssh.plist`，label `com.openssh.sshd` | `[实测] plutil -p` |
| 默认状态 | plist 内 `Disabled => true`，未加载时 22 端口不监听 | `[实测]` |
| 启动方式 | socket activation：`Sockets.Listeners.SockServiceName = ssh`，`inetdCompatibility.Wait = false`；没有连接时常驻 sshd 进程不存在 | `[实测] plist` |
| 入口程序 | `/usr/libexec/sshd-keygen-wrapper`，首次启动生成 host key 并拉起 sshd | `[实测] plist` |
| 官方开关 | `systemsetup -setremotelogin on/off`，需要 root；Catalina 起还要求父进程有 Full Disk Access | `[官方] Apple 101653；man systemsetup` |
| 非官方但可用 | `launchctl enable system/com.openssh.sshd` + `launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist`；关闭为 `bootout` + `disable` | `[社区] nix-darwin 26.05` |
| 权限控制 | `/etc/pam.d/sshd` 使用 `pam_sacl.so sacl_service=ssh`，由 `com.apple.access_ssh` 组控制 | `[实测]` |
| 防火墙 | 本机应用防火墙已允许 `/usr/libexec/sshd-keygen-wrapper` 入站；不同机器/受管设备仍需检测 | `[实测] socketfilterfw --listapps` |
| 状态查询 | `launchctl print system/com.openssh.sshd` 判断是否加载；`launchctl print-disabled system` 可读；`systemsetup -getremotelogin` 需要管理员 | `[实测]` |

本机验证到的默认值：`com.apple.access_ssh` 存在，`NestedGroups` 指向 `admin`；这是当前机器的状态，不应假设所有机器一致。

### 关键约束

1. **`systemsetup` 不能作为普通 app 的自动化接口。**
   - `sudo` 只解决 root，不解决 TCC；Apple 文档明确要求调用方或其父进程有 Full Disk Access。
   - 让用户把 app 加入“完全磁盘访问权限”可以作为兜底，但这是很重的授权，且 helper 场景下 TCC 归属不直观。

2. **`launchctl` 路径只要求 root，不要求 Full Disk Access。**
   - nix-darwin 明确因为 FDA 问题改走 `launchctl`，说明这是当前 macOS 上可用的工程路径。
   - 但它是系统内部机制，不是 Apple 公开 API；必须在目标 macOS 版本（至少 14/15/26）做回归。
   - 需验证：System Settings 的 Remote Login 开关是否同步、`Allow access for` 是否保持、应用防火墙是否放行、重启后是否保持、已建立会话在关闭时是否被中断。

3. **“后台常驻”不需要自写 daemon。**
   - Remote Login 保持开启后，launchd 在 22 端口有连接时拉起 sshd；不需要我们的进程常驻。
   - 但宿主机睡眠时不可达；macOS 不会因为 SSH 开着就阻止睡眠。

4. **FileVault 会影响重启后的可达性。**
   - 重启后磁盘在本地解锁前处于锁定状态，`authorized_keys` 与用户目录不可用，SSH 实际不可登录。
   - “后台常驻”只保证服务配置常驻，不保证重启后立刻可远程登录。

5. **helper 的签名要求。**
   - macOS 13+ 用 `SMAppService.daemon(plistName:)`，plist 必须放在 app 的 `Contents/Library/LaunchDaemons`，可执行文件用 `BundleProgram` 指向 bundle 内相对路径。
   - 注册 LaunchDaemon 需要用户认证，并在“登录项”里批准；helper 与主 app 必须同 Team ID 签名。
   - 当前未签名包无法作为可交付的 helper 路径；需要 Developer ID 证书 + 公证。
   - macOS 12 及以下需要 SMJobBless 或旧式 LaunchDaemon 安装脚本；是否支持取决于 app 的最低系统版本，建议把该功能限定在 13+。

6. **不要自托管 sshd。**
   - sshd 需要 root 做账户认证、PAM、setuid、host key 管理；从 app 里起子进程会与系统 job 冲突，也绕不开权限。
   - 正确做法是让 launchd 管 sshd，我们只控制 `com.openssh.sshd` 的 enable/disable。

### 自定义端口（macOS）

- stock job 是 socket activation：监听端口来自 `/System/Library/LaunchDaemons/ssh.plist` 的 `Sockets.Listeners.SockServiceName = ssh`，sshd 由 launchd 以 inetd 方式拉起。`sshd_config` 里的 `Port` 是否还能改变实际 listener，需要在 T0 实测确认；按机制推断不能。`[推断]`
- 要真正改端口，必须新增/替换一个 LaunchDaemon：用自定义 `Sockets` 端口，或直接运行 `/usr/sbin/sshd -D -p <port>`；同时停用 stock `com.openssh.sshd`。
- 这条路的代价：
  - System Settings 的 Remote Login 开关不再反映真实状态；
  - host key、PAM/ACL、防火墙、开机启动、卸载都要自己维护；
  - 与系统 job 的 label/端口冲突需要处理。
- **v1 决策：macOS 只支持 22。** UI 在 macOS 上隐藏端口输入或置灰；如果产品必须支持 macOS 自定义端口，单独立项做 `com.shrinkdrop.sshd`，不要和 stock Remote Login 混用。
- TCP proxy（自定义端口 → 22）只是转发，仍依赖 22，且多一个常驻进程，不推荐。

### macOS 控制面建议

- 常驻 helper：LaunchDaemon，root 运行，通过 Unix domain socket 或 XPC 接收固定动词（status/enable/disable/set-lifetime），不提供任意命令执行。
- helper 负责：
  - `launchctl enable` + `bootstrap` / `bootout` + `disable`；
  - 记录 desired state、ownership、lifetime；
  - 监听 app 连接/心跳，lifetime=app 时在 app 退出或超时后关闭；
  - 开机 reconcile；
  - 写系统日志与自有日志，便于排查。
- 无 helper 的降级：
  - 只支持“后台常驻”；开启时弹一次管理员授权（`osascript ... with administrator privileges` 或原生 Authorization）；
  - 关闭时再弹一次授权；不能做“退出自动关闭”。

## Windows

### 机制

| 项 | 事实 | 证据 |
|---|---|---|
| 服务来源 | OpenSSH Server 是 Windows 可选功能（Feature on Demand） | `[官方]` |
| 版本要求 | Windows 10 build 1809+、Windows 11、Windows Server 2019+ | `[官方]` |
| 安装 | `Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`（管理员） | `[官方]` |
| 服务 | `sshd`（OpenSSH SSH Server），另有 `ssh-agent` | `[官方]` |
| 配置 | `%ProgramData%\ssh\sshd_config`，缺失时首次启动生成 | `[官方]` |
| host key | 默认在 `%ProgramData%\ssh`，首次服务启动自动生成 | `[官方]` |
| 防火墙 | 安装时创建并启用 `OpenSSH-Server-In-TCP`（入站 22） | `[官方]` |
| 端口 | 默认 22；`%ProgramData%\ssh\sshd_config` 的 `Port` 可改，重启服务后生效；防火墙需同步 | `[官方]` |
| 启动类型 | 官方把 `Set-Service -Name sshd -StartupType Automatic` 列为“可选但推荐”，说明默认不是自动；后台常驻必须显式设置 | `[官方]` |
| 认证 | 仅密码与 `publickey`；不支持 微软 Entra 账户 | `[官方]` |
| 管理员公钥 | 管理员组使用 `%ProgramData%\ssh\administrators_authorized_keys`，ACL 只允许 SYSTEM/Administrators | `[官方]` |
| 家庭版 | 官方支持矩阵按 build 限定，未按 SKU 排除；Home 是否可选功能完整可用需实机确认 | `[官方]/[待验证]` |

### 关键约束

1. **所有写操作都需要管理员。**
   - 安装可选功能、`Start-Service`、`Stop-Service`、`Set-Service`、改防火墙、改 `sshd_config` 都需要提权。
   - 普通 app 只能查询 `Get-Service sshd` / `sc query sshd`，不能起停。

2. **“后台常驻”是原生能力。**
   - 安装后设置 `StartupType Automatic` 并启动；重启由 SCM 拉起，不需要自写服务。
   - 仍需确保防火墙规则存在且启用；企业 GPO 可能让本地规则失效。

3. **“app 运行时”需要额外控制面。**
   - 退出时 `Stop-Service sshd` 需要管理员；直接弹 UAC 不可接受。
   - 可选方案：
     - 自建 LocalSystem Windows 服务作为 helper，命名管道通信，SCM 控制 `sshd`；推荐。
     - 用 `sc sdset` 给当前用户授予 `sshd` 的 `SERVICE_START/SERVICE_STOP` 权限；只需一次提权，不改服务实现，但修改系统服务 DACL 属于侵入式操作，且用户仍不能改启动类型。
     - 每次提示 UAC；只适合验证，不适合产品。

4. **安装可选功能可能失败。**
   - FoD 由 Windows Update 提供；离线、WSUS 拦截、精简系统、策略禁用可选功能都会失败。
   - 需要给用户可操作的错误文案，并允许“已手动安装”的情况。

5. **Home 版要实测。**
   - 官方文档只写 build，不写 SKU；不能仅凭文档保证 Home 一定可用。
   - 发布前至少在 Windows 11 Home 上跑一遍安装、启动、防火墙、重启。

6. **认证与权限差异。**
   - Windows OpenSSH 只支持密码/公钥；Windows Hello、PIN、Entra 登录不能直接用于 SSH。
   - 管理员组通过 SSH 登录会得到提升后的会话（第三方资料）；这既是便利也是风险。
   - 默认通常允许所有可登录的本机账户连入；需要用 `AllowGroups`/`DenyGroups` 或防火墙收窄。

7. **企业策略。**
   - 域环境可能通过 GPO 关闭可选功能、覆盖防火墙规则（本地规则不生效）、用 AppLocker/WDAC 拦 helper。
   - SmartScreen 对未签名 helper 不友好；Authenticode 签名不是功能必需，但发布必需。

### 自定义端口（Windows）

- 支持。改 `%ProgramData%\ssh\sshd_config` 的 `Port`，`Restart-Service sshd` 后生效；防火墙规则要对应新端口。
- 注意 OpenSSH 的 `Port` 可以出现多次，多个 `Port` 会同时监听。要“换端口”而不是“加端口”，必须解析并禁用其它 active `Port` 行。
- 建议 helper 用带标记的托管块（例如 `# shrinkdrop begin/end`），改前备份原文件，改后 `sshd -t` 校验；失败时回滚原配置。
- 开启前检查端口占用：
  - 被其它进程占用 → 返回 `port_in_use`，带端口/PID/进程名，不写配置、不启动服务；
  - 被本机 `sshd` 占用且就是目标端口 → 视为幂等，不重复启动。
- 防火墙：自定义端口用独立规则（如 `shrinkdrop-ssh-<port>`），不要改 stock `OpenSSH-Server-In-TCP`；关闭/卸载时删除自己创建的规则。
- 端口范围 1–65535；<1024 在 Windows 上由 LocalSystem 绑定没有额外门槛，但仍提示可能与其他系统服务冲突。
- 端口变更时现有 SSH 会话会断开；UI 需要确认与提示。

### 安装来源与两手准备（Windows）

优先顺序：

1. **已有 sshd**：检测 `sshd` 服务或 `%SystemRoot%\System32\OpenSSH\sshd.exe` / `%ProgramFiles%\OpenSSH\sshd.exe`；已存在就直接使用，不重复安装。
2. **系统可选功能（首选）**：`Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`，由 Windows Update/FoD 提供，随系统更新，最省心。
3. **官网下载（手动）**：FoD 失败/离线/被策略拦截时，打开官方发布页：
   `https://github.com/PowerShell/Win32-OpenSSH/releases`
   用户自行下载 `OpenSSH-Win64-v<version>.msi` 并安装；app 只负责打开页面和“重新检测”，不自动执行下载的文件。
   也可以引导用户走 Windows 设置 → 可选功能 → OpenSSH Server（微软 Learn 的安装步骤），效果等同 FoD。
4. **内置安装（随包）**：app 内固定一个经过验证的 `OpenSSH-Win64-v<version>.msi`，随安装包分发；用户点击“内置下载/内置安装”后，由 helper 校验并唤起 MSI。

内置 MSI 的要求：

- 固定版本 + 固定 SHA256，写入随包 manifest；升级 app 时才更新，不自动追最新。
- 执行前校验 SHA256；若 MSI 带 Authenticode 签名，再校验签名；不匹配直接拒绝，不运行。
- 通过 `msiexec /i "<msi>" /qn /norestart` 安装（helper 是 SYSTEM，session 0 不显示 MSI UI；进度由 app 展示）。
- 记录 `installedByApp=true`；如果系统里已有 `sshd` 服务，禁止再装，避免 FoD 与 standalone 两套 OpenSSH 冲突。
- 随包附 OpenSSH 的 BSD 许可证文本；MSI 约 6.9 MB，App 体积会增加。
- 卸载 app 时**不自动删除系统级 OpenSSH**；只有明确提示“这是随包安装的 OpenSSH”且用户确认后才卸载，避免影响其他工具。
- Win32-OpenSSH 的 release 目前多标注 preview；必须选一个验证过的版本并跟 app 版本一起更新，不能把它当“永远最新”的组件。

> UI 文案可以叫“内置下载”，实际动作是“运行随包 MSI 安装”，不是再下载一次。

### Windows 控制面建议

- helper Windows 服务，`LocalSystem`，安装时一次 UAC；命名管道只允许当前 console 用户 SID、Administrators 与 SYSTEM 访问。
- 固定动词：`status`、`enable(lifetime, port)`、`disable`、`set_lifetime`、`set_port`。
- 服务内部：
  - `OpenSCManager` / `OpenService("sshd")`；
  - `StartService` / `ControlService(SERVICE_CONTROL_STOP)`；
  - `ChangeServiceConfig(SERVICE_AUTO_START|SERVICE_DEMAND_START)`；
  - 必要时用 DISM API 或 `Add-WindowsCapability` 安装 FoD；
  - 校验/创建防火墙规则。
- app 退出/心跳丢失时，lifetime=app 则停 `sshd`；lifetime=persistent 则保持。
- 安装方式：MSI/NSIS 自定义动作，或首次开启时用 `ShellExecuteW(..., "runas", ...)` 安装 helper；后者更符合当前“轻量安装包”的形态。

## 生命周期模型

### 状态机

```text
disabled --enable(admin)--> enabling --ok--> enabled
enabled --disable(admin)--> disabling --ok--> disabled
enabled --app quit, lifetime=app--> disabled（仅当 owned=true）
enabled --reboot, lifetime=persistent--> enabled（OS 负责）
enabled --reboot, lifetime=app--> disabled（helper 负责不启动/关闭）
```

错误态至少包含：`needs_admin`、`feature_missing`、`service_missing`、`firewall_blocked`、`managed_by_policy`、`port_in_use`、`unsupported_custom_port`、`helper_unavailable`、`unknown`。

### 所有权规则

系统 sshd 是全局资源，可能被用户或其他工具开启。必须记录并遵守：

1. 开启前先读系统状态；如果已经是开启状态，设置页显示“系统已启用”，不要把它记成 app 所有。
2. 只有 `owned=true` 且 `lifetime=app` 时，app 退出才自动关闭。
3. 用户从 System Settings / 服务管理器手动开关后，app 在启动或窗口聚焦时重新对齐，不与用户抢控制权。
4. helper 未安装时，“app 运行时”选项禁用，并说明需要安装辅助服务；只提供“后台常驻”。
5. 崩溃/强杀：helper 用心跳超时兜底关闭；没有 helper 时保持开启，下次启动提示“上次异常退出，SSH 仍开启”。
6. 关闭通常会断开已建立的 SSH 会话；UI 要二次确认或明确提示。

### 两种模式的成本

| 模式 | 谁保持服务 | app 正常退出 | 重启后 | 无提示关闭 | helper |
|---|---|---|---|---|---|
| app 运行时 | helper 监控 app | 关闭 sshd | 不启动 | 可以 | 必需 |
| 后台常驻 | launchd / SCM | 不处理 | 自动启动 | 不涉及 | 不需要 |

> 没有 helper 时，“app 运行时”仍可实现，但退出关闭需要再次管理员授权；不建议作为产品形态。

### 睡眠与锁定

- 两种模式都不阻止系统睡眠；睡眠期间 SSH 不可达。现有 `keepAwake` 只在 app 运行时生效，且 app 退出后不会保留。
- macOS FileVault：重启后本地解锁前不可远程登录。
- Windows BitLocker：TPM 自动解锁时通常可在启动后连接；需要预启动 PIN 时不可。
- 这些是产品预期管理问题，不是协议限制。

## 方案对比

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A. 系统 sshd + 特权 helper | helper 只控制 `com.openssh.sshd` / `sshd` 服务 | 协议标准、系统托管、两种生命周期都能做 | helper 安装/签名/IPC/安全面；macOS 需 Developer ID | 推荐 |
| B. 系统 sshd + 每次授权 | 开启/关闭都弹管理员 | 实现最轻，无 helper | 退出无法无提示关闭；只适合常驻 | 可作为 P1 过渡 |
| C. 进程内 SSH 服务（russh 等） | 在 app 内实现 SSH/SFTP，自定义认证 | 不需要管理员，不依赖系统 sshd，可复用 app 账号 | 不是“宿主机 ssh”；要自己实现 SFTP、权限、路径安全；工作量大 | 仅当“不能提权”是硬需求时考虑 |
| D. 自带 sshd 二进制 | bundle OpenSSH，自己起进程 | 可控端口/配置 | 仍需 root/SYSTEM；与系统服务冲突；签名/升级/漏洞责任 | 不推荐 |

## 安全与策略

- 开启 SSH 等于把本机账户的远程登录面暴露到局域网；系统 sshd 不认 app 的 PIN/链接 token，现有分享的访问控制不能复用。
- 默认密码认证是主要风险；建议 UI 默认提示“仅限可信局域网”，并在后续版本提供“仅公钥登录”开关（macOS 写 `/etc/ssh/sshd_config.d/`，Windows 写 `%ProgramData%\ssh\sshd_config`，都要提权并重启服务）。
- 建议默认只允许当前用户/管理员组；macOS 引导到 System Settings 的 “Allow access for”，Windows 用 `AllowGroups` 或防火墙限制。
- 自定义端口不是安全边界，只降低自动化扫描噪音；仍需仅可信局域网、公钥登录、用户/组限制和防火墙。
- 关闭服务会断开现有会话；不要在用户不知情时自动关闭。
- 显示 host key 指纹和 `ssh user@host` 命令，方便用户首次连接时核对。
- 不要在 helper 里暴露“执行任意命令”的接口；只接受固定动词和受控参数。
- macOS 的 `launchctl` 路径不是公开 API；要做好 Apple 改动后的降级（引导用户手动开启 + FDA 兜底）。
- 受 MDM/GPO 管理的设备可能直接禁止；错误文案要区分“权限不足”和“策略禁止”。

## 设置与代码落点（供后续实现）

建议新增顶层设置，而不是塞进 `general` 或 `share`：

```text
SshSettings {
  enabled: boolean,
  lifetime: "app" | "persistent",
  port: number          // 默认 22；Windows 可改，macOS v1 固定 22
}
```

运行态单独返回，不持久化：

```text
SshRuntime {
  supported: boolean,
  helperInstalled: boolean,
  osEnabled: boolean,
  owned: boolean,
  listening: boolean,
  username: string,
  host: string,
  port: number,
  installSource: "fod" | "standalone" | "bundled" | null,
  bundledVersion: string | null,
  fingerprint: string | null,
  error: string | null
}
```

接入点：

- `src-tauri/src/settings.rs`：`Settings` 增加 `ssh`，`SettingsView` 包含 `ssh`；通用 `SettingsUpdate` 不包含 `ssh`，`enabled`/`lifetime`/`port` 走专用命令，默认 `enabled=false`、`lifetime="app"`、`port=22`。
- `src-tauri/src/ssh/mod.rs`：`SshManager`，持有运行态与 helper 连接；启动时 `reconcile`，关窗时 `shutdown`。
- `src-tauri/src/lib.rs`：`.manage(SshManager::default())`，注册 `ssh_status` / `ssh_enable` / `ssh_disable` / `ssh_set_lifetime` / `ssh_set_port`，在 `CloseRequested` 里调用 shutdown；注意与现有 share/power 清理一样避免重复执行。
- `src/SettingsApp.vue`：新增“远程访问”或“SSH”分组；开关 + 生命周期二选一 + 端口 + 状态/命令/指纹 + “打开系统设置”按钮。
- `src/core/settings/types.ts`：同步 `SettingsView`、adapter 方法；`SettingsUpdatePayload` 不含 `ssh`，避免覆盖运行态。
- helper：macOS 放 `Contents/Library/LaunchDaemons` + `Contents/Resources`；Windows 作为服务 exe 放进 resources，由安装器或首次提权安装。

UI 建议：

- 首次开启必须二次确认，说明“将允许局域网内使用本机账户登录”。
- 端口输入：Windows 可编辑；macOS v1 只读显示 22。默认 22，范围 1–65535。
- 开启前检测端口占用：被其它进程占用时显示端口/PID/进程名并阻止开启；被本机 sshd 占用且为目标端口时按幂等处理。
- 端口变更时提示现有 SSH 会话会断开；失败要回滚配置/防火墙并显示原因。
- 生命周期用二段选择，不要藏在下拉里；切换时说明当前是否已生效。
- 状态展示“已开启 / 由系统开启 / 需要管理员 / 受策略管理 / 辅助服务未安装”。
- 提供复制 `ssh user@ip` 命令和指纹；macOS 提供跳转 Sharing 设置的按钮。
- helper 未安装时，“app 运行时”置灰并给出安装入口，不要静默降级。

## 分阶段建议

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 验证 | 不写产品代码，只在测试机跑 macOS `launchctl` 路径与 Windows VM 可选功能路径 | System Settings/服务状态一致；重启保持；关闭断开；防火墙放行；Home 版可用；端口占用检测可用 |
| P1 常驻 | 设置开关 + 生命周期（先只做后台常驻）+ 一次性提权 + 状态展示 | 开启后另一台机器可 SSH；app 退出后仍可连；重启后仍可连；关闭有提示；Windows 自定义端口生效且占用时被拦截 |
| P2 helper | macOS LaunchDaemon / Windows 服务 + IPC + 心跳 + 所有权 + app 运行时 | app 退出/崩溃后自动关闭；用户手动开启不被误关；helper 卸载干净 |
| P3 加固 | 仅公钥、用户/组限制、指纹展示、日志、受管设备文案 | 默认配置通过安全评审；错误路径可诊断 |

## 待验证清单

### macOS（测试机，管理员）

```bash
# 当前状态
launchctl print system/com.openssh.sshd
launchctl print-disabled system | grep com.openssh.sshd

# 开启
sudo launchctl enable system/com.openssh.sshd
sudo launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist
nc -z 127.0.0.1 22 && ssh -o BatchMode=yes localhost true

# 关闭
sudo launchctl bootout system/com.openssh.sshd
sudo launchctl disable system/com.openssh.sshd
```

需确认：

- System Settings → General → Sharing → Remote Login 的开关是否与 launchctl 状态一致。
- “Allow access for” 是否仍按 `com.apple.access_ssh` 生效；非管理员账户能否登录。
- 应用防火墙开启时是否放行；受管机器是否被 MDM 禁止。
- 重启后是否保持；关闭时现有 SSH 会话是否立即断开。
- 未签名 app 通过 `osascript` 提权是否可行；SMAppService 未签名注册的实际报错。
- 在 `/etc/ssh/sshd_config.d/` 写 `Port 2222`，确认 stock socket-activated listener 是否变化；预期不变。若不变，记录“自定义端口需自建 LaunchDaemon”。
- 如评估自定义端口方案，额外验证自定义 `com.shrinkdrop.sshd` LaunchDaemon（2222）与 stock job 的端口/label 冲突。
- macOS 13/14/15/26 各跑一遍；至少覆盖 Apple Silicon 与 Intel。

### Windows（测试 VM，管理员）

```powershell
Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
Get-Service sshd
Get-NetFirewallRule -Name OpenSSH-Server-In-TCP
```

需确认：

- Windows 11 Home 是否能安装并启动。
- 离线/WSUS 环境下失败表现与错误码。
- 非管理员能否查询状态；helper 安装/命名管道权限是否正常。
- 重启后服务是否自动启动；停止服务是否断开现有会话。
- 域 GPO/AppLocker/SmartScreen 对 helper 的影响。
- 管理员账户与非管理员账户的 SSH 登录差异；`administrators_authorized_keys` ACL。
- 自定义端口 2222：改 `sshd_config`、重启 `sshd`、创建对应防火墙规则、确认 22 不再监听。
- 占用检测：先占用 2222（例如临时监听），再开启，确认返回 `port_in_use` 且未写配置/未启动服务；释放后重试成功。
- 配置文件有多个 active `Port` 行时的处理与回滚；`sshd -t` 校验失败时恢复备份。
- 随包 MSI：固定版本哈希/签名校验、`msiexec /qn` 安装、服务名/安装路径、与 FoD 已装的冲突、卸载影响。
- 官网下载页 `https://github.com/PowerShell/Win32-OpenSSH/releases` 可打开；手动安装后 app 能重新检测到 `sshd`。

## 参考

- Apple：Use the systemsetup command-line utility on macOS Catalina 10.15（`-setremotelogin` 需要 Full Disk Access）
  https://support.apple.com/en-us/101653
- Apple：Allow a remote computer to access your Mac（Remote Login 的 GUI、Allow access for）
  https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac
- Apple：SMAppService（macOS 13+ 的 LaunchDaemon/LaunchAgent/LoginItem 注册）
  https://developer.apple.com/documentation/servicemanagement/smappservice
- Apple：Updating helper executables from earlier versions of macOS（`Contents/Library/LaunchDaemons`、`BundleProgram`、用户批准）
  https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos
- nix-darwin：openssh module（因 FDA 改用 launchctl enable/bootstrap）
  https://github.com/nix-darwin/nix-darwin/blob/nix-darwin-26.05/modules/services/openssh.nix
- NIST macOS Security：SSH disable rule（launchctl 状态检查与关闭命令）
  https://github.com/usnistgov/macos_security/blob/tahoe/rules/system_settings/system_settings_ssh_disable.yaml
- 微软：Get started with OpenSSH Server for Windows（安装、启动、防火墙、Home/11 分栏）
  https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse
- 微软：OpenSSH Server configuration for Windows（sshd_config、AllowGroups、administrators_authorized_keys、Entra 限制）
  https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration
- 微软：OpenSSH for Windows overview（版本矩阵、组件）
  https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-overview
- 微软/PowerShell：Win32-OpenSSH releases（独立 MSI 发布页）
  https://github.com/PowerShell/Win32-OpenSSH/releases
- Windows OS Hub：允许非管理员启停服务（`sc sdset` / SDDL 权限）
  https://woshub.com/set-permissions-on-windows-service/