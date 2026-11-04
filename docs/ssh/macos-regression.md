# macOS 回归路线（未签名构建，只读路线）

日期：2026-11-04
适用：macOS 13 / 14 / 15 / 26，Intel 与 Apple Silicon；**未签名构建**
范围：验证「远程访问」在 macOS 上的只读语义正确，并回归现有功能没有被改坏。
不是签名轨 PoC：这条路线**不安装任何 helper、不写系统配置、不使用应用内 SSH 开关**。

> 判定口径：三态 `已开启 / 未开启 / 无法确认`。`无法确认` 绝不能显示成“已开启”。
> 自动化单测覆盖了判定规则；这份路线验证的是真实系统上的输入与 UI 呈现。

---

## 0. 准备（一次性，约 3 分钟）

```bash
sw_vers
# 基线：Remote Login 是否已开。非 root 读不到时用 sudo，别用 && / || 判断，
# 否则会把“没权限”误记成“未加载”，最后还原错。
sudo launchctl print system/com.openssh.sshd >/tmp/sd-ssh-job.txt 2>&1; echo "job-exit=$?"
sudo launchctl print-disabled system >/tmp/sd-ssh-disabled.txt 2>&1; echo "disabled-exit=$?"
grep -n 'com.openssh.sshd' /tmp/sd-ssh-disabled.txt || echo "override=none"
nc -vz -w 1 127.0.0.1 22; echo "nc-exit=$?"
ls -l /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null || echo "no-ed25519-host-key"
```

记录 5 项：`sw_vers` 版本、`job-exit`（0=已加载）、`override`、`nc-exit`、host key 是否存在。
第 4 节清理时按这 5 项还原。

**注意**：应用探测状态时会 `connect 127.0.0.1:22`（400ms 超时）。macOS 的 Remote Login 是
socket activation——**这次连接本身会把 sshd 拉起来**。所以“刚打开设置面板后 `pgrep sshd` 有进程”
是正常现象，不代表应用改了什么。

---

## 1. 只读语义（R1–R6）

### R1 未开启

```bash
sudo launchctl bootout system/com.openssh.sshd 2>/dev/null; echo "bootout=$?"
sudo launchctl disable system/com.openssh.sshd
nc -vz -w 1 127.0.0.1 22; echo "nc-exit=$?"     # 期望非 0（Connection refused）
```

打开 设置 → 远程访问，点一下别处再回来（面板在挂载与窗口获得焦点时刷新）。

期望 UI：
- 只有一行「允许通过 SSH 远程登录本机」+ 按钮「打开共享设置」——**没有开关**；
- 状态卡：`未开启`；
- 没有「生命周期」单选，没有端口输入框（端口显示为纯文本 `22`）；
- 提示：「状态由系统设置管理，应用只读；开启或关闭请到「共享 → 远程登录」。」

### R2 已开启

```bash
sudo launchctl enable system/com.openssh.sshd
sudo launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist; echo "bootstrap=$?"
sudo launchctl print system/com.openssh.sshd | head -10
nc -vz -w 1 127.0.0.1 22; echo "nc-exit=$?"     # 期望 0
```

回到面板（切走再切回，或关闭重开设置窗口）。

期望 UI：
- 状态卡：`系统已启用`；
- 「连接命令」出现：`ssh <当前用户名>@<局域网IP>`（端口 22 时不带 `-p`）；
- 「主机指纹」出现 `SHA256:...`，与下面命令输出一致：

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub    # ecdsa / rsa 也可，按应用的回退顺序
```

- 仍然**没有开关**（只读路线的开关由系统设置负责）。

### R3 端口被别的进程占用 → 必须显示「无法确认」

```bash
sudo launchctl bootout system/com.openssh.sshd      # 先让 launchd job 不在
sudo /usr/bin/nc -l 22 &                            # 用 root 占住 22
sleep 1; nc -vz -w 1 127.0.0.1 22; echo "nc-exit=$?"   # 期望 0（被别的东西占着）
```

回到面板。

期望 UI：
- 状态卡：`无法确认`；
- 出现提示「无法确认：22 端口被其它进程占用，或没有权限读取系统状态。」；
- **不能**出现「系统已启用」，也不能出现伪造的占用进程名/PID（只读路线查不到监听者，就不显示）。

清理：`sudo kill %1`（或 `sudo pkill -f "nc -l 22"`），再走第 4 节。

### R4 无权限 / 受限账户

用标准（非管理员）账户登录，重复 R1 的两条命令观察 `launchctl print` 的报错：

```bash
launchctl print system/com.openssh.sshd; echo "exit=$?"
```

- 若返回 `Could not find service` → 面板应显示 `未开启`；
- 若返回 `Operation not permitted` / `Bad request` → 面板必须显示 `无法确认`（**不是**“未开启”）。

期望 UI 补充：只读路线不显示「SSH 需要管理员账户，请用管理员账户打开应用。」——那句话是给需要 helper 的平台用的；
在 macOS 只读路线里，开启 Remote Login 是去系统设置里操作。

### R5 「打开共享设置」

点面板里的「打开共享设置」。

期望：系统设置打开到 共享（macOS 13–15：系统设置 → 通用 → 共享；26 同上路径）。
若被系统拦下，应用会退回提示语而不是崩——记下现象即可。

### R6 只读边界（关键）

在 R1→R2→R3 全过程中，以下每一项都必须成立：

| 检查 | 命令 | 期望 |
|---|---|---|
| 没写 `ssh` 期望状态 | `python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/Library/Application Support/com.shrinkdrop.app/settings.json')))['ssh'])"` | 始终是 `{'enabled': False, 'lifetime': 'app', 'port': 22}`；不会因为系统开着就变 true |
| 没改 `sshd_config` | `shasum -a 256 /etc/ssh/sshd_config` | 与 R1 之前一致 |
| 没装守护进程 | `ls /Library/LaunchDaemons \| grep -i shrinkdrop; launchctl print system \| grep -i shrinkdrop` | 无输出 |
| 没装有提权组件的 app 资源 | `ls ~/Library/Application\ Support/com.shrinkdrop.app/` | 只有设置/防休眠相关文件，没有 helper 二进制 |
| 没弹授权框 | 全程观察 | 不出现密码/触控 ID 弹窗 |

