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
3. 访客页支持目录浏览、面包屑、搜索、单文件下载、文件夹打包 zip、图片缩略图、实时刷新与中英切换。
4. 运行中可以继续追加文件/文件夹或移除条目；点击「停止分享」立即释放端口，旧链接失效。
5. 设置里可切换访问保护：链接直达、链接 + 6 位 PIN、账号登录（每个账号单独配置下载/上传/文字权限）。
6. 允许访客上传或发文字后，上传文件写入「接收上传的目录」并实时出现在桌面分享列表；访客上传项会高亮标记，可单文件、文件夹、多选或整包 zip 手动保存。默认手动下载，也可在设置里开启「上传后自动保存到下载目录」。桌面端也能直接发文字。
7. 设置里可添加自定义分组：默认分组在根路径，自定义分组在 `/g/<路径>`，各自独立列表与上传目录；分享面用分组标签切换。每个分组可单独设置公开访问、PIN、账号登录和上传/文字开关；账号本身是全局账号。

不做云中转，文件只在这台电脑与访问者之间传输。浏览器预览版无法开启分享。

## 设置

头部齿轮打开独立设置窗口（单实例，重复点击只聚焦），修改立即生效并自动保存：

- 通用：启动时显示哪个面、语言（桌面端与访客页实时切换）
- 压缩：默认自动压缩、并发数（1~5）、保存目录
- 分享：端口、接收上传目录、访问保护、PIN、账号与权限、允许上传/发文字
- 关于：版本与数据说明

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

普通用户请前往 [最新正式版下载](https://github.com/AlcoholTobaccoCode/shrinkdrop/releases/latest)，在 **Assets** 中直接下载 Windows x64（`.exe`、`.msi`）或 macOS 通用（`.dmg`，支持 Intel 和 Apple Silicon）安装包，无需登录 GitHub。安装包暂未配置开发者签名及 macOS 公证。

每次构建先检查 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 和 `Cargo.lock` 的应用版本一致，再运行前端和 Rust 测试并生成安装包。`main` 构建保存在 Actions 的 **Artifacts**；产物名为 `shrinkdrop-<版本>-<平台>-<运行编号>-<重跑次数>`，包含安装包、`SHA256SUMS.txt` 和记录提交、版本及构建链接的 `build-info.json`。这些 Actions 产物保留 **90 天**，下载通常需要登录 GitHub。

推送与应用版本一致的 `v<版本>` 标签后，流水线会在双平台构建和校验全部成功后，自动创建并公开发布同名 GitHub Release，将三个安装包、合并的校验文件和构建信息附在 Assets 中。Release 附件不受 Actions 的 90 天保留期限制。含 `-` 的预发布版本会标记为 Pre-release，正式版本会设为 Latest。重跑同一标签会更新同名 Release 的附件。

发布新版本前先提交功能改动，在干净的 `main` 上运行：

```bash
pnpm release                         # 交互选择版本并确认
pnpm release patch --dry-run         # 预演补丁版本递增，例如 0.1.0 → 0.1.1
pnpm release minor                  # 次版本递增，例如 0.1.0 → 0.2.0
pnpm release 0.2.0-beta.1            # 指定预发布版本
pnpm release 0.2.0 --yes             # 明确版本并跳过确认
```

脚本检查远端历史、版本一致性和标签占用，同步修改上述四个版本文件，单独创建版本提交及注释标签，然后推送代码与标签并触发公开 Release 构建。已手动提交目标版本时，可以指定相同版本直接打标；已存在的标签会拒绝发布。设置页版本自动读取 `package.json`。

`--dry-run` 会获取远端引用并显示计划，不修改文件、提交、标签或远端分支。未提交文件、版本降级、远端有本地尚未包含的提交都会阻止发布。不要移动已发布标签，后续更新请递增版本号。

维护者也可使用 `pnpm sync:public --dry-run` 预览待同步的已提交代码，再运行 `pnpm sync:public` 确认公开同步（自动化可加 `--yes`）。运行前需要配置好脚本使用的源远端和公共远端；完整方向、前置提交步骤及失败处理见 `pnpm sync:public --help`。同步只快进更新公共 `main`，不包含本地未提交文件或标签；历史分叉会停止。公共 `main` 更新后自动打包并保留 Actions 产物，需要公开 Release 时使用 `pnpm release`。

只想重新打包公共 `main`，可在 Actions 中点击 **Run workflow**，或运行：

```bash
gh workflow run release.yml --repo AlcoholTobaccoCode/shrinkdrop --ref main
```

## 文档

设计与进度见 [轻量版设计](docs/lite/design.md)、[实现计划](docs/lite/plan.md)、[2026-10-20 交互补充](docs/lite/2026-10-20-enhancements.md)、[局域网分享设计](docs/share/design.md)。实际验证见 [本次验收](docs/lite/2026-10-20-verification.md)、[初版验收](docs/lite/verification.md)。
