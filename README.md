# TinyPNG Lite

一个只做图片压缩的轻量桌面客户端。界面参考 [uTools TinyPNG 插件](https://github.com/csj8520/utools-plugin-tinypng)。

## 使用

1. 选择图片、选择文件夹，或把图片/文件夹拖进窗口。
2. 点击「开始压缩」，或开启顶部「上传自动压缩」。同时处理最多5张，支持PNG、JPG、WebP，单张不超过20MB。
3. 每行背景与底部进度线反馈上传、压缩、下载和校验状态；完成后查看原始大小、结果大小和节省比例。
4. 单张或全部保存为副本；也可点击「覆盖」或「批量覆盖」，确认后替换原始位置的图片。

自动压缩默认关闭，仅本次会话有效。开启时会立即处理列表中待开始的图片，新加入的图片自动排队；关闭后已开始的任务继续，新图片等待手动开始。处理中可以取消，失败项可以手动重试。

每次单张或批量覆盖都会弹窗提醒，取消不修改原图。批量只覆盖点击时已完成且尚未覆盖的图片，逐项反馈失败；原图被其他程序修改、移动或设为只读时，会阻止覆盖。保存或覆盖失败保留压缩结果，重试无需重新上传；已覆盖项仍可另存副本。

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

- `main`：轻量压缩客户端，当前默认分支。前端只保留Vue和Tauri API；Rust负责网络、文件注册、取消及原生保存。
- `codex/workbench-archive`：完整工作台，保存于提交`3b9d413`，含共享合同、Server 与历史验收。日常开发不基于此分支。

更早的 10-10 骨架已归档为标签 `archive/pre-batch-split`，不再作为分支维护。


设计与进度见 [轻量版设计](docs/lite/design.md)、[实现计划](docs/lite/plan.md)、[2026-10-20 交互补充](docs/lite/2026-10-20-enhancements.md)。实际验证见 [本次验收](docs/lite/2026-10-20-verification.md)、[初版验收](docs/lite/verification.md)。
