# 交互细则：对比滑块 & 队列项

负责人：ui · 2026-10-12 · 对齐 `packages/shared`（`BatchEvent`、`JobStatus`、`deriveDisplayStatus`、`LIMITS`、`SSE_HEARTBEAT_INTERVAL_MS`）。实现：Vue + Reka UI（`SliderRoot`/`SliderThumb`、`RadioGroup`、`Dialog`），样式只用 `tokens.css`。

## 1. Before/After 对比滑块

### 1.1 结构
- 画布 = 一个视口，内含两层同尺寸图像：原图（底层）、结果（上层，`clip-path: inset(0 0 0 X%)` 露出右侧）。分割线 + 圆形把手（28px，命中区 44px）。
- 用 `clip-path`/`transform` 实现，不改 width，不重排。
- 标签：左上「原图 · 尺寸 · 格式 · 体积」，右上「结果 · 尺寸 · 格式 · 体积 · −节省%」，数字 tabular-nums。分割线拖到 <10% 或 >90% 时，被遮的一侧标签淡出（opacity）避免重叠。
- 结果尺寸与原图不同（缩放/转换）时，结果按原图显示尺寸等比铺放，右上标签注明实际像素。

### 1.2 指针 / 触摸
- 在把手或分割线上按下拖动；在画布空白处单击 = 分割线跳到该点（不平移）。
- 拖动跟手、无缓动；`pointer capture` 保证拖出画布仍有效。
- 触摸：单指拖把手 = 移分割线；单指拖空白 = 平移（仅放大时）；双指 = 缩放。画布 `touch-action: none`。
- 光标：把手 `ew-resize`；放大后空白处 `grab`/`grabbing`。

### 1.3 键盘（把手获得焦点时）
| 键 | 行为 |
|---|---|
| ← / → | ±5% |
| Shift + ← / → | ±1%（精细） |
| PageUp / PageDown | ±25% |
| Home / End | 0%（全显结果）/ 100%（全显原图）——与视觉方向一致：位置值 = 原图可见比例 |
| Enter / 双击 | 回到 50% |
画布（非把手）获得焦点时：`+`/`-` 缩放，`0` 适应，`1` 100%，方向键平移（每次 40px）。

### 1.4 缩放 / 平移同步
- 两层共用一个 `transform: translate() scale()`，永远同步；分割线位置是视口百分比，缩放平移不影响它。
- 缩放档：适应、25%…800%；滚轮 + Ctrl/⌘ 以光标为中心缩放；适应 = 两图中较大者完全可见。
- 切换选中素材时保留分割位置，缩放重置为「适应」。
- 模式按钮：仅原图 / 分割 / 仅结果（Reka `ToggleGroup` 或 RadioGroup），仅原图 = 位置 100%，仅结果 = 0%，把手隐藏。

### 1.5 ARIA
- 把手：Reka Slider，`role="slider"`，`aria-label="原图与结果对比"`，`aria-valuemin=0 max=100 now=X`，`aria-valuetext="原图显示 X%"`。
- 画布：`role="group" aria-label="图片预览 hero.png"`；缩放档变化写入 `aria-live="polite"`（「缩放 200%」）。
- 结果未生成时把手 `aria-disabled="true"`，不在 Tab 序列。

### 1.6 加载与空态
| 情况 | 表现 |
|---|---|
| 无选中素材 | 拖放区空状态（见线框 01） |
| 原图解码中 | 画布骨架（`--surface-sunken` 块），不显示把手 |
| `draft` / `queued` | 右侧棋盘格 + 「点击开始处理后生成结果」/「排队中 · 第 n 位」 |
| 运行中 | 右侧棋盘格 + 「上传中/处理中/保存中 n%」（取 job 事件 progress） |
| `completed` / `partial` / `output-failed` | 结果图载入（淡入 150ms）；载入失败显示「结果预览加载失败 · 重新加载」 |
| `failed` / `canceled` | 右侧显示错误文案或「已取消」，把手禁用 |
| 超大图 | 预览用缩略解码（长边 ≤ 4096），标签仍显示真实尺寸 |

## 2. 队列项

### 2.1 八种展示状态（`deriveDisplayStatus` + 补充 `output-failed`）
| 展示状态 | 判定 | 主文案 | 行内操作 |
|---|---|---|---|
| draft | `status=draft` | 草稿 · 待开始 | 移除 |
| queued | `queued` | 排队中 · 第 n 位 | 取消 |
| running | `uploading/processing/saving` | 上传中/处理中/保存中 · n% · 尝试 a/(1+LIMITS.maxRetries) | 取消 |
| completed | `completed` 且所有 output completed | 原体积 → 结果体积 · 节省 x% | 下载 |
| partial | 部分 output completed、部分 failed | 已处理 · n 个目的地失败 | 重试输出、下载 |
| output-failed | 有 `result` 且全部 output failed | 已处理，保存失败 | **仅**重试输出（旁注「不消耗额度」） |
| failed | `failed`（Provider 失败，无 result） | 处理失败：error.message | 重试 |
| canceled | `canceled` | 已取消 | 重试 |

