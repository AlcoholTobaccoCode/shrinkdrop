# 客户端状态与操作链数据结构草案（瞌睡虫）

> 2026-10-12 · 依据：工作台设计规格、`server-api-draft.md`（4.1–4.6）、现有 `src/core`。只读快照，未改代码。

## 1. 现状梳理
- 技术栈：Vue 3 + Vite + TS，Tauri 端经 `src/platform/{web,tauri}` 的 `FileAdapter` 抽象读写文件。
- `CompressionSession`（`src/core/compression/session.ts`）：`addFiles()` 只建任务，`run()` 才执行。**手动启动的语义已经具备**，UI 层改成按钮触发即可。
- `TaskQueue`：可取消的并发队列，默认并发 3 → 改为 5（可配置）。
- `CompressionTask` 只有单一 `output`，状态 `pending/reading/compressing/writing/completed/failed/canceled`；`CompressionProvider` 只有 `compress()`，没有操作链概念。
- 结论：队列和取消机制可复用；任务模型、Provider 接口需要升级为“操作链 + 多输出”。

## 2. 核心类型（放 `packages/shared`，与 Server 共用）
直接复用规格里的 `Operation`、`OutputDestination`、`UsageSnapshot`、`ImageProviderManifest`，以及无敌王八 4.3 的 `Job`、4.6 的错误码。客户端新增：

```ts
type JobStatus = 'draft' | 'queued' | 'uploading' | 'processing' | 'saving'
               | 'completed' | 'failed' | 'canceled';   // 与 Server 4.2 完全一致
// 本地模式映射：reading→uploading（读文件），compressing→processing，writing→saving

interface Pipeline {                 // 操作链 = 一个批次的处理方案
  providerId: 'local' | 'anonymous-tinify' | 'official-tinify' | string;
  operations: Operation[];           // 有序，按顺序执行
  destinations: OutputDestination[];
}

interface WorkbenchItem {            // 客户端视角的一张图（本地/云端统一）
  id: string;                        // 本地 uuid；云端 = jobId
  batchId: string;
  mode: 'private-local' | 'cloud';
  source: { kind: 'file'; file: SourceFile; previewUrl: string }
        | { kind: 'url'; url: string };
  status: JobStatus;
  progress: number;                  // 0–1，SSE 或本地回调更新
  attempts: number;
  input?: { mime: string; size: number; width: number; height: number };
  result?: { mime: string; size: number; width: number; height: number; savedRatio: number;
             previewUrl?: string };  // 中间对比区使用
  outputs: OutputState[];            // 每个目的地分别记录（第 7 条）
  error?: { code: ErrorCode; message: string };
}

interface OutputState {
  outputId: string;
  destination: OutputDestination;
  status: 'pending' | 'saving' | 'completed' | 'failed';
  url?: string; error?: { code: ErrorCode; message: string };
}

interface Batch {
  id: string; mode: 'private-local' | 'cloud';
  pipeline: Pipeline;
  status: 'draft' | 'running' | 'done';   // draft 时不自动处理（第 8 条）
  itemIds: string[];
}
```

## 3. 前端 Store（Pinia）
- `workbenchStore`：`batches`、`items`（Map）、`selectedItemId`、`activePipeline`；动作 `addFiles / addUrls / startBatch / cancel / retry(scope) / remove`。
- `providerStore`：`GET /providers` 拿 manifest，按 `capabilities` 禁用不支持的操作；匿名线路选了非 compress 操作时，直接提示“请改用官方线路”（不自动切换，与 Server 422 `OPERATION_UNSUPPORTED` 一致）。
- `usageStore`：官方额度，`source: 'unknown'` 时显示“未知”，不显示数字。
- `settingsStore`：Server 地址、访问令牌（Tauri 存系统钥匙串，Web 存 sessionStorage，不进 localStorage）、默认操作链。

四个区域绑定：左素材 = `items`；中对比 = `selectedItem.source/result`；右操作面板 = `activePipeline` + “开始处理”按钮（`batch.status==='draft'` 时可点）；底部队列 = 按 status 分组。

## 4. 执行层
```ts
interface Executor {                 // 本地与云端同一套接口
  start(batch: Batch, items: WorkbenchItem[]): void;
  cancel(itemId: string): void;
  retry(itemId: string, scope: 'all' | 'outputs'): void;
}
```
- `LocalExecutor`：复用 `TaskQueue`（并发 5），Canvas 执行 compress / convert(png|jpeg|webp) / resize；其他操作在 manifest 中标记不支持（第 5 条）。全程不发网络请求。
- `CloudExecutor`：按 4.1 流程 `POST /batches → /items → /start`，进度走 SSE。

## 5. 回复第 6 节待确认
1. **zip 打包**：赞成第一阶段做，前端只需一个“全部下载”按钮调 `/batches/:id/archive`。本地模式在前端用 `fflate` 打包。
2. **SSE**：Web 端没问题。Tauri 的 WebView 也支持 `EventSource`，但**原生 EventSource 不能带 Bearer 头**。建议二选一：
   - SSE 端点支持 `?token=` 短期票据（先 `POST /events/ticket` 换一个 60 秒有效的票据），或
   - 前端用 `fetch` + ReadableStream 读 SSE（可带头，我来封装）。
   我倾向第二种，Server 不用改；需要 Server 每 15 秒发心跳注释，断线后支持 `Last-Event-ID` 续传或我重连后全量拉一次 `GET /batches/:id`。
3. 管理员 token：前端第一阶段不做管理视图，Server 侧按需。

## 6. 需要对齐的点
- Server 在 SSE 事件里推送什么：建议 `{ jobId, status, progress, outputs? }` 增量。
- 上传进度：multipart 上传时 `uploading` 的进度由前端 XHR 计算，Server 不用推。
- 本地 Provider 的 id 定为 `local`，manifest 在客户端内置，不从 Server 取。
