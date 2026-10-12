# 第一阶段任务清单

负责人：pm · 日期：2026-10-12 · 依据：`specs/2026-10-12-image-workbench-design.md`（含“审阅决定”）、`specs/server-api-draft.md`、`specs/client-state-draft.md`

**第一阶段目标**：Web 和 Tauri 两端都能批量添加图片，用户手动点“开始处理”，在本地私有、匿名 Tinify、官方 Tinify 三条线路下压缩并下载结果（含 zip 全部下载），官方线路显示真实额度。

**负责人**：无敌王八 = 后端，瞌睡虫 = 前端，ui = 设计，pm = 规格与验收，霸王龙 = 分配与进度。

## A. 公共

| ID | 任务 | 负责人 | 依赖 | 验收标准 |
|---|---|---|---|---|
| A1 | 建 `packages/shared`：`Operation`、`OutputDestination`、`UsageSnapshot`、`ImageProviderManifest`、`Job`、`JobStatus`、`ApiError` 错误码、SSE 事件类型 | 无敌王八（瞌睡虫评审） | 接口草案定稿 | Server 和客户端都从这里 import，`tsc` 通过，无重复定义 |
| A2 | 接口草案 v0.2 定稿：并入 zip 下载、SSE 心跳和增量事件格式，删除管理员 token | 无敌王八 | — | 瞌睡虫在群里确认“对齐” |
| A3 | `.gitignore` 和构建排除：`TinifyAccounts.json`、`server/config/*.json`、`server/data/` | 无敌王八 | — | `git status` 看不到这些文件；客户端构建产物里搜不到 key 和 Server token |

## B. Server（无敌王八）

| ID | 任务 | 依赖 | 验收标准 |
|---|---|---|---|
| B1 | Fastify 骨架、`server.json` 加载与校验、`/health`、统一错误体和 `X-Request-Id` | A1 | 配置缺项时启动报清楚的错；错误响应符合 `{ code, message, providerId?, retryable, requestId }` |
| B2 | Bearer token 认证（SHA-256 哈希）、按 token 隔离批次；监听非 loopback 时强制开启 | B1 | 无 token 返回 401；A 用户访问 B 用户批次返回 404；非 loopback 加 `auth.disabled` 时拒绝启动 |
| B3 | SQLite 任务存储、临时文件目录、24 小时 TTL 清理，进程重启后清理孤儿文件 | B1 | 重启后正在处理的任务标为 failed（可重试）；过期文件被删 |
| B4 | 批次和图片 API：建批次（draft）、上传或填 URL、删除、`/start`、取消；全局并发 5 | B2, B3 | 加图片后状态保持 draft，不消耗额度；调 `/start` 后才进入 queued；同时 processing 的不超过 5 个 |
| B5 | 操作链校验：按 manifest 校验，匿名线路含非 compress 操作时返回 422 `OPERATION_UNSUPPORTED` 和 `suggestProviderId` | B4 | contract test 覆盖 |
| B6 | 账号池：读取 `TinifyAccounts.json`（兼容旧数组格式，可选 `monthlyLimit`），只在内存保存 key；日志和响应只出现 `accountId` 和掩码 | B1 | 日志、响应、SQLite 里搜不到任何原始 key |
| B7 | 官方 Tinify Provider：只请求官方 API 主机，Basic Auth，读 `Compression-Count`；失败不降级匿名 | B6 | 测试断言 Host 只有官方主机、Authorization 只出现在官方请求、没有伪造 X-Forwarded-For |
| B8 | 用量与并发锁：validate 刷新（启动、每 30 分钟、每次请求后），`remaining - inFlight` 选号，预留计数，0 额度、401、429 冷却；`/usage` 和 `/usage/refresh`（每账号 1 分钟 1 次）；每月 1 号重置 | B7 | 模拟 10 个并发请求、一个账号只剩 3 次时，这个账号最多被分到 3 次；拿不到计数时返回 `source: "unknown"` |
| B9 | 匿名 Tinify Provider：feature flag、60 秒超时、最多重试 2 次、关闭开关；失败后按账号池轮换，审计记录轮换次数和 HTTP 状态 | B6 | 用 fixture server 测试，CI 不用真实 key；关闭后返回 `ANONYMOUS_DISABLED` |
| B10 | URL 输入：协议白名单、DNS 解析拒绝内网和本机、锁定 IP、每次重定向重新检查（最多 3 跳）、20MB 上限、MIME 校验 | B4 | 测试覆盖 127.0.0.1、10.x、169.254.x、::1、跳转到内网、超大文件，都返回 `URL_FORBIDDEN` 或 `FILE_TOO_LARGE` |
| B11 | 结果下载 `/jobs/:id/result`、zip `/batches/:id/archive`；每个输出目的地分别记录；`retry` 支持 `scope: outputs` | B4 | 只重试输出时不再调用 Provider（额度不变） |
| B12 | SSE `/batches/:id/events`：增量事件、15 秒心跳；取消后迟到的结果不覆盖 canceled | B4 | 断线重连后用 `GET /batches/:id` 拉到的状态和推送一致 |
| B13 | README：启动方法，`server.json`、`TinifyAccounts.json`、`storage.json` 怎么配 | B1–B12 | QingShan 照着 README 能在自己电脑上启动 |

