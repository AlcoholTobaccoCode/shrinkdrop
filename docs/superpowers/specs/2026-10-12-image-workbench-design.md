# Image Workbench 双端工作台设计

**日期：** 2026-10-12
**状态：** 已审阅（2026-10-12，QingShan 确认 11 条决定）
**范围：** Tauri/Web 客户端 + 自用 Server + Tinify/其他图片 Provider + 本地与云端输出

## 目标

把当前“图片压缩工具”扩展成一个可组合的图片处理工作台。用户可以在本地私有模式处理图片，也可以把任务交给自用 Server，由 Server 统一编排匿名 Tinify、官方 Tinify 和其他厂商能力。第一版视觉方向采用 Editorial Canvas：图片预览是主角，操作以工作流节点组织，模式、Provider、输出位置和任务状态清晰可见。

## 已确认的产品决策

- 这是纯自用系统，允许客户端、Server 和多个客户端共用同一套服务。
- 处理位置分为本地私有和云端处理。
- 本地私有模式不得发起任何网络请求，并明确提示效果不保证与云端一致。
- 云端模式默认使用参考项目中的匿名网页接口；匿名失败后可以轮换本地配置的账号池。
- 官方模式必须使用用户选择的官方 Tinify API key，只请求官方 API，失败时不能降级到匿名接口。
- Tinify 账号池文件为项目根目录的 TinifyAccounts.json，格式兼容当前数组结构，每项包含 username 和 api_key。该文件只能由 Server 读取，不得提交 Git、打包进客户端或写入日志。
- S3、GCS 和其他 S3 兼容对象存储是可选输出目的地，不与 Provider 绑定。
- Web 端不直接持有长期对象存储凭据；由自用 Server 提供任务结果或临时上传地址。
- URL 输入只在云端模式显示；本地私有模式不显示，也不下载远程资源。
- 后续转换、缩放、裁切、兴趣区检测、元数据保留和对象存储都通过能力声明接入，不把产品结构写死在“压缩”上。

## 产品模型

每个处理任务由以下对象组成：

```text
AssetSet
  ├── source: local file | remote URL
  ├── operationChain
  │     ├── compress
  │     ├── convert
  │     ├── resize / smart-resize
  │     ├── crop / smart-crop
  │     └── metadata policy
  ├── processingPolicy: private-local | cloud
  ├── providerSelection
  └── outputDestinations
        ├── local download
        ├── overwrite original
        └── S3 / GCS / S3-compatible
```

操作链必须可序列化、可预览、可重试。Provider 负责生成图片结果，OutputDestination 负责保存结果；两者不能互相调用内部实现。

## 客户端体验

客户端采用 Editorial Canvas 布局：

- 顶部：产品名称、处理位置胶囊、Provider、当前网络/私有状态、运行任务数。
- 左侧素材栏：缩略图、相对路径、选择状态、单文件状态和失败重试入口。
- 中间画布：原图/结果图 before-after 分割预览，支持缩放、平移、透明背景棋盘格和结果尺寸信息。
- 右侧 Inspector：按操作链显示压缩、转换、缩放、裁切、兴趣区、元数据和输出目标。
- 底部队列：整体进度、成功/失败、原始体积、结果体积、节省比例、请求次数和清理状态。

本地私有模式的顶部状态必须直接显示：

```text
PRIVATE · 0 NETWORK REQUESTS
本地处理，效果不保证与云端一致
```

云端模式必须显示具体 Provider 和数据边界：

```text
CLOUD · ANONYMOUS TINIFY
图片将上传到自用 Server，再由所选 Provider 处理
```

官方模式显示账号掩码、本月次数、次数来源和最后更新时间。官方次数只有在读取到官方响应的 Compression-Count 或官方查询结果时显示数字，否则显示“用量未知”，不能伪造或推断。

## Provider 层

工作流中使用的共享类型固定如下：

