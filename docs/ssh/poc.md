# SSH 功能平台自测（T0）手册

日期：2026-11-04
状态：待执行（Gate G1–G3 未出结论）
关联：`docs/ssh/plan.md` 的 Task 0、`docs/ssh/helper-protocol.md`、`docs/ssh/signing-setup.md`

这份手册给**你自己在测试机上执行**：每条命令、期望现象、要记录什么、怎么还原。执行完把第 4 节表格填好，**回填本文件并提交**（回帖只放摘要），我据此关闭 Gate 并进入 T4/T5。

## 0. 准备

| 项 | 要求 |
|---|---|
| macOS | **必须**：macOS 15 与 26 各一台；13/14 若仍在支持矩阵内也要测。Intel 与 Apple Silicon 各一台更好 |
| Windows | **必须**：Windows 11 Pro 与 **Home** 各一台；Windows 10 1809+ 若仍在支持矩阵内也要测 |
| 账户 | 两个平台都需要管理员账户；macOS 另备一个**非管理员**账户做 M5；Windows 另备一个标准用户做 W8 |
| 第二台机器 | 与测试机同网段（手机热点也算），用于真实 SSH 登录 |
| 时间 | 每台 30–40 分钟；重启项每次 +5 分钟 |
| 快照 | 有条件就给测试机打快照/还原点：W9 会动系统 OpenSSH 安装 |

**安全边界**：只在可信局域网内测，不要在公网或公司网络开 22；测完按第 5 节还原。

> 命令里的 `<...>` 是占位符，执行前替换成真实值（PowerShell 里 `<` 会被当成重定向）。

### 0.1 先记录基线（不能跳过）

清理要按基线还原，所以先跑这一段并把输出抄进第 4 节：

```bash
sw_vers
# 用 sudo 读取并保留原始输出：非 root 时 print 可能因权限失败，
# 不能用 `&& / ||` 判断，否则会把“没权限”误记成“未加载”，第 5 节就会还原错。
sudo launchctl print system/com.openssh.sshd >/tmp/shrinkdrop-poc-job.txt 2>&1; echo "ssh-job-exit=$?"
sudo launchctl print-disabled system >/tmp/shrinkdrop-poc-disabled.txt 2>&1; echo "disabled-exit=$?"
grep -n 'com.openssh.sshd' /tmp/shrinkdrop-poc-disabled.txt || echo "ssh-override=none"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
# 下面这份备份只用于 M12 前后 diff，证明 /etc/ssh/sshd_config 本体没被改；第 5 节不会用它覆盖回去。
cp /etc/ssh/sshd_config /tmp/shrinkdrop-poc-sshd_config.orig
grep -n '^\s*Include' /etc/ssh/sshd_config
```

判定：`ssh-job-exit=0` 记 `loaded`，非 0 记 `unloaded` 并把 `/tmp/shrinkdrop-poc-job.txt` 的内容抄一行到结果表（若出现权限错误，用 sudo 重跑）。`/tmp/shrinkdrop-poc-disabled.txt` 第 5 节会逐字比对，别删。

Windows（管理员 PowerShell）：

```powershell
Get-Service sshd -ErrorAction SilentlyContinue | Format-List Name,Status,StartType
Get-WindowsCapability -Online -Name OpenSSH.Server*
Get-NetFirewallRule -Name OpenSSH-Server-In-TCP -ErrorAction SilentlyContinue | Format-List Name,Enabled
Copy-Item "$env:ProgramData\ssh\sshd_config" "$env:ProgramData\ssh\sshd_config.poc-orig" -ErrorAction SilentlyContinue
```

**如果你正在用远程登录操作这台 Mac，先停下**：M6 会关闭 Remote Login，你会失去这条入口。

## 1. 授权方式（先分清两件事）

### 1.1 现在：你执行 PoC 需要的授权

你本机执行，**不需要给我远程访问**，也不需要额外审批：

- macOS：`sudo -v` 之后 5 分钟内 `sudo` 命令不再提示密码；超时或换终端要重输。下文所有 `sudo` 命令都只需要普通管理员账户，**不需要**给终端“完全磁盘访问权限”（只有 M14 的 `systemsetup` 需要，且是可选项）。
- Windows：右键 PowerShell → **以管理员身份运行**。确认提权生效：

  ```powershell
  whoami /groups | Select-String "S-1-5-32-544"
  ```

  行尾显示 `Enabled group` 才是真管理员；显示 `Group used for deny only` 说明只是“在管理员组但未提权”。

