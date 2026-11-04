# 签名与公证获取（macOS Developer ID / Windows Authenticode）

日期：2026-11-04
状态：未配置（当前安装包未签名、未公证）
关联：`docs/ssh/plan.md` 的 Task 8、Gate G3；`docs/distribution/package-managers.md`

签名分两件事，别混：

| 项 | 影响什么 | 不做的后果 |
|---|---|---|
| **Developer ID 证书**（99 美元/年） | macOS helper 通过 `SMAppService` 注册的前提（app 与 helper 同 Team ID） | macOS 无法做应用内开关；只能降级为“只读状态 + 手动引导” |
| **公证（notarization）** | 分发：Gatekeeper 是否放行下载来的包 | 用户要多点一次“仍要打开”；不影响 `register()`（社区实测：Developer ID 签名但不公证仍可注册） |
| **Windows Authenticode** | 信任提示：SmartScreen 是否警告 | 功能不受影响；用户点“更多信息 → 仍要运行” |

也就是说：**Windows 不签名不影响 SSH 功能；macOS 不签 Developer ID 就做不了应用内开关**。没有开发者账号时，SSH 功能在 macOS 上降级为“只读状态 + 手动开启引导”（见第 9 节），在 Windows 上保持全功能。

在拿到证书之前，SSH 功能按“可见但禁用/降级”处理，不会假装可用。

## 1. 要准备的东西

| 项 | 用途 | 获取成本 |
|---|---|---|
| Apple Developer Program 会员 | 生成证书、提交公证 | 个人/公司 99 美元/年；账号注册与组织审核 1–3 个工作日 |
| **Developer ID Application** 证书（含私钥） | 签 `.app`、helper、其它嵌套可执行文件 | 会员内免费；上传 CSR 后即时签发 |
| **Developer ID Installer** 证书（含私钥） | 签 `.pkg`（`productsign`） | 同上，需单独申请 |
| Team ID | 证书、公证、Tauri 配置都以它为准 | 会员页可见 |
| 公证凭据（二选一） | `notarytool` 提交 | 免费 |
| Windows 代码签名证书或 Azure Trusted Signing | 签 `.exe` / `.msi` / helper | 见第 5 节 |

> 两种 macOS 证书都要：`.app`/helper 只能用 Application 签，`.pkg` 只能用 Installer 签。只做 DMG 直发可以不要 Installer，但本仓库同时发布 `.pkg` 且标为推荐下载。

## 2. macOS：拿 Developer ID

1. **注册会员**：<https://developer.apple.com/programs/>。个人账号需要双重认证；组织账号需要 D-U-N-S 编号，审核通常 1–3 个工作日。
2. **取 Team ID**：<https://developer.apple.com/account> → Membership details，形如 `ABCDE12345`。
3. **生成 CSR**（一次即可，两个证书共用）：钥匙串访问 → 菜单“证书助理” → “从证书颁发机构请求证书…” → 存到磁盘。
4. **创建两张证书**：developer.apple.com → Certificates, IDs & Profiles → Certificates → **+**：
   - **Developer ID Application** → 上传 CSR → 下载 `.cer`
   - **Developer ID Installer** → 再上传同一份 CSR → 下载 `.cer`
5. **导入**：依次双击 `.cer`，确认钥匙串里两张证书都**带私钥**（展开三角能看到）。若同名私钥已存在，第二步只会挂证书，不会重复生成。
6. **导出给 CI**：钥匙串访问 → 分别选中“证书 + 私钥” → 导出 `.p12`，各设强password。
7. **自检**：

   ```bash
   security find-identity -v -p codesigning | grep "Developer ID Application"
   security find-identity -v -p basic       | grep "Developer ID Installer"
   ```

   `Developer ID Installer` 不在 codesigning 策略里，必须用 `-p basic` 才看得到。

## 3. macOS：公证凭据（二选一）

**A. Apple ID + App 专用password（本机手测最省事）**

