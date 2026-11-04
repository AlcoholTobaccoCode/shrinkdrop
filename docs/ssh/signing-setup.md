# 签名与公证获取（macOS Developer ID / Windows Authenticode）

日期：2026-11-04
状态：未配置（当前安装包未签名、未公证）
关联：`docs/ssh/plan.md` 的 Task 8、Gate G3；`docs/distribution/package-managers.md`

SSH 功能对签名是**硬依赖**，不是“发布前再补”的优化项：

- macOS helper 走 `SMAppService.daemon`，helper 与主 app 必须**同一 Team ID** 签名，否则注册直接失败。
- 未签名/临时签名的包无法公证，Gatekeeper 会拦；helper 也无法作为发布候选。
- Windows helper 可以未签名安装，但 SmartScreen/AV 会拦，企业环境更容易被策略挡住。

在拿到证书之前，SSH 功能保持“可见但禁用”（已定），不会假装可用。

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
| Azure Trusted Signing | 微软云签名，按次计费 | 便宜，但对组织资质与历史有要求 |
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
| 发布 | Gate G3 通过：`codesign --verify --strict` + `spctl -t install` + `stapler validate` 全绿；未签名构建不发布 SSH 功能 |

## 8. 你可能要现在决定的事

1. 走**个人**还是**组织** Developer Program？（组织要 D-U-N-S，周期更长）
2. 公证凭据用 Apple ID 专用password还是 App Store Connect API Key？（只做本地发布可以先用前者）
3. DMG 是否与 pkg 一起公证？（推荐一起；否则 README 要标 DMG 不推荐）
4. Windows 签名是现在买证书，还是先用 Azure Trusted Signing / 暂不签（SSH 在 Windows 上继续禁用或提示 SmartScreen）？