### 1.2 以后：产品里的授权模型（本轮不测，供你判断体验）

| 平台 | 首次开启 | 后续 |
|---|---|---|
| macOS | 应用通过 SMAppService 注册 helper → 系统密码/触控 ID → 系统设置 → 通用 → **登录项与扩展** 里允许 | 不再弹；升级 helper 后可能再确认一次 |
| Windows | UAC 允许一次安装 helper（LocalSystem 服务） | 由服务操作 `sshd`，不再弹 UAC |
| 标准用户 | 开关禁用，提示“需要管理员账户” | 同上，不做降权代理 |

这一版代码里，helper 不可用时整组**可见但禁用或只读**（取决于签名路线，见 `signing-setup.md` §9），不会假装可用。

## 2. macOS 步骤

### M1 基线核对（只读）

用 0.1 的输出核对：job 未加载、22 端口拒绝连接、host key 是否存在：

```bash
ls -l /etc/ssh/ssh_host_ed25519_key.pub
nc -vz -w 1 127.0.0.1 22
```

期望：`ssh-job=unloaded`；`nc` 报 `Connection refused`；host key 不存在（首次开启后才生成）。

记录：基线三项 + `nc` 输出。

### M2 开启（launchctl 路径，仅 root）

```bash
sudo launchctl enable system/com.openssh.sshd
sudo launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist
pgrep -x sshd | wc -l            # 期望 0：socket activation，无连接时常驻进程不存在
launchctl print system/com.openssh.sshd | head -20
nc -vz -w 1 127.0.0.1 22
```

注意顺序：先 `pgrep` 再 `nc`。`nc` 会触发一次 socket activation，之后短时间内可能有 `sshd` 进程，属于正常。

期望：`launchctl print` 有输出（`state` 字段原样记录，不预设取值）；`pgrep` 为 0；`nc` 成功。

记录：三条关键命令的退出码与输出摘要——这是 Gate G1 的主要证据。

### M3 与系统设置是否一致

打开 系统设置 → 通用 → 共享 → **远程登录**，看开关状态；再手动关一次、开一次，每步回终端执行：

```bash
launchctl print system/com.openssh.sshd >/dev/null 2>&1 && echo loaded || echo unloaded
nc -vz -w 1 127.0.0.1 22
```

期望：开关与 `launchctl` 状态同步。**不一致**时记下版本与差异——决定 Gate G1 是否回退到 `systemsetup` + FDA 方案。

### M4 真实登录（核心证据）

另一台机器：

```bash
ssh <用户名>@<测试机局域网IP>
```

记录：是否连上、用password还是公钥、失败提示。测试机侧：

```bash
sudo log show --last 2m --predicate 'process == "sshd"' | tail -20
# 备选：sudo tail -n 50 /var/log/system.log
```

### M5 允许哪些账户

```bash
dscl . -read /Groups/com.apple.access_ssh
```

记录 `NestedGroups`。用**非管理员**账户登录这台 Mac，再试一次 SSH，记录能否登录。

### M6 关闭

```bash
sudo launchctl bootout system/com.openssh.sshd
sudo launchctl disable system/com.openssh.sshd
nc -vz -w 1 127.0.0.1 22
```

期望：`nc` 失败；`launchctl print` 找不到服务；系统设置里的远程登录回到关。

记录：`bootout` 在“未加载”时的错误文本（产品要按幂等处理）。

### M7 防火墙（先 M6 关闭，再逐组合跑）

```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --listapps | grep -i -A2 ssh
```

组合：防火墙开 × (M2→M4)、防火墙关 × (M2→M4)，每种组合结束都跑一次 M6。记录：

- 是否需要手动“允许传入连接”；
- `--listapps` 里 `/usr/libexec/sshd-keygen-wrapper`（或等价条目）的当前状态；
- 若手动允许过，记下是否需要在 系统设置 → 网络 → 防火墙 → 选项 里删除该条目。

### M8 重启保持

开启后重启 → 跑 M1 的检查；再关闭后重启 → 再查一次。记录两次结果（决定 `persistent`/`app` 生命周期在重启后的真实行为）。

### M9 关闭时现有会话

先建立一个 SSH 会话（保持 `ssh` 窗口），执行 M6，记录：立即断开 / 还能继续 / 只拒绝新连接。

### M10 FileVault

开启 FileVault 的机器重启，**到解锁界面先不输密码**，从另一台机器尝试 SSH；解锁登录后再试一次。记录两次结果（预期：解锁前不可登录）。