1. <https://account.apple.com> → 登录与安全 → App 专用password → 生成（形如 `abcd-efgh-ijkl-mnop`）。
2. 存成 notarytool 的 keychain profile：

   ```bash
   xcrun notarytool store-credentials shrinkdrop-notary \
     --apple-id you@example.com \
     --team-id TEAMID \
     --password abcd-efgh-ijkl-mnop
   ```

**B. App Store Connect API Key（CI 推荐，不绑个人password）**

1. App Store Connect → 用户和访问 → 集成 → App Store Connect API → 生成密钥，角色 **App Manager**。
2. 下载 `.p8`（**只能下一次**），记下 Key ID 与 Issuer ID。
3. 提交时用：

   ```bash
   xcrun notarytool submit "$PKG" \
     --key AuthKey_XXXX.p8 --key-id KEYID --issuer ISSUERID --wait
   ```

Tauri v2 也认 `APPLE_API_KEY` / `APPLE_API_KEY_PATH` / `APPLE_API_ISSUER`：`APPLE_API_KEY` 是“密钥文件的绝对路径”还是“密钥内容”，Tauri 版本间有过差异（`[需核对]` 以所用 tauri-cli 版本文档为准）；CI 里最稳的是直接调用 `notarytool`，不依赖 Tauri 的公证封装。

## 4. macOS：签名顺序、打包、公证、校验

**顺序**：先签**所有子二进制**（helper 等）→ 再签 `.app` → 再打 `.pkg` 并 `productsign` → 最后生成并公证 DMG。顺序反了外层封印会失效，公证会以“nested executable lacks hardened runtime/timestamp”失败。

关键点：**签名要发生在打包之前**。先由 Tauri 打出 DMG、再回头签 helper，会导致 DMG 里的 app 与 pkg 里的 app 不是同一份签名产物。正确做法是把签好的 helper 放进资源目录，让 Tauri 用它打包。

```bash
IDENTITY="Developer ID Application: <名称> (TEAMID)"
INSTALLER="Developer ID Installer: <名称> (TEAMID)"
APP="target/release/bundle/macos/shrinkdrop.app"
HELPER="<构建产物路径>/shrinkdrop-ssh-helper"       # T4 决定实际路径
RESOURCE="<Tauri 资源目录>/shrinkdrop-ssh-helper"   # T4 决定实际路径

# 1) 先签 helper，再放回资源目录（Tauri 打包时会把它作为资源拷进 app）
codesign --force --timestamp --options runtime --sign "$IDENTITY" "$HELPER"
cp "$HELPER" "$RESOURCE"

# 2) 一次打包：Tauri 用 identity 签 app，同时产出 app 与 dmg
pnpm tauri build --bundles app,dmg
DMG="target/release/bundle/dmg/shrinkdrop_0.1.6_universal.dmg"

# 3) 校验嵌套签名：app 与 helper 的 TeamIdentifier、Runtime Version 必须一致
codesign -dvvv "$APP/Contents/Resources/shrinkdrop-ssh-helper" 2>&1 | grep -E "TeamIdentifier|Runtime Version"
codesign -dvvv "$APP" 2>&1 | grep -E "TeamIdentifier|Runtime Version"

# 4) 用仓库脚本打 pkg（不要手写 productbuild，会丢掉 distribution.xml 与欢迎页）
node scripts/build-macos-pkg.mjs "$APP" dist "0.1.6"
PKG="dist/shrinkdrop_0.1.6_universal.pkg"

# 5) 用 Installer 证书就地签 pkg（文件名保持不变，发布脚本按它收集）
productsign --sign "$INSTALLER" "$PKG" "$PKG.tmp" && mv "$PKG.tmp" "$PKG"

# 6) 公证并 staple pkg 与 dmg
xcrun notarytool submit "$PKG" --keychain-profile shrinkdrop-notary --wait
xcrun stapler staple "$PKG"
xcrun notarytool submit "$DMG" --keychain-profile shrinkdrop-notary --wait
xcrun stapler staple "$DMG"

# 7) 校验
codesign --verify --strict --verbose=2 "$APP"          # 不要用 --deep 校验
spctl -a -vvv -t exec "$APP"
spctl -a -vvv -t install "$PKG"
xcrun stapler validate "$PKG"
xcrun stapler validate "$DMG"
spctl -a -vvv -t open --context context:primary-signature "$DMG"
```

