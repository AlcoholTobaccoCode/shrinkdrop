# Server API v0.2（第一阶段定稿）

负责人：无敌王八 · 日期：2026-10-12 · 依据：`2026-10-12-image-workbench-design.md` 加群里确认的 11 条决定

## 1. 技术栈与运行
- Node 20 + TypeScript，HTTP 框架用 Fastify（自带 schema 校验、multipart、性能好）。
- 任务存储用 SQLite（`better-sqlite3`），临时文件放 `server/data/tmp/`，TTL 24 小时。
- 共享类型放 `packages/shared`（`Operation`、`OutputDestination`、`UsageSnapshot`、`Job` 等），客户端和 Server 共用。
- 本地配置都不进仓库：`TinifyAccounts.json`、`server/config/storage.json`、`server/config/server.json`。

## 2. 认证
- 所有 `/api/v1/*` 请求带 `Authorization: Bearer <token>`。
- `server.json` 里配置 token 列表，每个 token 带 `id` 和 `label`（比如 `qingshan`、`teammate-a`），用于审计和按人统计；token 只保存 SHA-256 哈希。
- 只监听 loopback 时可以设 `auth.disabled=true`；监听非 loopback 地址时强制开启，启动时检查。
- 缺 token 或 token 错误时返回 401 `AUTH_REQUIRED` / `AUTH_INVALID`。

## 3. 通用约定
- 错误体：`{ code, message, providerId?, retryable, requestId }`，响应头带 `X-Request-Id`。
- 任何响应、日志里都不出现 API key、Secret 或完整 Authorization。账号只用 `accountId`（username 的哈希前 8 位）和掩码 `ab***@x.com` 表示。
- 时间统一用 ISO 8601 UTC。

## 4. 接口列表

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/v1/health | 健康检查，不需要认证 |
| GET | /api/v1/providers | Provider manifest 列表 |
| GET | /api/v1/providers/:id/usage | 账号池额度 |
| POST | /api/v1/providers/:id/usage/refresh | 主动刷新额度 |
| GET | /api/v1/storage/profiles | 可用的对象存储 profile（只返回 id 和 type） |
| POST | /api/v1/batches | 创建批次（草稿，不开始处理） |
| POST | /api/v1/batches/:batchId/items | 往批次里加图片（上传文件或填 URL） |
| DELETE | /api/v1/batches/:batchId/items/:jobId | 删除还没开始处理的图片 |
| POST | /api/v1/batches/:batchId/start | **手动启动**处理 |
| GET | /api/v1/batches/:batchId | 批次和其中任务的状态 |
| GET | /api/v1/batches/:batchId/events | SSE 进度推送 |
| GET | /api/v1/jobs/:jobId | 单个任务详情 |
| POST | /api/v1/jobs/:jobId/retry | 重试（可以只重试输出） |
| POST | /api/v1/jobs/:jobId/cancel | 取消任务 |
| POST | /api/v1/batches/:batchId/cancel | 取消整个批次 |
| GET | /api/v1/jobs/:jobId/result | 下载结果文件 |
| GET | /api/v1/batches/:batchId/archive | 把已完成的结果打包成 zip 下载 |
| POST | /api/v1/jobs/:jobId/outputs/:outputId/presign | 获取对象存储的临时链接（第一阶段不开放） |

### 4.1 手动启动流程（第 8 条）
1. `POST /batches`，请求体是 `{ providerId, operations: Operation[], destinations: OutputDestination[] }`，返回 `{ batchId, status: "draft" }`。
2. `POST /batches/:id/items`：用 multipart 上传一个或多个文件，或者传 JSON `{ urls: string[] }`。任务状态是 `draft`，不会进队列。
3. 用户点“开始处理”后调用 `POST /batches/:id/start`，所有 draft 任务变成 `queued`。
4. 全局并发 5 个（`server.json` 里的 `concurrency`），多个用户共享这个并发池。
- 创建批次时就校验操作链：匿名 Provider 只要包含非 `compress` 的操作，就返回 422 `OPERATION_UNSUPPORTED`，并附上 `suggestProviderId: "official-tinify"`，不自动切换。

### 4.2 任务状态
`draft → queued → uploading → processing → saving → completed | failed | canceled`
- 取消后来的迟到结果直接丢弃，不覆盖 `canceled`。
- 单次 Provider 请求超时 60 秒，可重试的错误最多重试 2 次。

### 4.3 Job 结构
```ts
interface Job {
  jobId: string; batchId: string; ownerTokenId: string;
  source: { kind: 'upload'; filename: string; size: number } | { kind: 'url'; host: string };
  providerId: string; accountId?: string;       // 匿名线路是 "anonymous"
  status: JobStatus; attempts: number;
  input?: { mime: string; size: number; width: number; height: number };
  result?: { mime: string; size: number; width: number; height: number; savedRatio: number };
  outputs: Array<{ outputId: string; destination: OutputDestination;
                   status: 'pending'|'saving'|'completed'|'failed'; url?: string; error?: ApiError }>;   // 第 7 条：每个目的地分别记录
  error?: ApiError; createdAt: string; updatedAt: string;
}
```
- `retry` 请求体是 `{ scope: 'all' | 'outputs' }`。Provider 已经成功、只是输出失败时用 `outputs`，不会重复消耗额度。
- 用户只能看到和操作自己 token 创建的批次，访问别人的批次返回 404。第一阶段没有管理员 token。
- 第一阶段 `destinations` 只接受 `download`，传 `overwrite` 或 `object-storage` 返回 422 `VALIDATION_FAILED`。
- 界面上的“部分成功”和“已处理，保存失败”由 `@tinypng/shared` 里的 `deriveDisplayStatus()` 推导，Server 不新增状态。