### M11 DMG 直跑（app translocation）

用**浏览器下载**的 DMG（本地打包的没有 quarantine，测不出 translocation）：

```bash
ls -d /Volumes/shrinkdrop*/shrinkdrop.app
xattr -p com.apple.quarantine "/Volumes/shrinkdrop/shrinkdrop.app"
codesign -dv --verbose=4 "/Volumes/shrinkdrop/shrinkdrop.app"
```

记录：是否有 quarantine、签名状态（未签名/临时签名）、从 DMG 直接运行时能否注册 helper（注册代码属 T4，本轮先记录“是否需要要求移动到 `/Applications`”）。

### M12 自定义端口（验证“改不动”）

先确认 stock 配置确实读 `sshd_config.d`：

```bash
grep -n '^\s*Include' /etc/ssh/sshd_config
```

没有 `Include` 的版本本测试无意义，直接记录“不支持 drop-in”。

```bash
sudo mkdir -p /etc/ssh/sshd_config.d
printf 'Port 2222\n' | sudo tee /etc/ssh/sshd_config.d/shrinkdrop-test.conf
sudo sshd -t -f /etc/ssh/sshd_config        # 先验证配置语法
sudo launchctl bootout system/com.openssh.sshd 2>/dev/null
sudo launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist
nc -vz -w 1 127.0.0.1 22; nc -vz -w 1 127.0.0.1 2222
```

记录：22 是否仍监听、2222 是否监听（预期：22 监听、2222 不监听）。

### M13 host key 指纹

```bash
ls -l /etc/ssh/ssh_host_ed25519_key.pub
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

记录：首次开启后是否自动生成、指纹格式（产品展示 `SHA256:...`）。

### M14（可选）systemsetup / FDA 证据

只在你要评估 Gate G1 的回退方案时做：

```bash
sudo systemsetup -getremotelogin
# 未给终端完全磁盘访问权限时，记录完整报错文本
```

记录：报错文本（决定“回退到 systemsetup + 引导 FDA”是否可写进产品文案）。

## 3. Windows 步骤

以**管理员** PowerShell 执行；只有 W1 的一半与 W8 用普通权限。

### W1 基线与非管理员可读性

普通用户（不提权）只跑：

```powershell
Get-Service sshd -ErrorAction SilentlyContinue
Get-ChildItem "$env:SystemRoot\System32\OpenSSH" -ErrorAction SilentlyContinue
sc.exe query sshd
```

管理员再跑：

```powershell
Get-WindowsCapability -Online -Name OpenSSH.Server*
```

期望：服务不存在、`OpenSSH` 目录不存在、Capability 为 `NotPresent`。记录普通用户能读到什么（决定“标准用户只看状态”的 UI 是否成立）。

### W2 安装可选功能（FoD）

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Get-WindowsCapability -Online -Name OpenSSH.Server*
```

记录：是否需要联网/Windows Update；离线或 WSUS 环境的完整报错文本（UI 兜底文案来源）；Home 与 Pro 的差异。

### W3 启动与常驻

```powershell
Start-Service sshd
Get-Service sshd | Format-List Name,Status,StartType
Set-Service -Name sshd -StartupType Automatic
```

记录：**安装后的默认 `StartType`**（清理要还原成这个值）。

### W4 防火墙

```powershell
Get-NetFirewallRule -Name OpenSSH-Server-In-TCP | Format-List Name,Enabled,Direction,Profile,Action
```

记录：规则是否默认存在、启用、覆盖哪些 Profile。

### W5 真实登录

另一台机器 `ssh <用户名>@<IP>`；测试机侧：

```powershell
Get-Content "$env:ProgramData\ssh\logs\sshd.log" -Tail 20 -ErrorAction SilentlyContinue
Get-WinEvent -LogName 'OpenSSH/Operational' -MaxEvents 20 -ErrorAction SilentlyContinue
```

记录：管理员与非管理员账户分别能否登录（管理员走 `administrators_authorized_keys`）。

### W6 自定义端口（换端口，不是加端口）

先看现有生效的 `Port` 行：

```powershell
Select-String -Path "$env:ProgramData\ssh\sshd_config" -Pattern '^\s*Port\s'
Copy-Item "$env:ProgramData\ssh\sshd_config" "$env:ProgramData\ssh\sshd_config.shrinkdrop-backup"
```

