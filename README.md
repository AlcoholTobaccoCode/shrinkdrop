# TinyPNG Cross Platform

基于 Vue 3 + Tauri 2 的本地图片压缩工具，同时提供 Web 入口。项目把压缩会话、任务队列和文件能力拆开，桌面端与浏览器共用同一套核心状态机。

## 当前范围

- 支持 PNG、JPG/JPEG、WebP。
- 默认在本地处理图片，不调用旧 uTools 项目的内部 Tinify 接口。
- Web 端使用浏览器原生图片解码和 Canvas 编码；Provider 接口为未来 WASM 编码器保留替换点。
- Tauri 端真实路径只保存在 Rust 状态中，前端只接触文件 ID。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm build
pnpm tauri dev
```

桌面端需要 Rust、系统 WebView 和 Tauri 2 的平台依赖。Windows 构建应在 Windows runner 上执行，macOS universal 构建应在 macOS runner 上执行。

## 隐私和限制

默认压缩过程不上传原图。浏览器不能覆盖用户本地原图，Web 端只能下载或复制压缩结果；桌面端覆盖操作需要用户确认。当前桌面文件剪贴板命令保留了明确的“不支持”错误，接入原生剪贴板插件前不能宣称复制文件已完成。

详细规则见 [docs/privacy.md](docs/privacy.md) 和 [docs/release-checklist.md](docs/release-checklist.md)。