```ts
type Operation =
  | { type: 'compress'; quality?: number }
  | { type: 'convert'; format: 'avif' | 'webp' | 'jpeg' | 'png' }
  | { type: 'resize'; width?: number; height?: number; fit: 'contain' | 'cover' | 'inside' }
  | { type: 'smart-resize'; width: number; height: number; focus?: 'auto' | 'center' }
  | { type: 'crop'; width: number; height: number; x?: number; y?: number }
  | { type: 'smart-crop'; width: number; height: number }
  | { type: 'metadata'; preserve: Array<'copyright' | 'gps' | 'creation-date'> };

interface OutputDestination {
  type: 'download' | 'overwrite' | 'object-storage';
  profileId?: string;
  objectKeyTemplate?: string;
}

interface UsageSnapshot {
  providerId: string;
  accountId: string;
  usedThisMonth?: number;
  limitThisMonth?: number;
  source: 'compression-count' | 'provider-query' | 'unknown';
  observedAt: string;
}

interface ImageResult {
  mime: string;
  size: number;
  width: number;
  height: number;
  bytes?: Uint8Array;
  downloadUrl?: string;
  outputId?: string;
}
```

客户端只依赖 Provider manifest 和任务 API，不直接写 Tinify URL 或 API key：

```ts
interface ImageProviderManifest {
  id: string;
  label: string;
  processing: 'local' | 'cloud';
  capabilities: {
    compress: boolean;
    convert: string[];
    resize: boolean;
    smartResize: boolean;
    crop: boolean;
    smartCrop: boolean;
    metadata: string[];
    urlInput: boolean;
    storageOutput: boolean;
  };
}

interface ImageOperationRequest {
  source: { kind: 'bytes' | 'url'; value: Uint8Array | string };
  operations: Operation[];
  destination: OutputDestination[];
}

interface ImageProvider {
  manifest: ImageProviderManifest;
  getUsage?(): Promise<UsageSnapshot>;
  execute(request: ImageOperationRequest, signal: AbortSignal): Promise<ImageResult>;
}
```

### 本地 Provider

本地 Provider 可以使用浏览器原生 Canvas 作为兼容实现，后续替换为 WASM 编码器。它只接收本地字节，不接受 URL，不调用 fetch、Axios、Tauri 网络命令或 Server。能力不足时返回明确错误，不能静默切云端。

### 匿名 Tinify Provider

Server 先调用参考项目中的匿名网页接口。匿名接口成功时任务记录 provider=anonymous-tinify、account=anonymous。匿名失败后才按账号池轮换 username/api_key；轮换次数、失败 HTTP 状态和最后使用的账号 ID 写入任务审计信息，但绝不写入原始 key。

匿名接口是网页内部接口，服务端必须配置 feature flag、超时、重试上限和关闭开关。接口失效时客户端展示“匿名线路不可用”，不把它伪装成官方 API 正常失败。

### 官方 Tinify Provider

Server 只调用官方 API 主机，使用所选账号的 API key 进行 Basic Auth。官方模式的请求路径、Host 和认证方式必须有专门的测试断言：不能包含匿名主机、匿名路径或伪造 X-Forwarded-For。官方失败只进入官方重试/失败状态，不自动切匿名。

账号池默认来自 TinifyAccounts.json；客户端只看到账号别名、掩码和 usage，不接触 key。后续可以增加账号启用、禁用、权重和冷却时间，但第一版只按稳定顺序轮换。

### 其他厂商 Provider

其他厂商通过 Server Provider 注册表接入，必须提供能力 manifest、认证方式、错误分类、用量来源、请求计数和隐私说明。客户端根据 manifest 隐藏不支持的操作，不能让用户提交 Provider 不支持的操作链。

## Server API

第一版 Server 提供版本化 HTTP API：

```text
GET  /api/v1/providers
GET  /api/v1/providers/:id/usage
POST /api/v1/jobs
GET  /api/v1/jobs/:jobId
POST /api/v1/jobs/:jobId/retry
POST /api/v1/jobs/:jobId/cancel
POST /api/v1/jobs/:jobId/outputs/:outputId/presign
```

