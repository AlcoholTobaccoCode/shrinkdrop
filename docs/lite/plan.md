# shrinkdrop Implementation Plan

> For agentic workers: Use subagent-driven-development or executing-plans; steps use checkbox tracking.

**Goal:** 只提供图片压缩的无key、无Server轻量桌面客户端。
**Architecture:** Vue紧凑列表+会话任务队列，Rust匿名HTTP压缩与原生文件保存，接口见design.md。
**Tech Stack:** Vue3、Tauri2、reqwest、Vitest、Rust tests。

## Task 1 原生匿名压缩与文件保存

Files: src-tauri/src/*.rs、src-tauri/Cargo.toml/Cargo.lock。其他源由前端任务负责，不交叉。
- [x] 测试先行：取消先于注册、固定下载主机/路径、输出损坏拒绝、全局5、失败有限站点切换、重复保存名与原图保护。
- [x] 实现design.md中的IPC；reqwest头与厂商路由使用当前实测201方式，取消drop请求future，60s总超时。
- [x] 原生拖放注册后发事件；移除token、覆盖/剪贴板旧命令。
- [x] cargo test、cargo check通过；使用合成PNG真实匿名压缩，结果验证类型、尺寸和字节。

## Task 2 轻量列表客户端

Files: src/**、tests/**。原生源不改。
- [x] 测试先行：导入仅draft、手动Start、5并发、取消迟到、手动重试、保存失败不再调用compress。
- [x] 实现types/native adapter/session、App和紧凑行组件；本机会话不持久化，复用已验证TaskQueue。
- [x] 单图保存与整批保存，失败与取消反馈，图片缩略图URL清理，native drop事件对齐。
- [x] 类型、Vitest、生产构建通过；浏览器预览标明桌面才能执行。

## Task 3 删除无关模块与依赖

Files: package.json/pnpm-lock.yaml/pnpm-workspace.yaml、server/**、packages/**、旧docs、scripts、CI与Tauri配置。
- [x] 移除Server和shared工作区、Pinia/Reka/fflate/旧工作台配置与文档，保留归档分支可恢复；keyring由原生任务移除。
- [x] 固定开发端口5170，窗口约820x640，最小600x420，CSP仅本机IPC、图像blob/data；网络由Rust负责。
- [x] pnpm install --frozen-lockfile、build、测试、敏感内容扫描与diff检查通过；原图账号文件保持Git忽略。

## Task 4 审查和实际验收

- [x] 对照design做规格审查，随后质量审查，修复发现的问题。
- [x] 新App真实两图手动压缩、取消/重试、选择保存目录和单图保存可用，记录PNG/JPG/WebP结果与大小。
- [x] 更新README与验收记录，勾选已验证事项；停止开发与测试端口。
- [x] 提交轻量分支，保留本地，不推送。
