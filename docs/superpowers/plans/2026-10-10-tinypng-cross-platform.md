# Tinypng 跨端压缩工具 Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 基于现有 uTools 图片压缩项目的交互经验，重建一个共享 Vue 业务层、Tauri 2 桌面端和 Web 端共用的图片压缩工具，支持 macOS、Windows 和浏览器。

**Architecture:** 将压缩任务状态、队列、取消、重试、统计和 Provider 契约放进不依赖平台 API 的 TypeScript 核心层。Tauri 端通过显式文件适配器访问本地文件，Web 端通过浏览器 File API 工作，UI 只依赖平台无关的命令接口。MVP 默认使用本地图片编码 Provider，避免依赖旧项目中 Tinify 未公开接口；官方云压缩 Provider 作为后续可插拔实现。

**Tech Stack:** Vue 3、Vite、TypeScript、Tauri 2、Rust、Vitest、Playwright、pnpm、浏览器原生图片编码器；WASM 编码器作为可替换实现。

---

## 约束与验收口径

- [ ] 桌面端使用 Tauri 2，不引入 Electron。
- [ ] UI、任务状态和压缩 Provider 契约可在浏览器运行，不直接导入 Tauri API。
- [ ] 桌面端文件操作全部经过 Tauri capability 和 Rust/插件适配层。
- [ ] 默认压缩过程在本地完成，原图不会上传第三方服务。
- [ ] 支持 PNG、JPEG/JPG、WebP；HEIC、GIF、SVG 在 MVP 中给出明确的不支持原因。
- [ ] 文件、目录、拖拽、取消、失败、重试、空状态和部分成功都有完整反馈。
- [ ] 覆盖原图必须确认，使用临时文件后原子替换，失败不能提示成功。
- [ ] 目录扫描不阻塞 UI，支持取消扫描、跳过符号链接和隐藏目录。
- [ ] 核心逻辑有单元测试，Web 有真实浏览器测试，Tauri 至少完成 macOS 和 Windows 冒烟验证。
- [ ] 完成的 Todo 项必须在本文件及时勾选，并写出验证证据。

## 目标目录结构

    tinypng-cross-platform/
    ├── docs/superpowers/plans/2026-10-10-tinypng-cross-platform.md
    ├── src/
    │   ├── core/
    │   │   ├── compression/{types.ts,provider.ts,session.ts,stats.ts}
    │   │   ├── files/contracts.ts
    │   │   └── queues/task-queue.ts
    │   ├── platform/{index.ts,web,tauri}
    │   ├── stores/compression-store.ts
    │   ├── components/
    │   ├── App.vue
    │   └── main.ts
    ├── src-tauri/{src,capabilities,tauri.conf.json}
    ├── tests/{core,e2e}
    ├── package.json
    ├── vite.config.ts
    └── vitest.config.ts

## Task 1: 建立项目骨架和质量门禁

**Files:**
- Create: package.json, pnpm-workspace.yaml, vite.config.ts, vitest.config.ts, tsconfig.json, .gitignore
- Create: src/main.ts, src/App.vue, src/platform/index.ts

- [x] Step 1: 声明 Vue、Vite、TypeScript、Vitest、Playwright、Tauri 2 前端插件和本地图片编码 Provider 依赖；脚本包含 dev、build、test、test:e2e、tauri。
- [x] Step 2: 让 src/main.ts 只创建 Vue 应用，平台能力通过 src/platform/index.ts 注入；App.vue 和 src/core 禁止直接导入 Tauri API。
- [x] Step 3: 开启 strict、noUncheckedIndexedAccess、noUnusedLocals，执行：

    pnpm install --frozen-lockfile
    pnpm build

    结果：pnpm v11.3.0 安装成功，pnpm build 通过。
- [x] Step 4: 已提交 b52282d：

    git add package.json pnpm-workspace.yaml vite.config.ts vitest.config.ts tsconfig.json .gitignore src
    git commit -m "feat(项目骨架): ✨ 建立 Tauri 与 Web 共用的 Vue 工程"

## Task 2: 定义平台无关的文件与压缩契约

