# 包管理器接入

日期：2026-11-04
适用版本：`0.1.6+`
目标：让 Windows/macOS 用户通过系统包管理器安装、升级、卸载 shrinkdrop，同时不改变现有 GitHub Release 分发方式。

文中 `<owner>` 指 README 与 `git remote` 使用的规范仓库所有者；复制清单时统一替换为同一值。

## 1. 当前发布产物

每个 `v*` 标签构建以下文件：

| 平台 | 文件 | 用途 |
| --- | --- | --- |
| Windows x64 | `shrinkdrop_<version>_x64-setup.exe` | 主推；NSIS 安装器，支持静默安装 |
| Windows x64 | `shrinkdrop_<version>_x64_zh-CN.msi` | 备选；WiX/MSI |
| macOS universal | `shrinkdrop_<version>_universal.pkg` | 主推；系统安装器 |
| macOS universal | `shrinkdrop_<version>_universal.dmg` | 备选；拖拽安装 |
| 全平台 | `SHA256SUMS.txt` | 校验和 |
| 全平台 | `build-info.json` | 版本、提交、构建记录 |

约束：

- 资产名包含版本号，包管理器清单必须固定到具体 URL 与 SHA256，不能依赖“latest”重定向。
- 已发布标签应视为不可变。当前 `.github/workflows/release.yml` 在重跑同一标签时会用 `--clobber` 覆盖同名资产；接入 winget/Homebrew 后，**禁止重跑已发布标签**，修复必须递增版本号。长期应移除 `--clobber` 或增加发布后冻结保护。
- 当前安装包未签名、未公证。未签名不阻止 winget 清单校验，但会触发 SmartScreen；macOS 官方 cask 还同时受 Gatekeeper 与知名度门槛限制。

## 2. 准入判断

| 渠道 | 现在能否提交 | 关键门槛 | 结论 |
| --- | --- | --- | --- |
| winget | 可以准备 | 静默安装、唯一 `PackageIdentifier`、SHA256、许可证、URL 信誉 | Windows 首选 |
| Homebrew Cask | 不能 | Gatekeeper（Developer ID 签名 + 公证）、知名度、仓库满 30 天 | 签名且指标达标后再提交 |
| Scoop | 暂缓 | 需要可移植目录或可靠的静默安装/卸载路径；当前安装器写入用户目录与注册表 | 有便携包再做 |
| Chocolatey | 暂缓 | 社区审核、可靠的静默安装/卸载、校验和；未签名可能触发用户侧 SmartScreen，但不是硬性拒绝条件 | 优先级低于 winget |

## 3. Windows：winget

### 3.1 包标识

建议：

```yaml
PackageIdentifier: ShrinkDrop.ShrinkDrop
PackageName: shrinkdrop
Moniker: shrinkdrop
Publisher: shrinkdrop
License: MIT-0
```

规则：

