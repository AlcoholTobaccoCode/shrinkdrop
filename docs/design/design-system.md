# Editorial Canvas 设计规范 v0.1

负责人：ui · 日期：2026-10-12 · 依据：`specs/2026-10-12-image-workbench-design.md`、`specs/server-api-draft.md`、群里确认的 11 条决定、brainstorm 里选定的「A · Editorial Canvas」方向（米白纸张底 + 墨色文字）。
现有代码是 Vue 3 + 原生 CSS（`src/styles/tokens.css` 只定义了 Inter 和 `#f8fafc`）。本规范以 CSS 自定义属性给出，替换/扩展 `tokens.css`；**团队已定**：扩展 `src/styles/tokens.css`，不引入 Tailwind；单选组（模式/Provider）、Dialog（抽屉、确认框）、对比滑块用 **Reka UI** 原语，样式全部取本规范 token。

## 0. 第一阶段范围（按 `plans/2026-10-12-phase1-tasks.md` C1–C3 与规格「审阅决定」）
- **做**：本地私有 / 云端（匿名 Tinify、官方 Tinify）；操作链 = 压缩、转换（PNG/JPG/WebP）、缩放；URL 输入（仅云端）；输出 = **单张下载 + zip 全部下载**（云端 `/batches/:id/archive`，本地 `fflate`；Tauri 保存走 FileAdapter 到所选目录）；进度 = SSE 增量事件 `{jobId,status,progress,outputs?}`，断线后重拉批次并显示「连接中断，正在恢复…」。
- **不做，界面上灰显并标「后续支持」**：覆盖原图、S3/GCS 输出、裁切、兴趣区裁切、元数据。灰显项 `aria-disabled="true"`，不可勾选，不进操作链。
- 下文 6.8 中覆盖原图 / 对象存储的描述是后续阶段规范，第一阶段只实现「下载」这一个目的地，但仍按目的地行展示状态与「重试输出」（例如 Tauri 写入目录失败）。

## 1. 设计原则
1. **图片是主角**：中间画布占最大面积，面板用低饱和纸色，不和图片抢颜色。
2. **数据边界永远可见**：处理位置（本地/云端）用颜色 + 文字 + 图标三重表达，不只靠颜色。
3. **先排队、后执行**：加图只生成草稿，唯一的主按钮是「开始处理」。
4. **按目的地说真话**：每个输出目的地独立显示成功/失败，部分成功不被一个总错误覆盖。
5. **不伪造数字**：额度拿不到就写「未知」。

## 2. 颜色 Token

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--paper` | `#F4F0E8` | `#14161A` | 应用底色 |
| `--surface` | `#FBF9F4` | `#1C1F24` | 面板 |
| `--surface-sunken` | `#ECE6DA` | `#101215` | 画布底、输入框底 |
| `--line` | `#D9D1C3` | `#2E333A` | 分隔线、描边 |
| `--line-strong` | `#C8C0B2` | `#434A53` | 输入框描边 |
| `--ink` | `#1E293B` | `#E8EAED` | 主文字（对 paper 对比度 ≥ 12:1） |
| `--ink-muted` | `#55606E` | `#9AA3AE` | 次要文字（≥ 4.5:1） |
| `--ink-faint` | `#8A8F96` | `#6B727C` | 仅用于占位/禁用，不放必须读的信息 |
| `--accent` | `#1E293B` | `#E8EAED` | 主按钮底色（墨色按钮，杂志感） |
| `--accent-ink` | `#FFFFFF` | `#14161A` | 主按钮文字 |
| `--local` | `#1F6B57` | `#5FD3B4` | 本地私有模式主色 |
| `--local-soft` | `#D9F2E9` | `#12302A` | 本地模式色块底 |
| `--cloud` | `#B4532A` | `#F0A07A` | 云端模式主色（陶土色） |
| `--cloud-soft` | `#F8E4D8` | `#3A2218` | 云端模式色块底 |
| `--info` | `#2F5D8A` | `#8AB8E6` | 运行中、进度 |
| `--success` | `#2E7D4F` | `#6FD39A` | 成功 |
| `--warning` | `#9A6A00` | `#F2C35B` | 冲突提示、额度不足（文字用，底用 `--warning-soft #FBF0D4 / #33290F`） |
| `--danger` | `#B42318` | `#FF8A80` | 失败、破坏性操作（底 `--danger-soft #FBE3E0 / #3A1715`） |
| `--focus` | `#2F5D8A` | `#8AB8E6` | 焦点环 |
| `--checker-a/b` | `#E6E1D7/#F4F0E8` | `#24282E/#1C1F24` | 透明背景棋盘格 |