**Files:**
- Create: src/core/files/contracts.ts
- Create: src/core/compression/types.ts, src/core/compression/provider.ts, src/core/compression/stats.ts
- Test: tests/core/contracts.test.ts

- [x] Step 1: 先写测试，覆盖 pending 初始状态、canceled 终态、用户可读错误和只统计成功任务的压缩体积。
- [x] Step 2: 定义 FileAdapter，方法必须包含 chooseFiles、chooseDirectory、read、writeTemp、copyToClipboard、replaceOriginal、cleanup。SourceFile 至少包含 id、name、size、mime、relativePath，不能把真实路径暴露给 Web UI。
- [x] Step 3: 定义 Provider：

    export interface CompressionProvider {
      compress(input: Uint8Array, options: CompressionOptions, signal: AbortSignal): Promise<CompressionOutput>;
    }

    CompressionOutput 必须包含 bytes、mime、size、width、height、ratio；Provider 不能自行写磁盘。
- [x] Step 4: 执行 pnpm vitest run tests/core/contracts.test.ts，4 条通过；完整核心回归共 14 条通过。

## Task 3: 实现可取消、可重试的压缩会话

**Files:**
- Create: src/core/compression/session.ts, src/core/queues/task-queue.ts
- Modify: src/core/compression/types.ts
- Test: tests/core/session.test.ts, tests/core/task-queue.test.ts

- [x] Step 1: 写测试验证并发上限 3、任务异常不阻塞后续任务、取消后不再标记成功。
- [x] Step 2: TaskQueue 接收任务函数而不是已启动 Promise，调用形式为：

    queue.add(({ signal }) => provider.compress(bytes, options, signal));

- [x] Step 3: 写状态机测试，覆盖 pending -> reading -> compressing -> writing -> completed、任意阶段到 failed、运行中到 canceled，以及迟到异步结果不能覆盖终态。
- [x] Step 4: CompressionSession 统一负责状态迁移、AbortController、重试次数、单任务错误和总体统计；文件读取、Provider、写入通过接口注入。
- [x] Step 5: 执行：

    pnpm vitest run tests/core/session.test.ts tests/core/task-queue.test.ts

## Task 4: 实现本地图片编码 Provider

**Files:**
- Create: src/platform/web/image-provider.ts, src/core/compression/options.ts
- Test: tests/core/image-provider.test.ts

- [x] Step 1: 固定 MVP 使用浏览器原生 Canvas 编码 PNG、JPEG/JPG、WebP；Provider 接口保留 WASM 编码器替换点，其他格式返回稳定错误码 UNSUPPORTED_FORMAT。
- [x] Step 2: 编码前、解码后、编码后检查 AbortSignal；取消抛出 CompressionCanceledError，由会话转成 canceled。
- [x] Step 3: 在 CompressionOptions 中定义单文件上限、批量数量上限和最大像素数，超限在读取前返回可读错误。
- [ ] Step 4: 使用测试图片验证输出可重新解码，执行 pnpm vitest run tests/core/image-provider.test.ts。

## Task 5: 实现 Web 文件适配器和浏览器流程

**Files:**
- Create: src/platform/web/file-adapter.ts
- Create: src/components/FileDropZone.vue, CompressionList.vue, CompressionItem.vue, CompressionSummary.vue
- Modify: src/App.vue
- Test: tests/e2e/web-compression.spec.ts

- [x] Step 1: 普通文件使用 input type=file multiple；目录选择只有在能力检测通过时启用 webkitdirectory；不支持拖拽目录时显示明确提示。
- [x] Step 2: Web 端使用 Uint8Array 和 Blob；下载用一次性 Object URL，下载和会话销毁时释放 URL。
- [x] Step 3: 每项显示原始大小、压缩大小、节省比例、进度、取消、重试、下载；整体显示成功、失败和总节省空间。
- [x] Step 4: 独立实现没有文件、格式不支持、全部失败、部分成功和用户取消状态。
- [ ] Step 5: 执行：

    pnpm dev --host 127.0.0.1
    pnpm playwright test tests/e2e/web-compression.spec.ts

    验证桌面宽度、窄屏、拖拽、选择、取消、重试、下载和控制台无未处理异常。