### 4.3.1 SSE 进度推送
- `GET /batches/:id/events` 要带 Bearer 令牌，客户端用 fetch 读取流，不用 EventSource。
- 每条事件的 `event` 和 `data.type` 相同，取值是 `job`、`batch` 或 `heartbeat`，具体结构见 `BatchEvent`。`job` 事件是增量的：`{ jobId, status, progress?, outputs?, error? }`。
- 每 15 秒发一次 `heartbeat`。客户端 30 秒收不到任何事件就判定连接中断并重连，重连后先 `GET /batches/:id` 拉一次全量状态。
- 处理中可以继续往批次里加图片，新加的图片是 draft；再次调用 `/start` 只启动这些 draft。

### 4.3.2 zip 下载
- `GET /batches/:id/archive` 只打包结果已经生成的任务，文件名保持上传时的原名，重名时自动加序号；没有可打包的结果时返回 409 `INVALID_STATE`。

### 4.4 额度与账号池（第 10 条，多人共用）
`GET /providers/official-tinify/usage` 的响应：
```json
{ "accounts": [ { "accountId": "a1b2c3d4", "label": "ab***@x.com",
   "usedThisMonth": 132, "limitThisMonth": 500, "remaining": 368,
   "source": "compression-count", "observedAt": "...", "status": "active" } ] }
```
- `usedThisMonth` 只来自官方响应头 `Compression-Count`，或者 `validate` 请求（发一个空 POST /shrink，拿到 400 加计数，不消耗额度）。拿不到就是 `source: "unknown"`，不显示数字。
- `limitThisMonth` 默认 500，`TinifyAccounts.json` 里每一项可以加 `monthlyLimit` 覆盖。
- 启动时和每 30 分钟刷新一次，每次请求后也更新；`/usage/refresh` 每个账号限 1 分钟 1 次。
- 选账号：从 `remaining - inFlight` 最大的开始选。每个账号有一个进程内的预留计数（下单前加 1，拿到结果后按真实计数校正），避免多人并发同时把同一个 key 用超。剩 0 的、401 的、429 的账号进入冷却期，跳到下一个账号。
- 每月 1 号（UTC）把缓存重置为 unknown，再重新 validate。

### 4.5 URL 输入安全（第 9 条）
- 只允许 http 和 https。先解析 DNS，拒绝 loopback、私有网段、link-local、CGNAT 和组播地址（IPv4 和 IPv6 都检查），并且锁定解析出的 IP 再发请求，防止 DNS rebinding。
- 重定向最多 3 次，每一跳都重新检查；超过 20MB 就中断；必须是图片 MIME。
- 被拒时返回 422 `URL_FORBIDDEN`。

### 4.6 错误码
`AUTH_REQUIRED` `AUTH_INVALID` `VALIDATION_FAILED` `FILE_TOO_LARGE`(20MB) `UNSUPPORTED_MIME` `OPERATION_UNSUPPORTED` `URL_FORBIDDEN` `URL_FETCH_FAILED` `PROVIDER_UNAVAILABLE` `ANONYMOUS_DISABLED` `QUOTA_EXHAUSTED` `PROVIDER_TIMEOUT` `PROVIDER_ERROR` `OUTPUT_FAILED` `JOB_NOT_FOUND` `INVALID_STATE`

## 5. 配置示例
`server/config/server.json`：
```json
{ "host": "127.0.0.1", "port": 8787, "concurrency": 5,
  "maxFileBytes": 20971520, "tmpTtlHours": 24, "providerTimeoutMs": 60000, "maxRetries": 2,
  "anonymousTinify": { "enabled": true },
  "auth": { "disabled": false, "tokens": [ { "id": "qingshan", "sha256": "..." } ] } }
```
`TinifyAccounts.json` 兼容现在的数组格式，新增的字段都是可选的：`[{ "username": "...", "api_key": "...", "monthlyLimit": 500 }]`
`storage.json` 用霸王龙给的格式。

### 4.3.3 加图片的约定
- `POST /batches/:id/items` 返回 `{ jobs: Job[] }`，顺序和上传顺序一致。multipart 的字段名是 `files`，一次可以传一个或多个文件。
- 同一个 token 最多同时有 8 个上传请求，超出返回 429 `RATE_LIMITED`。客户端每次传一个文件、最多同时传 5 个没有问题。
- `job` 事件在 `completed` 时带上 `result`，客户端不用再去请求 `GET /jobs/:id`。

## 6. 已确认（v0.2）
1. zip 打包第一阶段就做，见 4.3.2。
2. SSE 用 fetch 读取，增量事件加 15 秒心跳，见 4.3.1。
3. 第一阶段不做管理员 token。
