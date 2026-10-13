# TinyPNG Lite

一个只做图片压缩的轻量桌面客户端。界面参考 [uTools TinyPNG 插件](https://github.com/csj8520/utools-plugin-tinypng)。

## 使用

1. 选择图片、选择文件夹，或把图片/文件夹拖进窗口。
2. 点击「开始压缩」，同时处理最多5张，支持PNG、JPG、WebP，单张不超过20MB。
3. 在列表查看原始大小、结果大小和节省比例，保存单张或全部保存到所选目录。

加入图片后保持待处理，用户手动开始。处理中可以取消，失败项可以手动重试。保存失败只重试保存，压缩结果会保留；保存副本不会自动覆盖原图。

客户端直接使用 TinyPNG/TinyJPG/Tinify 匿名网页服务，无需 API key 或自用 Server。压缩图片会上传到这些厂商服务；输入格式和图片尺寸保持原样。

请求沿用参考项目的站点切换与请求头处理，最多尝试3个固定站点，总超时60秒。网页接口可能拒绝请求，列表会显示错误；点击重试仍使用匿名线路。

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

## 分支

- `codex/workbench-archive`：完整工作台，保存于提交`3b9d413`，含共享合同、Server 与历史验收。
- `codex/compress-lite`：压缩客户端。前端只保留Vue和Tauri API；Rust负责网络、文件注册、取消及原生保存。


设计与进度见 [轻量版设计](docs/lite/design.md)、[实现计划](docs/lite/plan.md)。实际验证见 [验收记录](docs/lite/verification.md)。