---

## 2. 现有功能回归（R7–R11）

改动只碰了设置里的一个分组，但这几项与进程生命周期、窗口、局域网有关，必须过一遍。

### R7 压缩

1. 拖入 PNG、JPG、WebP 各 1 张（其中 1 张 > 5 MB），点「开始压缩」。
2. 期望：每行有上传/压缩/下载/校验状态与进度线；完成后显示原始/结果大小与节省比例。
3. 「保存副本」到桌面，打开确认可正常查看；对 1 张点「覆盖」，确认弹窗后原位替换。
4. 断网重试一次：应显示错误并可点重试，不卡在处理中。

### R8 分享

1. 翻到分享面，选 1 个文件夹；显示 `http://<局域网IP>:5421` 与二维码。
2. 手机同一 Wi-Fi 打开链接：能看到目录、能下载。
3. 设置里开「链接 + 6 位 PIN」→ 手机重新打开需要 PIN；输错有提示。
4. 「停止分享」→ 旧链接立刻失效。

### R9 防休眠

设置 → 通用 → 防休眠：切 `关闭 / 仅空闲 / 始终`，每次用
`pgrep -fl caffeinate` 确认进程状态随之变化；`始终` 时 `pmset -g | grep -i disablesleep` 为 1，
切回其它档位后回到 0。

### R10 设置窗口

- 齿轮重复点：只聚焦、不开第二个窗口；
- 语言切到 English：远程访问面板文案同步变英文（含 `Unconfirmed` / `Open Sharing settings`），切回中文；
- 「完成」关闭窗口后再打开：各分组状态保持。

### R11 退出与重启

- Cmd+Q 退出：无残留进程（`pgrep -fl "shrinkdrop|sshd"` 里 sshd 可能因 R2 的 Remote Login 仍在，属基线，不是残留）；
- 重新打开应用：设置值、压缩默认项、分享端口都保持；
- 若 R2 之后你手动关掉了 Remote Login，重开应用后状态卡应显示 `未开启`（不是缓存）。

---

## 3. 记录表

| 项 | 版本/账户 | 结果 | 备注 |
|---|---|---|---|
| R1 未开启 | | | |
| R2 已开启（含指纹一致） | | | |
| R3 端口占用 → 无法确认 | | | |
| R4 非管理员 → 未开启/无法确认 | | | |
| R5 打开共享设置 | | | |
| R6 只读边界（5 项） | | | |
| R7 压缩 | | | |
| R8 分享 | | | |
| R9 防休眠 | | | |
| R10 设置窗口 | | | |
| R11 退出与重启 | | | |

## 4. 按基线还原

```bash
# 先清掉测试用的占用进程
sudo pkill -f "nc -l 22" 2>/dev/null

# 如果基线是「未开启」：
sudo launchctl bootout system/com.openssh.sshd 2>/dev/null
sudo launchctl disable system/com.openssh.sshd

# 如果基线是「已开启」：
sudo launchctl enable system/com.openssh.sshd
sudo launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist

# 核对：override 与第 0 节记录一致，nc 结果与第 0 节一致
grep -n 'com.openssh.sshd' /tmp/sd-ssh-disabled.txt
nc -vz -w 1 127.0.0.1 22; echo "nc-exit=$?"
shasum -a 256 /etc/ssh/sshd_config
```

## 5. 通过标准

- R1/R2/R3/R4 四种系统状态的 UI 与上表逐字一致，`无法确认` 从不显示成已开启；
- R6 五项全部成立（这是只读路线唯一的安全承诺）；
- R7–R11 全部通过，没有新出现的崩溃、卡死或设置丢失；
- 清理后本机状态与第 0 节基线一致（`override`、`nc-exit`、`sshd_config` 哈希）。

任何一项不通过，记录「步骤号 + 期望 + 实际 + `sw_vers`」，回到 issue 里贴记录表即可。
