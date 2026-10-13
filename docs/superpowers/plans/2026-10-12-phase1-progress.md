# 第一阶段进度表

更新时间：2026-10-13（北京时间）。本表替代 Grok 中断前的聊天进度，以恢复后的代码、自动化检查和实际操作证据分别记录。

恢复来源的实际提交顶点为 `65a3aed`，包含已提交代码以及归档内未提交的 B3/D5 文件。归档 SHA-256：`c035bae6a7cebe9bbf1a84b954886661d77206712a06faa3a916eeb7a55c0a10`。本次验证副本在 `/private/tmp/tinypng-phase1-recovery-local/work/tinypng-cross-platform`，分支仍为 `phase1`；正式接续仓库在 `<本地仓库路径>`，分支为 `<本地分支>`。恢复后的追加实现尚未提交或推送；账号密钥不进入代码或验证文档。

| ID | 实施状态 | 当前证据与验收边界 |
|---|---|---|
| A1–A3 | 已实现 | 共享合同、API 文档、Git/构建排除及 secrets 检查具备 |
| B1–B6 | 已实现 | Server、认证、SQLite、批次队列、操作校验和账号池；有 Server 自动化检查 |
| B7–B8 | 已实现 | 官方 Provider 和用量/并发控制；真实官方 validate 及一次 compression 已验证，客户端整链尚未全验 |
| B9 | 已实现，真实线路未通过 | 无官方 key、maxRetries=0 的匿名试测返回 HTTP 401，厂商网页接口当前不可用；拒绝后用户手动切官方 |
| B10–B12 | 已实现 | URL 边界、结果/ZIP/输出重试、SSE/取消；Web 已接真实 API 与 fixture Provider |
| B13 | 文档已交付 | README 已写启动、Server/账号池配置；S3/GCS 仅后续配置示例 |
| C1–C3、应用图标 | 材料已具备 | 设计、交互、窄窗及正式图标已恢复 |
| D1–D7 | 已实现 | 工作台模型、store、本地/云端执行、UI、额度及下载；Web 本地和 fixture 云端有真实浏览器证据 |
| D8 | 已实现，macOS 本地实测通过 | 原生 picker、目录导入、手动处理、取消 Save 后再次 Save；新构建本地 0 网络和原生 ZIP 保存/内容校验通过，Windows/Linux 未验 |
| E1 | 已完成 | [原任务与实施清单](2026-10-12-phase1-tasks.md)、[分层验证记录](2026-10-13-phase1-verification.md) |
| E2 | 未完成 | 三线路 × 两端完整实测矩阵保持待验；Windows/Linux 原生操作未验 |

最终自动化记录为 259 项通过：前端 167、Server 89、Rust 3；前端/Server 类型检查、Web build、secrets 扫描和 diff 检查通过。Server 新增匿名 HTTP 400/401/403/413/429 与 401 不重试共 6 条回归，401 文案明确匿名暂不可用、需手动切官方，官方鉴权语义保留。详细口径、真实请求次数和未覆盖场景见验证记录。

- [x] 取回实际提交 `65a3aed` 与未提交 B3/D5 整包，保留本地账号密钥。
- [x] 原计划 28 项代码或材料具备，逐项实施复选框已更新。
- [x] Web 本地真实两张 PNG：手动开始、0 网络请求、WebP contain 240×240、ZIP 与文件内容校验。
- [x] Web 云端：真实 Server API + fixture Provider，一张 PNG 上传、手动启动、SSE 到 completed。
- [x] 官方真实请求：免费 validate 观察 Compression-Count 352；仅追加一次 compression，PNG 8851 → 1539 bytes、480×360。
- [x] macOS 原生 picker/文件夹/两张 PNG 手动处理；取消 Save 后再次 Save，真实保存 4237 bytes、360×480。
- [x] IPC guard 修复后的新 macOS 构建：两张 draft 经手动 Start 到两张 completed，PRIVATE 网络请求数 0。
- [x] macOS 原生 ZIP 保存：desktop-local-results.zip 为 14745 bytes，两张 PNG 为 360×480、480×360，ZIP 完整性与内容校验通过。
- [x] 匿名真实试测取得结果：无官方 key、maxRetries=0，HTTP 401；没有调用官方账号池。
- [ ] 匿名真实线路通过：厂商网页接口当前不可用，拒绝后用户手动切到官方线路；不能标为匿名成功。
- [ ] 真实 Tinify 的客户端完整处理/下载/ZIP 整链。
- [ ] Windows/Linux 原生操作和三线路 × 两端完整验收。

阶段范围仍为下载与 ZIP。本地 PNG 编码效果有限；S3/GCS 输出、覆盖原图、裁切、兴趣区、元数据和管理员视图不在本阶段，不能因 README 存在配置示例而标为已实现。