> 如果你的 Tauri 版本在 `tauri build` 阶段会把 `Contents/Resources` 里的可执行文件重新签成“无 timestamp”的版本，就在打包后再补一次“签 helper → `codesign --force` 重签 app → **重新生成 DMG**”，并放弃旧 DMG。第 3 步的 `codesign -dvvv` 就是用来发现这种情况的。`[推断]` 需在第一次签名构建时实测确认。

通过时应看到 `source=Notarized Developer ID`、`The validate action worked!`。

### DMG 也要公证

发布同时上传 `.dmg` 与 `.pkg`，而 DMG 打开同样过 Gatekeeper。二选一，别混：

- **推荐**：用 **Tauri 的 DMG 打包器**（保留图标布局与 `/Applications` 软链）从**已签名的 app** 重新生成，再按上一节第 7 步公证/staple。不要用 `hdiutil create -srcfolder` 临时拼一个——那会丢掉拖拽安装的引导，产物也与正式发行不一致。
- 或者：这版只发 pkg，DMG 明确标注“未签名/不推荐”，并同步 `README.md` 的下载说明。

## 5. Windows：Authenticode

| 方案 | 说明 | 代价 |
|---|---|---|
| OV 代码签名证书 | DigiCert / Sectigo / SSL.com 等 | 数百美元/年；私钥常在硬件令牌或云 HSM |
| EV 代码签名证书 | 同上，SmartScreen 立即有信誉 | 更贵，审核更严 |
| Azure Artifact Signing（原 Trusted Signing） | 微软云签名，Basic 档约 9.99 美元/月（5,000 次签名/月，以 Azure 定价页为准） | **不免费**：必须有**付费** Azure 订阅（免费/试用/赞助订阅不支持）；需通过身份验证（个人可用，要政府证件与地址证明）；**只签 Windows 二进制，对 macOS 无用** |
| 自签名 | 仅内部测试 | 免费，**不能发布** |

要签**用户实际拿到的东西**，不只是主程序：

```powershell
$env:PATH += ";C:\Program Files (x86)\Windows Kits\10\bin\<ver>\x64"   # signtool 来自 Windows SDK
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a shrinkdrop.exe
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a shrinkdrop-ssh-helper.exe
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a shrinkdrop_0.1.6_x64-setup.exe
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a shrinkdrop_0.1.6_x64_en-US.msi
signtool verify /pa /v shrinkdrop_0.1.6_x64-setup.exe
```

Tauri 侧：`bundle.windows.certificateThumbprint`、`digestAlgorithm = "sha256"`、`timestampUrl = "http://timestamp.digicert.com"`。

注意：

- SmartScreen 对**新证书**有声誉爬坡，EV 或 Trusted Signing 更快；不是代码问题。
- 随包 OpenSSH MSI 是第三方产物：只校验它的 SHA256/Authenticode，不重签。

## 6. CI 接入（GitHub Actions secrets）

| Secret | 内容 |
|---|---|
| `APPLE_CERTIFICATE` | Developer ID **Application** `.p12` 的 base64 |
| `APPLE_CERTIFICATE_PASSWORD` | 上面的 `.p12` 导出password |
| `APPLE_INSTALLER_CERTIFICATE` | Developer ID **Installer** `.p12` 的 base64 |
| `APPLE_INSTALLER_CERTIFICATE_PASSWORD` | 上面的 `.p12` 导出password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: … (TEAMID)` |
| `APPLE_INSTALLER_IDENTITY` | `Developer ID Installer: … (TEAMID)` |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | 公证方案 A |
| `APPLE_API_KEY_PATH` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` | 公证方案 B（`.p8` 写到临时文件后给路径） |
| `WINDOWS_CERT_PFX` / `WINDOWS_CERT_PASSWORD` | Windows 签名（若用证书方案） |