深色用 `prefers-color-scheme` + `[data-theme]` 覆盖；`color-scheme` 跟随。所有状态色在各自 soft 底上的文字对比度 ≥ 4.5:1。

## 3. 字体
- 界面：`"Inter", "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", system-ui, sans-serif`。
- 标题/字标：同族，`font-weight: 700; letter-spacing: -0.03em`，字标写作 `IMAGE / LAB`（沿用 brainstorm）。
- 数字（体积、百分比、额度、进度）：`font-variant-numeric: tabular-nums`；技术值（文件名、主机、profile id）用 `"JetBrains Mono", ui-monospace, monospace`。
- 字阶（px / 行高）：12/16 辅助 · 13/18 标签 · 14/20 正文（默认） · 16/24 面板标题 · 20/28 画布标题 · 28/34 空状态标题。字重只用 400/500/600/700。
- 中文正文不加字距；标题 `text-wrap: balance`，段落 `text-wrap: pretty`。

## 4. 间距 / 圆角 / 阴影
- 间距 4px 基准：`--s-1 4 · --s-2 8 · --s-3 12 · --s-4 16 · --s-5 24 · --s-6 32 · --s-7 48`。
- 布局：顶栏 56；左栏 264（可折叠到 72 只剩缩略图）；右 Inspector 340；底部队列 默认 200，可拖拽 120–360；面板间距 12；面板内边距 16。
- 断点：≥1280 四区全开；1024–1279 左栏自动折叠为缩略图条；<1024（Web 窄窗）Inspector 变右侧抽屉，队列变底部可收起抽屉。窄窗口细则见线框 `?s=7`：顶栏压缩为图标模式胶囊 + 简写状态（CLOUD · 官方 / PRIVATE · 0 网络）+「⚙ 操作设置」按钮；左栏变为画布上方横向缩略图条（含 ＋ 和 URL 图标按钮）；Inspector 为右侧 340 宽模态抽屉（`role=dialog`、trap focus、Esc 关闭、焦点回到触发按钮，背后加遮罩）；队列为可收起底部抽屉（默认显示 3 行，`aria-expanded`）；「开始处理 (n)」移到吸底操作栏，与 zip 按钮并排，始终可见并遵守 `safe-area-inset-bottom`。用 `h-dvh`（`100dvh`），不用 `100vh`。
- 圆角：`--r-sm 6`（输入、标签）· `--r-md 10`（按钮、卡片、队列项）· `--r-lg 16`（面板、画布）· `--r-pill 999`（模式胶囊、徽章）。
- 阴影（只在浮层用，面板靠描边分层）：`--shadow-pop: 0 8px 24px rgb(30 41 59 / .12), 0 1px 2px rgb(30 41 59 / .08)`；深色改为 `0 8px 24px rgb(0 0 0 / .5)`。

## 5. 动效
- 只动 `transform`、`opacity`；交互反馈 ≤ 150ms `ease-out`，面板/抽屉进出 200ms `ease-out`。
- 进度条用 `transform: scaleX()` 而不是改 `width`（现有 `CompressionItem.vue` 改 width，需改）。
- 运行中只有状态点做 1.2s 呼吸（opacity），队列滚出可视区时暂停；不做整屏或大图动画。
- before/after 分割线拖动跟手，无缓动。
- `prefers-reduced-motion: reduce` 时去掉呼吸和抽屉位移，只保留淡入。

## 6. 组件

### 6.1 按钮
| 变体 | 样式 | 用途 |
|---|---|---|
| Primary | `--accent` 底 / `--accent-ink` 字，高 40，`--r-md`，600 | 全屏只有一个：**开始处理** |
| Secondary | `--surface` 底 + `--line-strong` 描边 | 添加图片、添加 URL、重试 |
| Ghost | 透明，hover `--surface-sunken` | 面板内次要操作 |
| Danger | `--danger` 字 + 描边；确认弹窗内为 `--danger` 实底 | 覆盖原图、取消批次 |
| Icon | 32×32，**必须 `aria-label`** | 删除、展开、更多 |

尺寸：sm 28 / md 36 / lg 40（开始处理用 lg，带数量「开始处理 (12)」）。命中区 ≥ 32×32（桌面）/ 44（触屏）。禁用：opacity .45 + `aria-disabled`，并在按钮旁写原因（例如「先添加图片」）。

**开始处理按钮状态**（计数 n 只算 `draft`；处理中仍可添加图片，新图为草稿，按钮可再次点击启动这些草稿）：无草稿→禁用+提示「先添加图片」；有草稿→可用，显示数量；存在操作链冲突→禁用，提示「当前线路不支持部分操作」并滚动定位到冲突提示；运行中且无新草稿→禁用，显示「处理中 3 / 12」，旁边 Danger-ghost「取消全部」；运行中又加了草稿→恢复可用「开始处理 (2)」。

