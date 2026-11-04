# shrinkdrop

一个只做图片压缩的轻量桌面客户端，并内置一个局域网分享面（File Share）。

## 使用

1. 选择图片、选择文件夹，或把图片/文件夹拖进窗口。
2. 点击「开始压缩」，或开启顶部「上传自动压缩」。同时处理最多5张，支持PNG、JPG、WebP，单张不超过20MB。
3. 每行背景与底部进度线反馈上传、压缩、下载和校验状态；完成后查看原始大小、结果大小和节省比例。
4. 单张或全部保存为副本；也可点击「覆盖」或「批量覆盖」，确认后替换原始位置的图片。

自动压缩默认关闭，仅本次会话有效。开启时会立即处理列表中待开始的图片，新加入的图片自动排队；关闭后已开始的任务继续，新图片等待手动开始。处理中可以取消，失败项可以手动重试。

每次单张或批量覆盖都会弹窗提醒，取消不修改原图。批量只覆盖点击时已完成且尚未覆盖的图片，逐项反馈失败；原图被其他程序修改、移动或设为只读时，会阻止覆盖。保存或覆盖失败保留压缩结果，重试无需重新上传；已覆盖项仍可另存副本。

客户端直接使用 TinyPNG/TinyJPG/Tinify 匿名网页服务，无需 API key 或自用 Server。压缩图片会上传到这些厂商服务；输入格式和图片尺寸保持原样。

请求携带固定请求头，在厂商站点间切换，最多尝试3个固定站点，总超时60秒。网页接口可能拒绝请求，列表会显示错误；点击重试仍使用匿名线路。

## 局域网分享（File Share）

顶部「压缩 / 分享」可整卡翻面切换。两面同时挂载，翻到分享面时压缩队列继续跑，分享运行期间也可以随时切回复制结果。

1. 在分享面选择文件或文件夹，选中的内容立即开始分享。
2. 桌面显示 `http://<局域网 IP>:5421` 链接和二维码；手机与电脑连同一个 Wi-Fi，扫码或打开链接即可访问。链接模式需要在设置里手动开启「允许公开访问」。链接栏支持切换网卡和 IPv4/IPv6。
3. 访客页支持目录浏览、搜索、下载与实时刷新；图片、音视频和支持的文本文件可在条目下方展开预览，长文字可展开和收起。
4. 运行中可以继续追加文件/文件夹或移除条目；点击「停止分享」立即释放端口，旧链接失效。
5. 设置里可切换访问保护：链接直达、链接 + 6 位 PIN、账号登录（每个账号单独配置下载/上传/文字权限）。
6. 允许访客上传后可一次选择多个文件；在设置中额外开启「允许访客上传文件夹」后，支持目录选择的浏览器可上传文件夹并保留层级（发文字是独立权限）。上传项实时出现在桌面分享列表。默认写入接收目录；开启「上传后自动保存到下载目录」后，文件直接写入下载目录，自定义分组使用独立子目录，不再重复保存。桌面端可展开长文字，悬浮文件名可预览图片和支持的文本；HTML 可在源码和不执行脚本的隔离预览之间切换。
7. 设置里可添加自定义分组：默认分组在根路径，自定义分组在 `/g/<路径>`，各自独立列表与上传目录；分享面用分组标签切换。每个分组可单独设置公开访问、PIN、账号登录和上传/文字开关；账号本身是全局账号。

不做云中转，文件只在这台电脑与访问者之间传输。浏览器预览版无法开启分享。

## 远程访问（SSH）

设置里的「远程访问」分组用来开关宿主机自带的 OpenSSH Server；它不包含自研 SSH 服务、反向隧道或公网穿透。

- **Windows**（10 1809+ / 11）：可开关、可在「仅应用运行时 / 后台常驻」之间切换、可改端口（1–65535，默认 22）。开启前检测端口占用，被其它进程占用会显示端口/PID/进程名并阻止；改端口会重启 sshd，失败回滚旧端口。系统没有 OpenSSH Server 时，可去 Windows 可选功能安装，或用面板里的「官网下载」/「内置安装（随包 MSI）」。
- **macOS 13+**：未签名构建只读——显示系统「远程登录」的三态状态（已开启 / 未开启 / 无法确认），并提供「打开共享设置」按钮；开关请在 系统设置 → 通用 → 共享 → 远程登录 里操作。端口固定 22。
- 两种模式：`仅应用运行时`（应用退出或崩溃后关闭由 shrinkdrop 开启的实例）、`后台常驻`（退出后仍可连，重启后仍可连）。用户自己开的 SSH 不会被应用误关。
- 首次开启会安装辅助服务（Windows 需要一次 UAC）；标准账户只能查看状态。

限制：机器睡眠或 FileVault 未解锁时连不上；只建议在可信局域网内开启，并优先使用公钥登录。

分享卡片上的端口可直接点击修改；分享运行中改端口会重启服务，并弹出需要手动关闭的提示；旧链接随即失效。PIN 使用 Argon2id 哈希保存；账号口令按展示需求明文保存在本地设置文件里。

## 开发与构建