构建顺序必须是（核心原则：**先把 helper 签好，再让 Tauri 打 app 与 DMG**）：

1. 构建 universal helper，用 `codesign --options runtime --timestamp` 签名，放进资源目录
2. `tauri build --bundles app,dmg`（Tauri 用 identity 签 app，同时产出 DMG）
3. `codesign -dvvv` + `codesign --verify --strict` 检查 app 与 helper 的 `TeamIdentifier`/`Runtime Version`；不一致就停在 CI
4. `node scripts/build-macos-pkg.mjs` 产 pkg
5. `productsign` 用 Installer 证书就地签 pkg（文件名不变）
6. `notarytool submit --wait` 公证 pkg 与 dmg
7. `stapler staple` pkg 与 dmg
8. `codesign --verify --strict` / `spctl -t install`（pkg）/ `spctl -t exec`（app）/ `spctl -t open`（dmg）/ `stapler validate` 全部通过
9. 上传产物

> 不要“先出 DMG 再补签下来”：那会得到与 pkg 不一致的 DMG。若确实只能在打包后补签，必须重签 app 并**重新生成** DMG。

任何一步失败都应让发布流程失败，不能发未签名产物。

**凭据卫生**：`.p12`、`.p8`、App 专用password、notarytool keychain profile 只存 CI secrets 与本地钥匙串，**禁止提交**；发布前跑 `pnpm check:secrets`（本仓库已有脚本）。

## 7. 与 SSH 功能的对应关系

| 阶段 | 依赖 |
|---|---|
| 现在 | 功能可见但禁用（`backendAvailable=false`） |
| T4 macOS helper | 需要 Developer ID Application 证书；开发期可用 `SHRINKDROP_SSH_DEV=1` 手动装 LaunchDaemon 验证，但**不能作为发布候选** |
| T8 打包 | helper 与 app 同 Team ID 签名、hardened runtime、pkg 用 Installer 证书、公证与 staple |
| 发布（签名路线） | Gate G3 通过：`codesign --verify --strict` + `spctl -t install` + `stapler validate` 全绿 |
| 发布（不签名路线） | 不满足签名轨的 G3，按 `plan.md` 的 **G3b** 验收：干净 VM 上 macOS 显示只读状态且无 helper 残留、Windows 能装能连、README 的 Gatekeeper/SHA256 步骤可复现（见第 9 节） |

## 8. 你可能要现在决定的事

1. 走**个人**还是**组织** Developer Program？（组织要 D-U-N-S，周期更长）
2. 公证凭据用 Apple ID 专用password还是 App Store Connect API Key？（只做本地发布可以先用前者）
3. DMG 是否与 pkg 一起公证？（推荐一起；否则 README 要标 DMG 不推荐）
4. Windows 签名是现在买证书，还是先用 Azure Artifact Signing / 暂不签（SSH 在 Windows 上继续可用，只是 SmartScreen 提示）？

## 9. 不签名时怎么办（降级方案）

结论：**两个平台都不签名，Windows 功能不受影响，macOS 需要降级**。下面是可以直接采用的形态。

### 9.1 硬约束（macOS）

`SMAppService.daemon(...)` 有几条硬条件，缺一条就注册不了：

1. app 与 helper 必须用**同一 Team ID 的 Developer ID** 签名（Apple 签发）；
2. plist 必须在 app 内的 `Contents/Library/LaunchDaemons`，文件名与 `Label` 一致；
3. app 不能从 DMG / translocation 路径运行，必须在 `/Applications` 之类稳定位置；
4. 公证不是注册前提（社区实测：Developer ID 签名但未公证，`register()` 仍能成功并拉起 daemon，见 <https://github.com/jherskovic/iSCSI/blob/main/docs/daemon-registration.md>），但分发仍要过 Gatekeeper。

因此：