### 6.2 输入
高 36，`--surface-sunken` 底，`--line-strong` 描边，`--r-sm`；label 在上方（13/500），帮助文字在下方（12 muted），错误文字在下方 `--danger` 且 `aria-describedby` 关联。数字输入（宽高、质量）右侧带单位后缀。URL 输入（仅云端）输入后在下方显示「将由 Server 获取：`example.com`」。

### 6.3 面板
`--surface` 底、1px `--line` 描边、`--r-lg`；头部 44 高，左标题 16/600，右侧图标操作。Inspector 内操作链每一步是可折叠的「节点卡」：左侧序号圆点 + 名称 + 开关，展开后是参数；不支持的节点显示锁图标和原因。

### 6.4 队列项状态（底部队列 + 左栏素材缩略图角标共用）
展示状态共 8 种，由 `packages/shared` 的 `deriveDisplayStatus()` 推导（需补 `output-failed` 分支，见 README）。第一阶段只有「下载」一个目的地，所以「Provider 成功但保存失败」实际都落在 `output-failed`，`partial` 留给后续多目的地。
| 状态 | API 状态 | 圆点/图标 | 文案 | 可用操作 |
|---|---|---|---|---|
| 草稿 | `draft` | 空心圆 `--ink-muted` | 草稿 · 待开始 | 移除 |
| 排队 | `queued` | 时钟 `--ink-muted` | 排队中 · 第 n 位 | 取消 |
| 运行 | `uploading/processing/saving` | 实心圆 `--info` 呼吸 + 进度条 | 上传中 / 处理中 / 保存中 · 尝试 1/3 | 取消 |
| 成功 | `completed` | 对勾 `--success` | 1.2 MB → 312 KB · 节省 74% | 查看结果 |
| 部分成功 | 派生 `partial`：部分 output completed、部分 failed | 对勾+感叹 `--warning` | 已处理 · n 个目的地失败 | 重试输出（不消耗额度）、下载已成功的 |
| 已处理，保存失败 | 派生 `output-failed`：有 `result` 且**全部** output failed | 感叹 `--warning` | 已处理，保存失败 · 错误人话 | **仅「重试输出」**，旁注「不消耗额度」 |
| 失败 | `failed`（仅 Provider 失败，无 result） | 叉 `--danger` | 错误信息（人话）+ requestId 可复制 | 重试 |
| 已取消 | `canceled` | 斜杠圆 `--ink-faint`，整行 .7 透明 | 已取消 | 重试 |

状态永远是「图标 + 文字」，不只靠颜色。队列头部汇总：`草稿 4 · 排队 3 · 运行 5/5 · 成功 10 · 失败 1`，以及原始总体积 / 结果总体积 / 节省比例 / 请求次数。

### 6.5 模式切换（处理位置）
顶栏中部的分段胶囊，`role="radiogroup"`，两个选项：
- 🔒 **本地私有**（`--local`）
- ☁ **云端处理**（`--cloud`）

有运行中任务时禁用并提示「处理完成或取消后才能切换」。切换会清空不兼容设置（例如本地模式下移除 URL 输入的草稿，并 toast 告知数量）。

### 6.6 Provider 选择
仅云端显示，Inspector 顶部单选卡片组（不是下拉，因为要露出能力差异）：
- **匿名 Tinify** — 标签「仅压缩」「免 key」「非官方接口，可能失效」
- **官方 Tinify** — 标签「压缩/转换/缩放/裁切/元数据」+ 额度徽章

卡片能力来自 Provider manifest，不在前端写死。

### 6.7 额度徽章
胶囊：`剩余 368 / 500`（免费账号 remaining = 500 − used）；付费账号显示 `本月已用 1,204`；拿不到 → `用量未知`，hover/聚焦显示「最近一次成功读取：17:32」。颜色：剩余 >20% 中性；≤20% `--warning`；0 `--danger` 且该账号显示「已用完」。账号池显示为 `3 个账号 · 合计剩余 1,102`，展开看每个账号掩码。额度数字来源写在 tooltip：`来源：Compression-Count`。

