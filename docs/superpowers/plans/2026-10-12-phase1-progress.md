# 第一阶段进度表（pm 维护）

更新时间：2026-10-12 17:55（北京时间） · 分支 `phase1`

| ID | 负责人 | 状态 | 备注 |
|---|---|---|---|
| A1 | 无敌王八 | ✅ 完成 | `8e8df9f`，后续 `c14882e`、`0dfa025`（展示状态推导、仅 download） |
| A2 | 无敌王八 | ✅ 完成 | `f3c01b7` v0.2，瞌睡虫已确认对齐 |
| A3 | 无敌王八 | ✅ 完成 | `b74ec74`，新增 `pnpm check:secrets` |
| B1 | 无敌王八 | ⏳ 进行中 | B7 需与本地缩放一致：inside 不放大、contain 留白（sharp 补边）、cover 中心裁切 |
| B2–B13 | 无敌王八 | 待开始 | 依赖 B1 |
| C1 | ui | ✅ 完成 | `docs/design/design-system.md` |
| C2 | ui | ✅ 完成 | 7 帧，含小于 1024px 的窄窗口 |
| C3 | ui | ✅ 完成 | `7e72d10` |
| C+ | ui | ✅ 完成 | `8bb80dd` interaction-specs.md，之后走查还原度 |
| D1 | 瞌睡虫 | ✅ 完成 | `1fba711`，23 个测试通过 |
| D2 | 瞌睡虫 | ✅ 完成 | `c10d19d`（Tauri 钥匙串待 cargo check） |
| D3 | 瞌睡虫 | ✅ 完成 | `379dd36`，本地网络请求数为 0 |
| D4 | 瞌睡虫 | ⏳ 进行中 | |
| D5–D8 | 瞌睡虫 | 待开始 | D5 含 contain 留白说明、PNG 提示、质量滑块灰显 |
| E1 | pm | ⏳ 进行中 | 验收清单 |
| E2 | pm | 待开始 | |

**阻塞**：Tauri 依赖要 Rust 1.88，共享电脑是 1.85，霸王龙在装新版并跑 `cargo check`。（pnpm lock 已在 `53d794c` 解除）

**新增约定**：处理中可以继续加图片，新加的默认是草稿，“开始处理 (n)”只统计草稿数；30 秒收不到事件就显示“连接中断”并自动重连；样式扩展 `tokens.css`，组件用 Reka UI；展示状态新增 `partial` 和 `output-failed`（`c14882e`，由 `deriveDisplayStatus()` 推出）。