把已有的 active `Port` 行注释掉（模拟 helper 的托管块），再追加：

```powershell
Add-Content "$env:ProgramData\ssh\sshd_config" "`nPort 2223"
$sshd = (Get-Command sshd.exe -ErrorAction SilentlyContinue).Source
if (-not $sshd) { $sshd = "$env:SystemRoot\System32\OpenSSH\sshd.exe" }
& $sshd -t
Restart-Service sshd
Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 22,2223 | Select-Object LocalPort,OwningProcess
```

先确认当前网络类别（规则按 Profile 匹配，Public 网络下 `-Profile Private` 不生效）：

```powershell
Get-NetConnectionProfile | Select-Object Name,NetworkCategory
```

自建规则（不动 stock 规则；只放行 Private；若测试机是 Domain/Public，按实际类别改 `-Profile` 并记录）：

```powershell
New-NetFirewallRule -Name "shrinkdrop-ssh-2223" -DisplayName "shrinkdrop SSH 2223" `
  -Direction Inbound -Protocol TCP -LocalPort 2223 -Profile Private -Action Allow
```

记录：`sshd -t` 是否通过、22 是否**不再**监听、2223 是否可连、重启后是否保持。

### W7 端口占用

先停服务，避免与 W6 抢端口：

```powershell
Stop-Service sshd
New-Item -ItemType Directory -Force "$env:TEMP\shrinkdrop-poc-listen" | Out-Null
Set-Location "$env:TEMP\shrinkdrop-poc-listen"
python -m http.server 2223 --bind 127.0.0.1
# 另开管理员窗口：
Start-Service sshd          # 预期：启动失败或起来但 2223 不通
Get-NetTCPConnection -LocalPort 2223 -State Listen | Select-Object LocalPort,OwningProcess
Get-Process -Id <OwningProcess>
```

记录：服务失败表现、能否稳定拿到 PID 与进程名（UI 要显示它）。测完 `Stop-Process -Id <OwningProcess>`。

### W8 非管理员权限

普通用户（不提权）：

```powershell
sc.exe query sshd
Get-Service sshd
whoami /groups | Select-String "S-1-5-32-544"
```

记录：只读查询是否可用；管理员组显示 `Enabled group` 还是 `Group used for deny only`。

### W9 随包 MSI（**只在干净 VM / 快照上做**）

在已装 FoD 的机器上再装 standalone 会抢服务名、覆盖 `%ProgramData%\ssh`，把测试机弄成半坏状态。要做请先还原快照，或先移除 FoD 并重启：

```powershell
Remove-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Restart-Computer
```

然后：

```powershell
Get-FileHash .\OpenSSH-Win64-v<version>.msi -Algorithm SHA256
Get-AuthenticodeSignature .\OpenSSH-Win64-v<version>.msi | Format-List Status,SignerCertificate
msiexec /i .\OpenSSH-Win64-v<version>.msi /qn /norestart
Get-Service sshd
Get-Package *OpenSSH* | Select-Object Name,Version,ProviderName,ProductCode
```

记录：哈希与签名状态、安装后服务名/端口、`msiexec` 返回码（0/3010/1603/1618）、卸载后是否清理干净。卸载用第 5 节的 `msiexec /x`。

### W10 重启与卸载

```powershell
Restart-Computer
# 重启后：Get-Service sshd; Get-NetTCPConnection -State Listen | ? LocalPort -in 22,2223
Stop-Service sshd
Remove-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
```

记录：重启保持结果、卸载后服务/防火墙规则是否残留。

## 4. 结果回填

一行一个检查点，**失败也写**；`基线/差异` 列放 0.1 的基线值或与期望的差异。