## Task 6: 实现 Tauri 文件适配器和安全能力配置

**Files:**
- Create: src-tauri/src/file_ops.rs, src-tauri/src/commands.rs, src-tauri/src/lib.rs
- Create: src-tauri/capabilities/default.json
- Create: src/platform/tauri/file-adapter.ts, src/platform/tauri/notification-adapter.ts
- Modify: src/platform/index.ts
- Test: tests/core/tauri-contract.test.ts

- [x] Step 1: 已建立 Tauri 2 工程骨架，开发端口与 Vite 5173 对齐；macOS/Windows 共用同一套 Vue 页面。
- [x] Step 2: capability 只给主窗口 core:default 和 dialog:default，未授予全盘 fs 权限。
- [x] Step 3: Rust 端递归扫描目录，跳过符号链接、隐藏目录和不支持扩展名；真实路径只留在 Rust 状态。
- [x] Step 4: 文件先写入同目录临时文件并 flush/sync，再原子替换；失败返回结构化错误。
- [x] Step 5: 临时结果按任务相对路径记录；窗口销毁和会话清理都能删除临时文件。文件剪贴板命令暂时明确返回不支持。
- [ ] Step 6: 执行 pnpm tauri dev 和 pnpm tauri build --debug。两个平台验证选择文件、目录、拖拽、取消扫描、压缩、复制、覆盖和退出清理。

## Task 7: 统一 UI 状态、可访问性和平台差异

**Files:**
- Modify: src/components/FileDropZone.vue, CompressionList.vue, CompressionItem.vue, CompressionSummary.vue
- Create: src/styles/tokens.css
- Test: tests/e2e/accessibility.spec.ts

- [x] Step 1: 集中定义颜色、间距、圆角、字号和成功/警告/错误状态，并建立基础视觉层级。
- [x] Step 2: 可操作元素最小触控区域 44px，按钮有中文可读名称，进度条提供无障碍属性。
- [x] Step 3: 桌面窄窗口、Web 移动宽度使用响应式布局，避免列表横向溢出。
- [ ] Step 4: 执行 pnpm playwright test tests/e2e/accessibility.spec.ts，验证按钮名称、键盘焦点、错误提示关联和窄屏布局。

## Task 8: 构建、签名和发布准备

**Files:**
- Create: .github/workflows/ci.yml, .github/workflows/release.yml
- Modify: src-tauri/tauri.conf.json
- Create: README.md, docs/privacy.md, docs/release-checklist.md

- [ ] Step 1: CI 执行 pnpm install --frozen-lockfile、pnpm build、pnpm test、pnpm test:e2e。
- [ ] Step 2: 至少构建 macOS universal 和 Windows x64，产物文件名包含版本、平台和架构。
- [ ] Step 3: 隐私文档明确默认本地压缩、不上传原图；云 Provider 必须说明上传对象、保存时间、重试和删除策略。
- [ ] Step 4: 发布清单覆盖版本号、安装包启动、文件权限、签名、自动更新、临时文件清理、断网错误、升级覆盖和卸载。

## 后续 Provider 扩展

MVP 的 CompressionProvider 保留远程 Provider 扩展位，但不接旧项目的 Tinify 内部路径 /backend/opt/shrink。

远程 Provider 必须满足：

- 只调用官方、稳定、可授权的 API。
- API 密钥只放服务端或系统安全存储，不能进入 Web bundle。
- 区分网络错误、限流、鉴权失败和格式不支持。
- 上传前显示隐私提示，下载后清理远程任务或临时 URL。
- 有独立契约测试，禁止 Web 端直连第三方内部接口。

## 计划自检

- [ ] 所有平台差异都通过 FileAdapter、CompressionProvider 或通知适配器处理。
- [ ] 没有任务依赖旧项目的 utools 全局对象。
- [ ] 没有任务依赖旧项目的 /backend/opt/shrink 内部接口。
- [ ] 取消、重试、覆盖、复制、清理和错误提示都有测试或人工验收步骤。
- [ ] 每个代码任务都包含文件边界、验证命令和预期结果。