### 2.2 动作 → API
| 动作 | 调用 | 结果 |
|---|---|---|
| 移除草稿 | `DELETE /batches/:b/items/:j`（本地直接删） | 行淡出 150ms；无需确认，toast「已移除 · 撤销」5 秒 |
| 取消 | `POST /jobs/:j/cancel` | 立即乐观显示「取消中…」，收到 `canceled` 事件定稿；迟到事件忽略 |
| 重试 | `POST /jobs/:j/retry {scope:'all'}` | 回到 queued |
| 重试输出 | `retry {scope:'outputs'}` | 只有失败的 output 回到 saving；不重新处理，不消耗额度 |
| 下载 | `GET /jobs/:j/result`（本地：Blob） | Tauri 走 FileAdapter 保存；完成 toast |
| 展开详情 | 本地 UI | 见 2.4 |
| 取消全部 | `POST /batches/:b/cancel` | AlertDialog 确认「取消 n 个未完成任务？已完成的不受影响」 |

按钮执行中显示 spinner 并禁用，防重复点击；失败在该行下方显示错误，不用全局 toast 代替。

### 2.3 悬停 / 焦点 / 键盘
- 整行是 `li`，内含真实 `button`；行本身不可点。行 hover：`--surface-sunken` 底；焦点只在按钮上，`:focus-visible` 焦点环。
- 列表键盘：Tab 进入第一个可用操作；行内 ←/→ 在操作间切换（roving tabindex），↑/↓ 跨行，Enter/Space 执行，`Delete` 在草稿行 = 移除。
- 选中行（Enter on 名称按钮）= 同步左栏素材选中和画布。
- 所有按钮 `aria-label` 带文件名：「重试输出 banner@2x.png」。

### 2.4 展开详情（`aria-expanded`，Reka Collapsible）
来源（文件名 / URL host）、Provider、账号掩码、尝试次数、每个 output 一行（目的地 · 状态 · 错误 · 时间）、requestId（可复制）、输入/结果尺寸格式。

### 2.5 SSE 更新
- `job` 事件：按 `jobId` 合并 `status/progress/outputs/error`；终态（`TERMINAL_JOB_STATUSES`）后不再接受非终态覆盖。
- `batch` 事件：更新队列头汇总和「开始处理」按钮状态。
- `heartbeat`：只刷新「最后收到事件时间」。30 秒（= 2×`SSE_HEARTBEAT_INTERVAL_MS`）无事件 → 顶栏「连接中断，正在恢复…」，自动重连，成功后 `GET /batches/:b` 全量校正，提示消失。
- 进度条：`transform: scaleX(progress)`，过渡 200ms linear；进度回退（重试）直接跳，不反向动画。
- 状态切换：图标/文字 crossfade 120ms；完成时对勾一次性缩放 0.9→1（150ms ease-out）。行排序不因状态变化跳动（保持加入顺序），避免点错。
- 读屏：每行不播进度；`aria-live="polite"` 区汇总「3 张完成，1 张保存失败」，最多每 5 秒一次。

### 2.6 减少动态效果
`prefers-reduced-motion: reduce`：去掉运行圆点呼吸、对勾缩放、行淡出位移；进度条无过渡直接设值；仅保留 ≤100ms 的透明度变化。

### 2.7 限制提示
- 添加时 > `LIMITS.maxFileBytes`（20 MB）：不进草稿，素材栏/队列显示拒收行「超过 20 MB，未加入」，可关闭。
- 并发：队列头「运行 n / LIMITS.concurrency · 全局共享」；排队位置来自 Server。
- 超时 `LIMITS.providerTimeoutMs`（60 秒）由 Server 判定，前端只显示尝试次数和最终错误。

## 3. 操作节点交互（第一阶段）

### 3.1 缩放模式切换
- RadioGroup：等比缩小 `inside`（默认）/ 固定尺寸·补边 `contain` / 固定尺寸·裁切 `cover`；方向键在选项间移动。
- 帮助文字跟随宽高输入实时更新（防抖 150ms），用 `aria-describedby` 关联到选中项：
  - `inside`：「最长边不超过 {w|h}，小图不放大」——原图本来更小的素材在队列详情注明「未放大，保持原尺寸」。
  - `contain`：「补透明或白色边到 {w}×{h}」——PNG/WebP 透明，JPG 白色；画布结果预览在补边区显示棋盘格（透明）或白色。
  - `cover`：「居中裁切到 {w}×{h}」——预览前可在原图上叠加虚线框标出将被保留的区域。
- 切到 `contain`/`cover` 时若缺宽或高，焦点留在当前项，空输入框显示错误并禁用「开始处理」，补齐后自动恢复。

### 3.2 本地模式 PNG 提示
- 触发：`processingPolicy='private-local'` 且压缩开启且素材含 PNG；条件变化（加/删素材、开关压缩、切模式）实时出现或消失，淡入 120ms（reduced-motion 下直接出现）。
- 位置：压缩选项正下方，inline，`role="status"`（只在首次出现时播报一次）；文案「本地模式对 PNG 压缩效果有限，建议用云端」+「切到云端」按钮（点了才切，切换规则同模式开关）。
- 不阻塞：「开始处理」状态完全不受影响，不弹窗、不二次确认。
- 质量滑块：输出格式为 PNG 时禁用（`aria-disabled="true"`，保留在 Tab 序列以便读屏读到原因），下方「只对 JPG 和 WebP 有效」；转换节点改成 JPG/WebP 后立即可用。