| 项 | 平台 + 版本 | 命令/操作 | 期望 | 实际 | 基线/差异 | 结论 |
|---|---|---|---|---|---|---|
| 0.1 |  | 基线采集 | 记录 job/override/防火墙 |  |  |  |
| M1 |  | host key / `nc` 基线 | 与 0.1 一致 |  |  |  |
| M2 |  | `launchctl bootstrap` | 22 监听、无常驻进程 |  |  |  |
| M3 |  | 系统设置开关同步 | 一致 |  |  |  |
| M4 |  | 真实 SSH 登录 | 能登录 |  |  |  |
| M5 |  | 非管理员 SSH | 按 ACL 决定 |  |  |  |
| M6 |  | `bootout` + `disable` | 22 关闭 |  |  |  |
| M7 |  | 防火墙开/关 × 开启 | 记录放行行为 |  |  |  |
| M8 |  | 重启后保持 | 开保持 / 关保持 |  |  |  |
| M9 |  | 关闭时会话 | 记录实际行为 |  |  |  |
| M10 |  | FileVault 解锁前 | 不可登录 |  |  |  |
| M11 |  | DMG 直跑 | 记录 quarantine/签名 |  |  |  |
| M12 |  | `Port 2222` | 22 不变、2222 不监听 |  |  |  |
| M13 |  | host key 指纹 | 自动生成、`SHA256:`；清理后按基线删除 |  |  |  |
| M14 |  | `systemsetup`（可选） | 记录 FDA 报错 |  |  |  |
| W1 |  | 非管理员只读 | 可读/不可读 |  |  |  |
| W2 |  | FoD 安装 | 成功或报错文本 |  |  |  |
| W3 |  | 默认 StartType | 记录实际值 |  |  |  |
| W4 |  | 防火墙规则 | 存在且启用 |  |  |  |
| W5 |  | 真实 SSH 登录 | 能登录 |  |  |  |
| W6 |  | 换端口 2223 | 仅 2223 监听 |  |  |  |
| W7 |  | 端口占用 | 可拿到 PID/进程名 |  |  |  |
| W8 |  | 非管理员只读 | 可用 |  |  |  |
| W9 |  | 随包 MSI | 哈希/签名/返回码 |  |  |  |
| W10 |  | 重启/卸载 | 无残留 |  |  |  |

## 5. 清理（测完立刻做，按 0.1 基线还原）

### macOS

**基线为 unloaded（0.1 的 `ssh-job-exit` 非 0）**：

```bash
# 1) 关掉本轮开启的实例
sudo launchctl bootout system/com.openssh.sshd 2>/dev/null
sudo launchctl disable system/com.openssh.sshd

# 2) 若 0.1 的 print-disabled 里没有 com.openssh.sshd，清掉 disable 覆盖
#    （enable 只改覆盖库，不会加载服务；它是否写回一条 enabled 记录以实测为准）
sudo launchctl enable system/com.openssh.sshd
```

**基线为 loaded（本来开着远程登录）**：**不要**执行上面的 `bootout`/`disable`，只确认服务仍在：

```bash
sudo launchctl print system/com.openssh.sshd >/dev/null 2>&1 ||   sudo launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist
sudo launchctl enable system/com.openssh.sshd
nc -vz -w 1 127.0.0.1 22                       # 期望成功
```

两种基线都要做（清理新增物）：

```bash
# 3) 删除本轮新增的配置/备份，不动 /etc/ssh/sshd_config 本体
sudo rm -f /etc/ssh/sshd_config.d/shrinkdrop-test.conf
sudo rm -f /tmp/shrinkdrop-poc-sshd_config.orig
# 若 M1 记录 host key 不存在，删除本轮自动生成的 host key（否则保留）
sudo rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub \
           /etc/ssh/ssh_host_rsa_key /etc/ssh/ssh_host_rsa_key.pub \
           /etc/ssh/ssh_host_ecdsa_key /etc/ssh/ssh_host_ecdsa_key.pub

# 4) 还原防火墙到 0.1 记录的基线（仅在 M7 改过时）
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
# 基线为开、现在为关：sudo ... --setglobalstate on
# 基线为关、现在为开：sudo ... --setglobalstate off
# M7 手动允许过 sshd-keygen-wrapper：在 系统设置 → 网络 → 防火墙 → 选项 删除该条目

# 5) 终态校验（逐项与 0.1 比对，不要只看“无覆盖”）
sudo sshd -t -f /etc/ssh/sshd_config
nc -vz -w 1 127.0.0.1 22                       # 基线 unloaded 时期望 Connection refused
sudo launchctl print-disabled system >/tmp/shrinkdrop-poc-disabled-after.txt 2>&1
diff /tmp/shrinkdrop-poc-disabled.txt /tmp/shrinkdrop-poc-disabled-after.txt \
  && echo "覆盖库与基线一致" || echo "覆盖库有差异：把 diff 抄进结果表"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate   # 必须等于 0.1 的值
```

### Windows