POST /jobs 支持本地文件上传或云端 URL，但 URL 只在云端 processingPolicy 下接受。Server 先建立任务记录，再由 Provider 执行；任务状态必须包括 queued、uploading、processing、saving、completed、failed、canceled。

客户端到 Server 使用可配置的 Bearer access token。开发机 loopback 可以关闭认证；只要 Server 监听非 loopback 地址，就必须启用 token，并且客户端不得把 token 写入任务日志或分享链接。Server 访问地址和 token 属于本地运行配置，不进入生产构建产物。

Server 返回的任务信息不能包含 API key、Secret Key、完整 Authorization header 或第三方临时凭据。错误响应只返回稳定 error code、用户可读 message、provider id、retryable 和 request id。

## 输出目的地

- local download：客户端拿到结果或临时下载地址。
- overwrite original：只有 Tauri 客户端可执行，必须二次确认、同目录临时文件、flush/sync 和原子替换。
- S3/GCS/S3-compatible：Server 使用自用配置或短期授权执行上传；客户端只选择 profile、bucket/path 模板，不接触长期密钥。

Web 端在没有 Server 临时凭据或 presigned URL 时隐藏真实云存储上传按钮，并显示“需要配置自用 Server”。不能把长期 Access Key 让用户粘贴到浏览器。

## 安全和隐私

- TinifyAccounts.json 加入 .gitignore 和构建排除列表。
- Server 启动时校验账号文件结构，只在内存使用 key；日志使用 account id、username 脱敏值或 hash。
- 客户端日志、任务状态、错误 toast 和浏览器 URL 不得出现 API key。
- 本地私有模式在请求层设置 network-disabled guard；任何网络调用都必须经过 cloud session 注入的 transport。
- URL 输入显示目标主机，并在下载前显示“该 URL 内容会被 Server 获取”。
- Server 临时原图和结果文件有明确 TTL；任务结束、取消、失败和进程恢复都执行清理。
- 账号轮换、Provider 决策、失败降级、输出上传和人工确认都记录审计事件。

## 错误和用量体验

- 匿名线路失败：显示匿名线路失败，进入账号池 fallback，并展示当前尝试编号。
- 官方鉴权失败：显示账号无效或额度状态，不切匿名。
- 官方次数未知：显示“用量未知”，保留最近成功响应的时间。
- Provider 成功、输出上传失败：允许只重试输出，不重复处理图片。
- 本地模式失败：显示本地编码错误，并保持任务在本地重试，不自动转云端。
- 用户取消：取消上传、Provider 请求、下载和输出上传；迟到结果不能覆盖 canceled。
- 部分成功：按文件独立展示结果，不用一个总错误覆盖成功文件。

## 质量门禁

### 客户端

- 本地模式网络请求计数为 0，包含 URL 输入隐藏、Provider 不可替换到 cloud、重试不联网。
- 官方模式请求 Host 全部为官方 API，匿名模式才允许匿名 Host。
- 本地、匿名、官方三种模式切换不会复用错误的任务状态或临时文件。
- Editorial Canvas 在窄窗口下保持素材栏、画布和 Inspector 的可用层级。

### Server

- Provider contract tests 覆盖能力 manifest、认证边界、账号轮换、Compression-Count、超时、取消和错误分类。
- 匿名 Provider 的回归测试使用 fixture server，不在 CI 使用真实 Tinify key。
- 官方 Provider 的请求测试断言 Authorization 只存在于官方请求，key 不进入日志和响应。
- S3/GCS 使用 mock 或本地 S3-compatible fixture 验证上传、失败重试和 presigned URL。
- URL 输入测试限制协议、响应 MIME、大小、重定向和下载超时。

## 交付顺序

1. Server Provider 编排、账号池读取、请求边界和任务 API。
2. 客户端 Editorial Canvas、模式切换和本地私有 Provider。
3. 匿名 Tinify、官方 Tinify 和用量展示。
4. 操作链：转换、缩放、裁切、兴趣区、元数据。
5. S3/GCS/S3-compatible 输出和只重试输出流程。
6. URL 输入、批量任务、恢复、清理和跨端验收。

