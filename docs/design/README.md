# docs/design · 第一阶段设计交付（ui）

对应任务 C1（设计规范）、C2（四区线框）、C3（模式与状态）。范围以 `plans/2026-10-12-phase1-tasks.md` 和规格「审阅决定」为准。

## 文件
| 文件 | 内容 |
|---|---|
| `design-system.md` | 颜色 token（浅/深）、字体、间距、圆角、阴影、动效、组件（按钮/输入/面板/队列状态/模式切换/Provider/额度徽章/目的地结果/zip/SSE 连接状态/冲突提示）、无障碍、本地 vs 云端区分 |
| `wireframes.html` | 自包含静态线框，直接用浏览器打开；`?s=1..6` 只显示某一帧 |
| `png/01.png` | 空状态（云端，开始处理禁用 + “先添加图片”） |
| `png/02.png` | 已加入未开始：全是草稿，含 20MB 超限拒收示例，「开始处理 (6)」可点 |
| `png/03.png` | 处理中：运行 3/5（全局共享）、排队、进度条、SSE 断线恢复提示、按钮不可点 + 取消全部 |
| `png/04.png` | 完成·混合结果：成功 / 部分成功（保存目录失败→重试输出）/ 失败（429）/ 取消；zip 只含成功项 |
| `png/05.png` | 本地私有模式：绿色 PRIVATE 顶栏、网络请求 0、无 URL 输入、无 Provider 区 |
| `png/07.png` | 窄窗口 800×900：缩略图条、Inspector 右侧抽屉（打开态）、可收起队列、吸底「开始处理」 |
| `png/06.png` | 匿名线路冲突：警告条 + 冲突节点标黄 + 开始处理禁用，需手动「切换到官方 / 只保留压缩」 |

截图为 1440×900，由 headless Chrome 渲染。01–06 为 1440×900，07 为 800×900；窄窗口规则见 `design-system.md` §4。

## 关键决定
- 沿用 brainstorm 选定的 Editorial Canvas：米白纸底 `#F4F0E8` + 墨色 `#1E293B`；本地 = 绿 `#1F6B57` + 🔒，云端 = 陶土 `#B4532A` + ☁，同时配文字，不只靠颜色。
- 全屏只有一个主按钮「开始处理 (n)」，放在 Inspector 底部吸底。
- 第一阶段不做的功能（裁切/兴趣区/元数据/覆盖原图/S3/GCS）灰显并写「后续支持」，不隐藏，让用户知道后面会有。
- 输出第一阶段只有「下载」（单张 + zip），但仍按目的地行展示状态和「重试输出」。

## 已定（团队决定）
- 扩展 `tokens.css`，不用 Tailwind；Reka UI 做 RadioGroup / Dialog / 对比滑块。
- 处理中可继续添加图片，新图为草稿；「开始处理 (n)」只计草稿。
- SSE：心跳 15 秒，30 秒无事件显示「连接中断」，自动重连后重拉批次。
- 展示状态 8 种：draft / queued / 运行（uploading·processing·saving）/ completed / partial / **output-failed**（有结果但全部输出失败，「已处理，保存失败」，只给「重试输出 · 不消耗额度」）/ failed（仅 Provider 失败）/ canceled。
- 交互细则见 `interaction-specs.md`。

## 待确认
1. `deriveDisplayStatus()`（c14882e）目前没有 `output-failed` 分支：单目的地保存失败会返回 `completed` 或 `failed`（取决于 Server 怎么写 job.status），需要无敌王八补：`result && outputs.length>0 && outputs 全部 failed → 'output-failed'`，`JobDisplayStatus` 加上这个值。
2. Tauri 保存目录：每批问一次还是记住上次？（建议记住，队列头可改）
3. 切到本地模式时移除 URL 草稿并 toast 告知数量，确认？