```powershell
# 0) 先把 0.1 的基线填进来（示例值只是占位，按实际改）
$baseSshd       = 'Stopped'      # 0.1: Get-Service sshd → NotPresent / Stopped / Running
$baseStartType  = 'Manual'       # 0.1 / W3 记录的原始 StartType
$baseCapability = 'NotPresent'   # 0.1: Get-WindowsCapability 的状态

# 1) 结束 W7 留下的 python 监听进程（只处理 python，避免误杀 sshd）
Get-NetTCPConnection -LocalPort 2223 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object {
    $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -match 'python') { Stop-Process -Id $p.Id -ErrorAction SilentlyContinue }
  }

# 2) 卸载随包 MSI（仅 W9 做过；先看装了什么）
Get-Package *OpenSSH* -ErrorAction SilentlyContinue | Select-Object Name,Version
# 卸载：设置 → 应用 → OpenSSH Server → 卸载
# 已知 ProductCode 时：msiexec /x "<ProductCode>" /qn /norestart

# 3) 还原 sshd_config（仅在 W6 改过时）
if (Test-Path "$env:ProgramData\ssh\sshd_config.shrinkdrop-backup") {
  Copy-Item "$env:ProgramData\ssh\sshd_config.shrinkdrop-backup" "$env:ProgramData\ssh\sshd_config" -Force
  Remove-Item "$env:ProgramData\ssh\sshd_config.shrinkdrop-backup" -Force
}
Remove-Item "$env:ProgramData\ssh\sshd_config.poc-orig" -ErrorAction SilentlyContinue

# 4) 删除自建防火墙规则
Remove-NetFirewallRule -Name "shrinkdrop-ssh-2223" -ErrorAction SilentlyContinue

# 5) 按基线还原服务（基线 NotPresent 时不要创建服务，只卸载本轮装的东西）
if (Get-Service sshd -ErrorAction SilentlyContinue) {
  Set-Service -Name sshd -StartupType $baseStartType
  if ($baseSshd -eq 'Running') { Start-Service sshd } else { Stop-Service sshd }
}

# 6) Capability：只有基线是 NotPresent 时才卸载本轮装上的 FoD
if ($baseCapability -ne 'Present') {
  Remove-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
}

# 7) 终态校验（与 0.1 逐项比对）
Get-Service sshd -ErrorAction SilentlyContinue | Format-List Status,StartType
Get-WindowsCapability -Online -Name OpenSSH.Server*
Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 22,2223
# 期望：服务状态/StartType/Capability 与 0.1 一致，22/2223 不再监听（基线本来就开着的除外）
```

## 6. Gate 判据

| Gate | 判据 | 不通过时 |
|---|---|---|
| G1 | 在 macOS 15 与 26（以及仍在支持矩阵内的 13/14）上，M2/M3/M6/M8 全部一致，且 M4 真实登录成功 | 回退 `systemsetup` + 引导 FDA（用 M14 证据），或把 macOS 缩为“只读状态 + 手动开启引导” |
| G2 | Windows 11 **Home** 上 W2 + W3 + W4 + W5 全部通过（能装、能起、防火墙放行、能登录） | Home 隐藏该功能，支持矩阵按实测写死 |
| G3 | 两条路线（选择见 `plan.md`）：**G3a 签名轨** = `codesign --verify --strict` + `spctl -a -vvv -t install`（pkg）+ `stapler validate` 全绿；**G3b 不签名轨** = macOS 只读状态无可用开关且无 helper 残留、Windows 可装可连、README 的 Gatekeeper/SHA256 步骤可复现 | 两条都不满足则不发 SSH 功能 |

> G3 是“发布产物的客观校验”，不靠 PoC 主观判断：没有 Developer ID Application（签 app/helper）+ Developer ID Installer（签 pkg）+ 公证，就必然不通过。

## 7. 本轮不测（依赖 T4/T5，不计入 G1–G3）

下面这些项要等 helper 代码存在才能测，`plan.md` Task 0 里已标注：

- 未签名/临时签名下 `SMAppService.daemon(...).register()` 的报错（T4 之后补测，仅供参考，不改 G3 判据）
- helper 通过 `osascript`/管理员授权安装的体验（T4）
- 从 DMG 直跑时能否注册 helper（T4）
- Windows UAC 安装 helper、命名管道 ACL、服务安装/升级（T5）
- 自定义 LaunchDaemon（`com.shrinkdrop.sshd`）的可行性（另立项，见研究文档）

## 8. 记录时注意

- 不要贴password、私钥、完整的 `authorized_keys`；IP 可打码成 `192.168.1.x`。
- 失败命令请连**完整报错文本**一起贴，UI 文案要按真实错误写。
- 每台机器测完按第 5 节还原，别把 22/2223 留在开着。