- ad-hoc 签名（`codesign -s -`）、自签名证书都**没有 Team ID**，注册失败（DTS 明确说 ad-hoc 会出问题）。
- 免费 Apple ID 的 “Apple Development / Personal Team” 证书有 Team ID，但过期快、不能分发给别人，不是发布路径。
- **没有 Developer ID 证书就无法通过 SMAppService 注册/分发 helper**（开发模式手动装见 §9.4），也就没有发布可用的、无需每次授权的应用内开关。

### 9.2 macOS 降级方案 A（推荐）：只读状态 + 手动引导

不需要任何特权、不依赖签名，功能边界清楚：

- **状态判定写成三态**，避免“假阳性已开启”：
  - **已开启**：`launchctl print system/com.openssh.sshd` 成功，或 22 的监听进程确认为本机 sshd；
  - **未开启**：明确 `not found`，或端口拒绝连接；
  - **未知**：权限错误、端口被其它进程占用、读不到 host key —— 显示“无法确认”，不显示“已开启”。
  - 本机 macOS 26.2 手动试过：job 未加载时非 root 可读 `print`；**加载后**是否同样可读、以及加载态的 `print` 输出格式，待 T0 的 M1/M3 确认（`[需核对]`）。权限失败必须与“未加载”区分。
- 显示：局域网地址、`ssh user@ip`、host key 指纹（读 `/etc/ssh/ssh_host_*_key.pub`，读不到就不显示指纹）。
- 开关位置改为按钮：“打开共享设置” → 深链 `x-apple.systempreferences:com.apple.Sharing-Settings.extension`，失败时退回文字步骤（`系统设置 → 通用 → 共享 → 远程登录`），附一句说明“macOS 需要你手动开启一次”。
- 状态卡写“由系统设置管理，应用只读”；**不显示可用的开关**。
- **设置语义**：只读模式不写 `settings.ssh.enabled`，`ssh_*` 写操作一律返回 `helper_unavailable`（或新增 `read_only` 状态），`ssh_status` 只返回探测结果，避免重启后 UI 与系统不一致。
- 代价：不能一键开启/关闭；退出应用不会自动关；用户要去系统设置点两下。

### 9.3 macOS 降级方案 B：每次操作弹管理员授权（可选）

用 `osascript ... with administrator privileges` 执行**编译期常量**的 `launchctl` 命令：

- 能实现“应用内开关”，但**每次开启/关闭都会弹系统密码框**，提示来源显示为 `osascript`，用户容易当成可疑程序；MDM/EDR 常直接拦。
- **崩溃/强杀没有兜底**：`kill -9`、崩溃、强制重启都会让已开的 sshd 一直开着，下次启动也分不清是不是自己开的（`research.md` 的规则是“保持开启 + 提示上次异常退出”）。因此这条路必须**禁用 `app` 生命周期，只留 `persistent`**，否则不满足 `plan.md` 的 DoD。
- 安全边界：`do shell script` 会经 `sh` 执行，命令串一旦有变量插值（端口、路径、用户名）就是本地提权面。要求：命令是编译期常量、用绝对路径 `/bin/launchctl`、禁止任何插值、stdout/stderr 不回显到 UI。
- 只有在“必须有一键开关、又不想买证书”时才考虑；默认关闭，让用户主动选择。`[需 T4 实测]` 提权行为与 launchctl 在该上下文下的稳定性。

### 9.4 macOS 降级方案 C：手动安装 helper（仅开发模式）

开发模式（`SHRINKDROP_SSH_DEV=1`）手动注册，仅供自测：

- plist 放 `/Library/LaunchDaemons/com.shrinkdrop.ssh-helper.plist`；
- helper 二进制留在 app 的 `Contents/Resources`（`BundleProgram=Contents/Resources/shrinkdrop-ssh-helper`），或放到 root 所有的 `/Library/PrivilegedHelperTools/`；
- 注册用 `sudo launchctl bootstrap system /Library/LaunchDaemons/com.shrinkdrop.ssh-helper.plist`（不要用已废弃的 `load`）。