## C. 设计（ui）

| ID | 任务 | 依赖 | 验收标准 |
|---|---|---|---|
| C1 | 设计规范：颜色、字体、间距、组件，基于现有 Web 压缩界面 | — | 19:00 前交到 `docs/design/` |
| C2 | Editorial Canvas 四个区域的线框图：左素材栏、中间 before/after 对比、右操作面板（含“开始处理”按钮）、底部队列 | C1 | 有窄窗口布局；“开始处理”在 draft 时可点、处理中不可点 |
| C3 | 模式和状态：PRIVATE / CLOUD 顶栏文案、Provider 选择、官方额度（含“用量未知”）、匿名不支持操作的提示、单文件失败和只重试输出的入口 | C2 | 规格里所有文案都有对应位置 |

## D. 客户端（瞌睡虫）

| ID | 任务 | 依赖 | 验收标准 |
|---|---|---|---|
| D1 | 把 `CompressionTask` 和 `CompressionProvider` 升级成操作链加多输出模型（`WorkbenchItem`、`Batch`、`Pipeline`），接 `packages/shared` | A1 | 现有压缩功能不退化，原有测试通过 |
| D2 | Pinia store：workbench、provider、usage、settings；token 在 Tauri 存系统钥匙串，Web 存 sessionStorage | D1 | localStorage 里没有 token |
| D3 | `LocalExecutor`：复用 `TaskQueue`（并发 5），Canvas 实现 compress、convert（png/jpeg/webp）、resize；network-disabled guard | D1 | 本地模式下网络请求数为 0（自动化测试）；不显示 URL 输入 |
| D4 | `CloudExecutor`：建批次、上传（XHR 上传进度）、`/start`、fetch 读 SSE、断线重拉 | A2, B4, B12 | 能对着 Server 跑通批量压缩；断网后恢复显示正确状态 |
| D5 | 工作台 UI：按 ui 的设计稿实现四个区域、模式切换、“开始处理”按钮，不自动开始 | C2, D2 | 加完图片什么都不发生，点按钮后才开始 |
| D6 | Provider 和额度展示：按 manifest 禁用不支持的操作，匿名线路提示改用官方；官方显示账号掩码、已用、剩余、来源和更新时间，未知时不显示数字 | B8, D5 | 跟 C3 设计稿一致 |
| D7 | 下载：单张下载、zip 全部下载（云端调 `/archive`，本地用 `fflate`）；失败重试和只重试输出 | B11, D5 | 两种模式下都能下载 zip |
| D8 | Tauri 端：下载保存走现有 `FileAdapter`（覆盖原图不在第一阶段） | D7 | macOS 上能保存到所选目录 |

## E. 验收（pm）

| ID | 任务 | 依赖 | 验收标准 |
|---|---|---|---|
| E1 | 写第一阶段验收清单：三条线路 × 两端，覆盖手动开始、并发 5、20MB、取消、部分失败、只重试输出、额度未知、内网 URL | 本文 | 霸王龙确认 |
| E2 | 按清单验收，问题记成 issue 分给对应负责人 | B13, D8 | 全部通过后交给 QingShan |

## 关键路径和顺序

1. 现在可以并行开始：A2、A3、B1、C1、D1（D1 先基于草案类型做，A1 合并后切过去）。
2. A1 合并后：B2–B12 和 D2–D3 并行。
3. B4 和 B12 可用后：D4。C2 和 C3 出图后：D5–D7。
4. 最后：B13、D8、E2。

**风险**：匿名网页接口随时可能失效（已有关闭开关，并有官方线路兜底）；Canvas 压缩效果比不上 Tinify（规格已要求界面提示）；多人共用时全局并发 5 会排队，第一阶段接受。

**不在第一阶段**：覆盖原图、S3/GCS 输出、裁切、兴趣区、元数据、管理员视图。