### 6.8 输出目的地结果
Inspector 底部「输出到」多选：下载到本地 / 覆盖原图（仅 Tauri）/ 对象存储 profile（`my-s3`、`minio`、`my-gcs`，来自 `/storage/profiles`，只显示 id 和类型）。
结果区（画布下方结果条 + 队列项展开）每个目的地一行：`[图标] 目的地名 · 状态 · 操作`：
- 成功：对勾 + 「已保存」+ 打开/复制链接
- 保存中：进度
- 失败：叉 + 错误人话 + **重试输出**（调 `retry {scope:'outputs'}`，文案注明「不会再消耗额度」）
覆盖原图需 AlertDialog 二次确认；Web 端不显示覆盖，未配置 Server 时对象存储项显示「需要配置自用 Server」。

### 6.8b zip 全部下载
队列头部右侧 Secondary 按钮「全部下载 (zip)」：有 ≥1 个成功结果才可用；只打包成功项，按钮下注明「含 10 张，1 张失败未包含」。打包中显示进度并可取消。

### 6.8c 连接状态（SSE）
顶栏运行数旁小圆点：已连接（无文字）/「连接中断，正在恢复…」（`--warning`，aria-live polite）/ 恢复后静默刷新。心跳 15 秒，超过 30 秒无任何事件即显示中断，自动重连，重连后 `GET /batches/:id` 全量重拉校正。

### 6.9 线路冲突提示（匿名 + 非压缩操作）
在 Inspector Provider 卡片下方出现 inline 警告条（`role="alert"`，`--warning-soft` 底）：
> 匿名线路只支持压缩。你开启了 **转换 WebP、缩放** 两项操作。
> [切换到官方 Tinify]  [只保留压缩]
同时冲突的操作节点标黄并显示「匿名线路不支持」；开始处理按钮禁用。**不自动切换**，必须用户点按钮。服务端 422 `OPERATION_UNSUPPORTED` 也落到同一个提示。

### 6.10 画布
before/after 分割（可拖拽分割线，键盘 ←/→ 每次 5%），顶部左「原图 2400×1600 · PNG · 1.2 MB」右「结果 2400×1600 · WebP · 312 KB · −74%」；底部工具：适应/100%/放大缩小、棋盘格开关、仅原图/分割/仅结果。草稿状态下右侧显示「点击开始处理后生成结果」占位。

## 7. 本地 vs 云端的视觉区分
| 位置 | 本地私有 | 云端处理 |
|---|---|---|
| 顶栏状态条 | 绿色 soft 底：`🔒 PRIVATE · 0 NETWORK REQUESTS`，副文「本地处理，效果不保证与云端一致」 | 陶土 soft 底：`☁ CLOUD · 官方 TINIFY`，副文「图片将上传到自用 Server，再由所选 Provider 处理」 |
| 应用边框 | 顶栏下 3px `--local` 细线 | 3px `--cloud` 细线 |
| 左栏 | 只有「添加图片」 | 「添加图片」+「添加 URL」 |
| Inspector | 无 Provider 区；操作链只显示压缩/转换(PNG/JPG/WebP)/缩放，其余节点灰显「本地版暂不支持」 | Provider 卡片 + 额度徽章；能力按 manifest |
| 输出 | 下载 / 覆盖原图(Tauri) | 下载 / 覆盖 / 对象存储 |
| 网络计数 | 顶栏常驻 `网络请求 0`，非 0 即是 bug | 显示请求次数 |

颜色之外始终有锁/云图标和文字，色盲用户也能分辨。

## 8. 无障碍
- 布局语义：`header` / `nav aria-label="素材"` / `main`（画布）/ `aside aria-label="操作设置"` / `section aria-label="任务队列"`。
- 队列用 `ul/li`；进度用 `role="progressbar"` + `aria-valuenow` + `aria-valuetext="处理中 45%"`。
- 状态变化通过一个 `aria-live="polite"` 区域汇总播报（「12 张已开始处理」「1 张失败」），不要每个进度百分比都播。失败用 `assertive` 仅播一次批次汇总。
- 模式切换/Provider 用原生 radio；分割线用 `role="slider"`；对话框 trap focus、Esc 关闭、关闭后焦点回到触发按钮。
- 焦点环：`outline: 2px solid var(--focus); outline-offset: 2px`，只用 `:focus-visible`。
- 拖拽添加图片必须有等价按钮；拖拽分割线必须有键盘等价。
- 所有图标按钮 `aria-label`（「移除 hero.png」「重试输出到 my-s3」——带上对象名）。
- 错误显示在发生的位置（队列项/目的地行/输入框下），同时给出下一步动作。
- 20MB 超限：添加时直接在素材项标红「超过 20MB，未加入」，不进草稿。

## 9. 文案约定
数字与单位间空格（`312 KB`）；时间显示北京时间 `17:32`；状态用动词进行时「处理中」；错误先说发生了什么再说怎么办：「上传到 my-s3 失败：权限不足。检查 storage.json 的 accessKey 后重试输出。」