依赖 Node22、pnpm11、Rust 和对应平台的 [Tauri开发环境](https://v2.tauri.app/start/prerequisites/)。

```bash
pnpm install --frozen-lockfile
pnpm tauri dev
```

桌面开发只使用 `127.0.0.1:5170` 一个固定端口。`pnpm dev` 可预览界面，实际压缩和保存需运行桌面应用。

```bash
pnpm test
pnpm build
pnpm check:secrets
cargo test --manifest-path src-tauri/Cargo.toml --locked
pnpm tauri build
```

## 自动打包与下载

公共仓库的 [Desktop installers 流水线](https://github.com/AlcoholTobaccoCode/shrinkdrop/actions/workflows/release.yml) 会在推送到 `main` 或推送 `v*` 标签时自动运行，也可在 Actions 页面点击 **Run workflow** 手动触发。

普通用户请前往 [最新正式版下载](https://github.com/AlcoholTobaccoCode/shrinkdrop/releases/latest)，在 **Assets** 中直接下载 Windows x64（`.exe`、`.msi`）或 macOS 通用（`.pkg` 推荐，`.dmg` 保留拖拽安装；两者都支持 Intel 和 Apple Silicon）安装包，无需登录 GitHub。安装包暂未配置开发者签名及 macOS 公证。

每次构建先检查 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 和 `Cargo.lock` 的应用版本一致，再运行前端和 Rust 测试并生成安装包。`main` 构建保存在 Actions 的 **Artifacts**；产物名为 `shrinkdrop-<版本>-<平台>-<运行编号>-<重跑次数>`，包含安装包、`SHA256SUMS.txt` 和记录提交、版本及构建链接的 `build-info.json`。这些 Actions 产物保留 **90 天**，下载通常需要登录 GitHub。

推送与应用版本一致的 `v<版本>` 标签后，流水线会在双平台构建和校验全部成功后，自动创建并公开发布同名 GitHub Release，将四个安装包、合并的校验文件和构建信息附在 Assets 中。Release 附件不受 Actions 的 90 天保留期限制。含 `-` 的预发布版本会标记为 Pre-release，正式版本会设为 Latest。重跑同一标签会更新同名 Release 的附件。

发布新版本前先提交功能改动，在干净的 `main` 上运行：

```bash
pnpm release                         # 交互选择版本并确认
pnpm release patch --dry-run         # 预演补丁版本递增，例如 0.1.0 → 0.1.1
pnpm release minor                  # 次版本递增，例如 0.1.0 → 0.2.0
pnpm release 0.2.0-beta.1            # 指定预发布版本
pnpm release 0.2.0 --yes             # 明确版本并跳过确认
```

脚本检查远端历史、版本一致性和标签占用，同步修改上述四个版本文件，单独创建版本提交及注释标签，先把提交与标签推送到组织私仓 `org`，再剔除 `org.private` 后镜像到公共仓库并打同名标签，触发公开 Release 构建。已手动提交目标版本时，可以指定相同版本直接打标；已存在的标签会拒绝发布。设置页版本自动读取 `package.json`。

`--dry-run` 会获取远端引用并显示计划，不修改文件、提交、标签或远端分支。未提交文件、版本降级、远端有本地尚未包含的提交都会阻止发布。不要移动已发布标签，后续更新请递增版本号。

维护者也可使用 `pnpm sync:public --dry-run` 预览待同步的已提交代码，再运行 `pnpm sync:public` 确认公开同步（自动化可加 `--yes`）。组织私仓 `org/main` 是主仓，本地 `main` 跟踪它；同步只推送远端已提交的 `main`，不含本地未提交文件或标签。

`org.private` 目录只留在组织私仓：待同步区间一旦涉及该目录，公共提交会按提交重建树后重放，因此公共哈希与私仓不同（提交体带 `Source-Commit` 记录来源），公共仓库的改动只能以 patch 形式带回私仓。区间内没有私仓路径时仍按同一提交快进。公共 `main` 领先、两边历史分叉或区间含合并提交时脚本停止，不强推。公共 `main` 更新后自动打包并保留 Actions 产物，需要公开 Release 时使用 `pnpm release`。

只想重新打包公共 `main`，可在 Actions 中点击 **Run workflow**，或运行：

```bash
gh workflow run release.yml --repo AlcoholTobaccoCode/shrinkdrop --ref main
```

## 文档

设计与进度见 [轻量版设计](docs/lite/design.md)、[实现计划](docs/lite/plan.md)、[2026-10-20 交互补充](docs/lite/2026-10-20-enhancements.md)、[局域网分享设计](docs/share/design.md)。实际验证见 [本次验收](docs/lite/2026-10-20-verification.md)、[初版验收](docs/lite/verification.md)。

AI 接入调研见 [MCP 与 Skill 接入](docs/ai/mcp-and-skills.md)。远程访问见 [SSH 调研](docs/ssh/research.md)、[开发计划](docs/ssh/plan.md) 与 [故障排查](docs/ssh/troubleshooting.md)。

发布相关见 [变更日志](CHANGELOG.md)、[Changelog 规范](docs/changelog-spec.md)、[包管理器接入方案](docs/distribution/package-managers.md)。