## 明确不做

- 不把长期 Tinify key 编译进客户端。
- 不让官方 Provider 自动降级匿名 Provider。
- 不在本地私有模式偷偷下载 URL 或调用云端。
- 不把所有厂商能力硬编码在一个巨型组件里。
- 不把匿名网页接口宣称成稳定官方 API。

## 审阅决定（2026-10-12，QingShan 确认）

本节优先级高于上文，冲突时以本节为准。

1. 官方 Tinify 是云端模式下的一个可选 Provider（`official-tinify`），不单独设处理模式。`processingPolicy` 仍只有 `private-local` 和 `cloud`。
2. 第一阶段范围是交付顺序的前 3 步：Server 编排加账号池加任务 API；客户端工作台加模式切换加本地 Provider；匿名和官方 Tinify 加用量展示。验收标准：Web 和 Tauri 两端都能批量添加图片、手动开始、压缩并下载结果（含 zip 全部下载）。
3. Server 用 Node 20 + TypeScript（Fastify），共享类型放 `packages/shared`，第一阶段部署在 QingShan 的电脑上。
4. 任务记录存在 SQLite（`better-sqlite3`）。
5. 本地私有模式第一版只支持 compress、convert（png/jpeg/webp）和 resize，其余操作在 manifest 中标记不支持。
6. 匿名 Tinify 只支持 compress。操作链含其他操作时返回 `OPERATION_UNSUPPORTED` 并提示改用官方线路，不自动切换。
7. 每个输出目的地分别记录状态和错误；Provider 成功、输出失败时可以只重试输出。
8. 限制：单文件不超过 20MB，全局同时处理 5 个（所有用户共享），临时文件 TTL 24 小时，单次 Provider 超时 60 秒，可重试错误最多重试 2 次。**图片加入后不自动处理，必须由用户点击“开始处理”启动**（批次先为 draft）。
9. URL 输入禁止访问 loopback、私有网段、link-local、CGNAT 和组播地址（IPv4/IPv6），锁定解析 IP 防 DNS rebinding，每次重定向重新检查，最多 3 跳。
10. 每个官方账号月度额度默认 500，可在 `TinifyAccounts.json` 中用 `monthlyLimit` 覆盖。官方没有余量查询接口，已用次数只来自 `Compression-Count` 响应头或不消耗额度的 validate 请求，拿不到时显示“用量未知”。剩余额度 = `monthlyLimit - usedThisMonth`。
11. S3、GCS 和兼容 S3 的存储配置放在 Server 本地 `server/config/storage.json`，加入 `.gitignore`；客户端只看到 profile `id` 和 `type`。配置方法写进 Server README。

### 多人共用补充

- **访问令牌**：所有 `/api/v1/*`（`/health` 除外）必须带 Bearer token。token 在 `server/config/server.json` 中按人配置 `id` 和 `label`，只存 SHA-256 哈希。只有监听 loopback 时才允许关闭认证。每个人只能看到和操作自己 token 创建的批次。
- **账号池轮换和并发锁**：选账号时挑 `remaining - inFlight` 最大的账号；每个账号维护进程内预留计数（请求前加 1，拿到真实 `Compression-Count` 后校正），避免多人并发把同一个 key 用超。额度为 0、返回 401 或 429 的账号进入冷却期并跳过。启动时、每 30 分钟和每次请求后刷新用量。

### 跟进确认（群内对齐）

- 第一阶段提供 zip 批量下载（`GET /api/v1/batches/:batchId/archive`；本地模式在前端用 `fflate` 打包）。
- 进度推送用 SSE；客户端用 fetch 读流以携带 Bearer token。Server 每 15 秒发心跳，事件格式为增量 `{ jobId, status, progress, outputs? }`，断线后客户端重拉 `GET /batches/:batchId`。
- 第一阶段不做管理员 token 和管理视图。