- `PackageIdentifier` 全局唯一；提交前先在 [winget-pkgs](https://github.com/microsoft/winget-pkgs) 搜索 `ShrinkDrop`。
- `Publisher`、`PackageName` 应与安装后“应用和功能”中的显示值一致，否则升级关联可能失败。
- 首次提交后不要改 `PackageIdentifier`；改名等于新包。

`PackageName`、`Publisher` 必须与安装后“应用和功能”的实测值一致。当前 `productName` 与默认 publisher 均为 `shrinkdrop`（全小写）；若改用 `ShrinkDrop`，先在 `tauri.conf.json` 设置 `bundle.publisher` 并重新验证，不能只改清单。

### 3.2 清单

优先只收录 NSIS `setup.exe`；MSI 作为后续可选。版本文件、默认 locale、installer 三文件结构示例：

`manifests/s/ShrinkDrop/ShrinkDrop/0.1.6/ShrinkDrop.ShrinkDrop.yaml`

```yaml
PackageIdentifier: ShrinkDrop.ShrinkDrop
PackageVersion: 0.1.6
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.12.0
```

`ShrinkDrop.ShrinkDrop.locale.en-US.yaml`

```yaml
PackageIdentifier: ShrinkDrop.ShrinkDrop
PackageVersion: 0.1.6
PackageLocale: en-US
Publisher: shrinkdrop
PublisherUrl: https://github.com/<owner>/shrinkdrop
PackageName: shrinkdrop
PackageUrl: https://github.com/<owner>/shrinkdrop
License: MIT-0
LicenseUrl: https://github.com/<owner>/shrinkdrop/blob/main/LICENSE
ShortDescription: Lightweight desktop image compressor with LAN file sharing.
Description: Compress PNG, JPEG, and WebP images locally or through the TinyPNG/TinyJPG anonymous web service, without an API key; share files over the local network.
Tags:
  - image-compression
  - png
  - jpeg
  - webp
  - tauri
ManifestType: defaultLocale
ManifestVersion: 1.12.0
```

`ShrinkDrop.ShrinkDrop.installer.yaml`

```yaml
PackageIdentifier: ShrinkDrop.ShrinkDrop
PackageVersion: 0.1.6
Platform:
  - Windows.Desktop
MinimumOSVersion: 10.0.17763.0
InstallerType: nullsoft
Scope: user
InstallModes:
  - silent
  - silentWithProgress
UpgradeBehavior: install
Installers:
  - Architecture: x64
    InstallerUrl: https://github.com/<owner>/shrinkdrop/releases/download/v0.1.6/shrinkdrop_0.1.6_x64-setup.exe
    InstallerSha256: <SHA256>
ManifestType: installer
ManifestVersion: 1.12.0
```

说明：

- Tauri 的 NSIS 安装器使用 `InstallerType: nullsoft`，winget 会自动加 `/S` 静默参数。
- `Scope` 必须与实际安装位置一致；当前 Tauri NSIS 默认按用户安装，提交前用干净的 Windows 账户验证。
- `MinimumOSVersion` 取 winget 客户端可运行的最低版本（当前 `10.0.17763.0`）。应用本身可能支持更低 Windows，但 winget 不会在这些系统上运行。
- SHA256 从 `SHA256SUMS.txt` 取，不使用自行计算的临时值。
- 若同时提交 MSI，注意 Tauri MSI 是 `perMachine`，应使用 `Scope: machine` 与 `ElevationRequirement: elevationRequired`，不能继承根级 `Scope: user`；MSI 需要管理员权限。不要在同一版本重复提交相同架构的等价安装器，除非有明确使用场景。

### 3.3 提交与升级

首次：

```powershell
winget install wingetcreate
wingetcreate new
```

按提示填入 `setup.exe` 的 Release URL、版本、标识和元数据，最后选择提交 PR。

后续版本：

```powershell
wingetcreate update ShrinkDrop.ShrinkDrop `
  --version 0.1.7 `
  --urls https://github.com/<owner>/shrinkdrop/releases/download/v0.1.7/shrinkdrop_0.1.7_x64-setup.exe `
  --submit
```

本地校验：

```powershell
# 本地清单安装默认被禁用；需管理员 PowerShell 执行一次
winget settings --enable LocalManifestFiles

winget validate --manifest .\manifests\s\ShrinkDrop\ShrinkDrop\0.1.6
winget install --manifest .\manifests\s\ShrinkDrop\ShrinkDrop\0.1.6
winget list --name shrinkdrop
```

本地清单安装不会写入 winget 源，`winget upgrade`/`winget uninstall <PackageIdentifier>` 通常找不到该包；这两项要在清单合并进 winget-pkgs 后用正式源验收。

PR 要求：

- 标题：`New package: ShrinkDrop.ShrinkDrop version 0.1.6` 或 `Update: ShrinkDrop.ShrinkDrop to version 0.1.7`
- 每个 PR 只加一个版本。
- CI 会校验 URL、HTTPS、哈希、清单 schema、静默安装与 URL 信誉。
- 首次向 winget-pkgs 提交需签署其 Contributor License Agreement（CLA）；未签会打 `Needs-CLA`，不能合并。`wingetcreate --submit` 需要 GitHub PAT 或交互登录，且 `--urls` 数量必须与 installer 节点数一致。
- 未签名不会阻止清单校验，但 SmartScreen 仍可能提示“未知发布者”；这是产品信任问题，不是 winget 特例。

## 4. macOS：Homebrew Cask

### 4.1 硬门槛

Homebrew 官方 cask 要求应用通过 Gatekeeper 检查，不能要求用户关闭 Gatekeeper 或 SIP。当前安装包未签名、未公证，**不要提交官方 cask**，否则会被拒。

需要先完成：

1. Apple Developer Program（个人或组织）。
2. Developer ID Application 证书签名 `.app`。
3. `notarytool` 公证并 stapling。
4. 用 `spctl --assess --type execute` 验证通过。

### 4.2 知名度门槛

仅签名仍不够。官方 cask 要求新包有独立于作者的公共关注度：

- 普通提交：至少 30 forks、30 watchers 或 75 stars。
- 仓库所有者/提交者自投稿：至少 90 forks、90 watchers 或 225 stars。
- 代码仓库少于 30 天通常不具备资格。

截至 2026-11-04，仓库约 1 star、0 fork，且 2026-10-23 创建；按现状即使完成签名也不能提交官方 cask。指标会变化，提交前重新核对；满 30 天且达标后再评估。

未满足官方条件时只能使用非官方 tap；Homebrew 默认不信任非官方 tap，用户还需 `brew trust`，并自行处理 Gatekeeper 提示，不适合作为正式渠道。

### 4.3 签名后的 cask 模板

`Casks/s/shrinkdrop.rb`

```ruby
cask "shrinkdrop" do
  version "0.1.6"
  sha256 "<DMG_SHA256>"

  url "https://github.com/<owner>/shrinkdrop/releases/download/v#{version}/shrinkdrop_#{version}_universal.dmg"
  name "ShrinkDrop"
  desc "Lightweight desktop image compressor with LAN file sharing"
  homepage "https://github.com/<owner>/shrinkdrop"

  livecheck do
    url :url
  end

  depends_on :macos

  app "shrinkdrop.app"

  uninstall launchctl: "com.shrinkdrop.keepawake",
            script: {
              executable: "/bin/sh",
              args: ["-c", "rm -f '/Library/LaunchDaemons/com.shrinkdrop.keepawake.plist'; rm -rf '/Library/Application Support/shrinkdrop'"],
              sudo: true,
            }

  zap trash: [
    "~/Library/Application Support/com.shrinkdrop.app",
    "~/Library/Caches/com.shrinkdrop.app",
    "~/Library/Preferences/com.shrinkdrop.app.plist",
    "~/Library/Saved Application State/com.shrinkdrop.app.savedState",
    "~/Library/WebKit/com.shrinkdrop.app",
  ]
end
```

说明：

- 优先用 DMG + `app`，不要用 PKG；PKG 需要额外的 `uninstall` 和更高的安装权限。
- `depends_on :macos` 与 Tauri 默认最低系统 10.13 一致；若设置 `bundle.macOS.minimumSystemVersion`，这里必须同步，且 `brew audit --online` 会读取 Info.plist 校验。
- 应用按需安装 root LaunchDaemon，cask 必须显式 `uninstall`；只靠 `zap trash` 清不掉 `/Library`。
- `zap` 路径须在真实安装/运行/退出后核对，尤其是 WebKit 与 Saved State；不要添加未验证的路径。
- 本地校验：

```bash
brew audit --cask --new ./Casks/s/shrinkdrop.rb
brew install --cask ./Casks/s/shrinkdrop.rb
brew uninstall --cask shrinkdrop
```

- 提交到 [homebrew-cask](https://github.com/Homebrew/homebrew-cask) 还需满足知名度与维护要求；通过 audit 不代表一定收录。

## 5. Scoop（暂缓）

当前 NSIS 安装器会写入用户目录和注册表，不是 Scoop 期望的可移植安装。直接包装会导致 `scoop uninstall` 残留，暂不提交。

满足以下任一条件后再做：

- 提供 portable `.zip`（解压即用，配置可持久化）。
- 或验证 `installer` + `/S` + `uninstaller` 能完整清理，并写清 `persist`。

未来 manifest 形态：

```json
{
  "version": "0.1.7",
  "description": "Lightweight desktop image compressor with LAN file sharing",
  "homepage": "https://github.com/<owner>/shrinkdrop",
  "license": "MIT-0",
  "architecture": {
    "64bit": {
      "url": "https://github.com/<owner>/shrinkdrop/releases/download/v0.1.7/shrinkdrop_0.1.7_x64-setup.exe",
      "hash": "<SHA256>"
    }
  },
  "installer": {
    "args": ["/S"]
  },
  "checkver": "github",
  "autoupdate": {
    "architecture": {
      "64bit": {
        "url": "https://github.com/<owner>/shrinkdrop/releases/download/v$version/shrinkdrop_$version_x64-setup.exe",
        "hash": {
          "url": "$baseurl/SHA256SUMS.txt"
        }
      }
    }
  }
}
```

该模板仅用于便携/安装器验证通过后的起点，不能直接提交。安装器写入 `%LOCALAPPDATA%` 与 `HKCU`，还需补 `uninstaller`/`persist`，并确认 Scoop 能解析 `SHA256SUMS.txt` 的格式。

## 6. 每版发布检查

- [ ] `CHANGELOG.md` 对应版本已填写
- [ ] Release 资产与 `SHA256SUMS.txt` 已生成
- [ ] winget 清单版本、URL、SHA256 与新 Release 一致
- [ ] 干净 Windows 环境完成 install/upgrade/uninstall
- [ ] 已发布标签未重跑；需要修复时已递增版本
- [ ] macOS 若仍无签名或知名度不足，跳过 Homebrew 官方 cask
- [ ] 更新本文档中的版本示例与已知限制

## 7. 参考

- winget manifest：https://learn.microsoft.com/windows/package-manager/package/manifest
- winget-pkgs：https://github.com/microsoft/winget-pkgs
- Homebrew Cask Cookbook：https://docs.brew.sh/Cask-Cookbook
- Homebrew Acceptable Casks：https://docs.brew.sh/Acceptable-Casks
- Scoop App Manifests：https://github.com/ScoopInstaller/Scoop/wiki/App-Manifests