**安全前提**：如果 `BundleProgram` 指向用户可写的 app bundle，任何能改 app 的本地用户都能拿到 root 执行——等于本地提权。所以只能用于开发，且 app 必须放在 root 所有的目录（如 `/Applications`）。对最终用户不提供这条路。

### 9.5 Windows：不签名照常可用

- 安装可选功能、创建/启动 `sshd`、改端口、防火墙规则都**不要求安装包或 helper 有签名**——功能本身不依赖签名。
- 但安装阶段有摩擦：`.exe` 首次运行会弹 SmartScreen“Windows 已保护你的电脑”（更多信息 → 仍要运行）；helper 的 UAC 提示会显示“未知发布者”；部分 AV/EDR 会直接拦掉未签名的服务安装。MSI 是否同样弹 SmartScreen **`[需核对]`**，写 README 前在 Windows 11 上实测一次。
- 被 WDAC / AppLocker / GPO 拦住时是**安装阶段失败**，与 SSH 能否使用无关；文案要区分“签名缺失被拦”和“策略禁止”。
- 建议 README 同时提供 `SHA256SUMS.txt` 校验步骤，让用户能确认下载完整。

### 9.6 macOS 应用本身的 Gatekeeper 摩擦（与 SSH 无关）

即使 SSH 功能降级，未签名的 app 仍要过 Gatekeeper：

- 从浏览器下载的包会带 quarantine，首次打开会被拦下。**提示文案取决于签名状态**（“无法验证开发者” / “Apple 无法检查是否包含恶意软件” / “已损坏”），写 README 前在 macOS 15 与 26 上各截一次图（`[需核对]`）。
- macOS 15+ **取消了右键打开的绕过**，必须去 `系统设置 → 隐私与安全性 → 仍要打开`，再确认一次；13/14 仍可右键打开。
- 替代：README 给 `xattr -d com.apple.quarantine /Applications/shrinkdrop.app`。前提是产物至少有 ad-hoc 签名且签名后未被改动；如果系统提示“已损坏”，**不要**引导用户删 quarantine，应让用户重装包（签名被破坏时 xattr 救不了）。
- 每次替换 app（更新）可能再次触发；发布说明里要写清楚。

### 9.7 成本对比

年化口径，不含 Azure 订阅费与身份审核的人工成本：

| 路线 | 现金成本（年化） | macOS 能力 | Windows 能力 | 额外工作 |
|---|---|---|---|---|
| 都不签 | 0 | 只读 + 手动引导 | 全功能；SmartScreen/UAC 信任提示随下载量慢慢减少 | 写 Gatekeeper/手动开启文档；不实现 T4 |
| 只签 Windows（Artifact Signing Basic） | 约 120 美元/年（另需付费 Azure 订阅 + 身份验证） | 只读 + 手动引导 | 全功能；信任提示随声誉累积减少（不保证立刻消失） | 省掉 T4；维护签名流水线 |
| 只买 Apple Developer ID | 99 美元/年 | 全功能（helper + 生命周期切换） | 全功能；仍有 SmartScreen 提示 | T4 + 签名/公证流水线 |
| 两个都签 | 约 219 美元/年（99 + 120，另需 Azure 订阅） | 全功能 | 全功能；信任提示随声誉累积减少 | 两套流水线 |

> “推荐给开源项目”的只是“都不签”这一条，**是否采用要等你确认**；两条路线各自的门禁已写进 `plan.md` 的 G3a / G3b。

> 若确定走不签名路线，需要同步改这些位置：
> - `docs/ssh/plan.md`：Task 4 标注“搁置（无 Developer ID）”，Task 8 拆成签名轨/不签名轨，风险表与 DoD 里“未签名隐藏功能”改为“只读/降级”；
> - `docs/ssh/poc.md`：G3 改为 G3a/G3b 两支；
> - `docs/ssh/helper-protocol.md`：注明 macOS 只读模式下不走 helper；
> - `README.md`：加 Gatekeeper“仍要打开”步骤、SmartScreen 步骤、SHA256 校验；
> - 本文件 §7 的发布行改为两个分支。
