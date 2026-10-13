# 第一阶段恢复与验证记录

日期：2026-10-13（北京时间）。本记录对应本次主任务执行的验证；实施状态、自动化检查、fixture 联调、真实 Provider 请求和原生操作分别列出。`[x]` 仅表示该条具体证据已取得，不代表完整发布或 E2 已完成。

## 恢复来源与文件边界

- [x] Grok 实际提交顶点为 `65a3aed`，并非中断前进度消息中的 `90d1e3b`。
- [x] 取回完整源码归档，包括未提交 B3/D5 文件，归档 SHA-256 为 `c035bae6a7cebe9bbf1a84b954886661d77206712a06faa3a916eeb7a55c0a10`。
- [x] 本地账号密钥保留；账号池、配置、运行数据排除于提交和客户端构建，不在本记录披露密钥内容。
- [x] 验证副本：`/private/tmp/tinypng-phase1-recovery-local/work/tinypng-cross-platform`，分支 `phase1`。
- [x] 正式接续仓库：`<本地仓库路径>`，分支 `<本地分支>`，恢复基点 `65a3aed`。

恢复后的追加实现未提交或推送；这是本次操作边界，不属于计划验收事项。

## 自动化与构建

最终自动化记录为 **259 项通过 = 前端 167 + Server 89 + Rust 3**。Server 新增匿名 HTTP 400/401/403/413/429 和 401 不重试共 6 条回归，最新 89 项、Server 类型检查和 diff 检查通过。代码实现清单见 [原计划](2026-10-12-phase1-tasks.md)，不以测试数量替代真实设备或 Provider 验收。

| 检查 | 结果 | 对应命令/口径 |
|---|---|---|
| 前端核心与回归 | 167 项通过 | Vitest 的 `tests/core` 范围 |
| Server 合同与回归 | 89 项通过 | `pnpm test:server` |
| Rust 文件操作 | 3 项通过 | `cargo test --manifest-path src-tauri/Cargo.toml` |
| 前端类型 | 通过 | `vue-tsc --noEmit` |
| Server 类型 | 通过 | `pnpm --filter @tinypng/server typecheck` |
| Web 构建 | 通过 | `pnpm build` |
| 客户端秘密扫描 | 通过 | `pnpm check:secrets` |
| diff 格式 | 通过 | `git diff --check` |

- [x] 前端、Server 和 Rust 自动化检查取得上述通过记录。
- [x] 类型、Web build、secrets 与 diff 检查通过。
- [x] Server 普通测试强制加载空账号 fixture，覆盖外部 TINIFY_ACCOUNTS；sentinel 路径隔离验证先红后绿，最终 Server 89/89。
- [x] 正式目录前端 167/167；源码恢复清单逐文件 SHA-256 核验通过，真实账号 key 未出现在客户端 dist 中。
- [x] 代码具备手动开始、全局并发 5、20MB 文件上限、取消、输出状态/重试、额度未知及 URL 内网防护的实现与自动化覆盖。
- [ ] Windows/Linux 的原生运行态验收；本次 macOS 结果不能代替它们。

## Web 本地真实流程

- [x] 实际导入两张 PNG 后保持草稿，用户点击“开始处理”才处理。
- [x] 本地模式处理时网络请求数为 0。
- [x] PNG 转为 WebP，`contain` 输出为 240×240，结果可实际查看。
- [x] 单图/ZIP 下载，ZIP 与文件内容校验通过。
- [x] 保留浏览器证据：[本地草稿](../../screenshots/20261013-local-draft.jpg)、[本地结果](../../screenshots/20261013-local-completed.jpg)。

这些证据覆盖 Web 本地实际处理，不证明匿名或官方云端整链已通过。

## Web 云端 API 与 fixture Provider

- [x] 客户端连接真实 Server HTTP API，Provider 执行部分使用 fixture。
- [x] 实际上传一张 PNG，手动 Start，经 SSE 到 `completed`。
- [x] 保留浏览器证据：[云端 API 结果](../../screenshots/20261013-cloud-api-completed.jpg)。
- [ ] 客户端 → Server → 真实匿名 Tinify → 下载/ZIP 的完整整链。
- [ ] 客户端 → Server → 真实官方 Tinify → 下载/ZIP 的完整整链。

fixture Provider 只证明客户端与 Server 的真实 API 合同和状态流；不得称为真实 Tinify 全流程验收。

## 官方 Tinify 真实请求与额度

- [x] 免费 validate 实际观察到 `Compression-Count: 352`。
- [x] 仅执行一次真实 compression：PNG 原始 8851 bytes，输出 1539 bytes，480×360。
- [x] 本次未追加更多付费处理请求；免费 validate 与一次 compression 分开记录。
- [ ] 把这次直接 Provider 请求扩展为 Web/Tauri 客户端完整批次、取消、重试、下载和 ZIP 验收。

本项证明官方 Provider 的真实请求和图片输出，不能代表全部账号池、多人并发、每月重置或完整客户端矩阵已真实验证。

## macOS Tauri 原生操作

- [x] 实际原生文件 picker 与文件夹导入。
- [x] 两张 PNG 保持草稿，经手动开始处理。
- [x] 原生 Save 对话框取消后可再次 Save；实际文件写入 4237 bytes，360×480。
- [x] IPC network guard 修复已纳入代码与本次自动化检查。
- [x] IPC guard 修复后重新打包并启动新构建；两张 draft 经手动 Start 到两张 completed，PRIVATE 网络请求数 0。
- [x] 新构建原生 ZIP 保存为 desktop-local-results.zip，实际 14745 bytes；两张 PNG 分别为 360×480、480×360，ZIP 完整性与内容校验通过。
- [x] 保留新构建证据：[macOS 草稿](../../screenshots/20261013-macos-draft.png)、[macOS 结果](../../screenshots/20261013-macos-completed.png)。
- [ ] macOS 真实匿名/官方客户端整链，以及两种云端线路的取消、失败和 ZIP。
- [ ] Windows/Linux 原生 picker、文件夹、保存和异常状态验收。

## 匿名 Tinify 真实试测

- [x] 使用真实匿名网页接口试测，无官方 key，maxRetries=0，返回 HTTP 401。
- [x] 本次匿名试测未调用官方账号池，没有因 fallback 消耗官方额度。
- [ ] 匿名真实处理通过：厂商网页接口当前不可用；拒绝后由用户手动切换官方线路，再明确开始处理。
- [x] 匿名 HTTP 400/401/403/413/429 与 401 不重试共 6 条新增回归通过；401 明确提示“匿名暂不可用，需手动切官方”，不再误提示检查官方账号，官方鉴权语义保留。

真实失败响应只证明当前线路被拒绝，不能算匿名压缩、下载、ZIP 或完整 fallback 验收通过。

## E1 边界清单与 E2 完整矩阵

E1 清单已具备。以下矩阵保留实际尚未取得的证据，E2 整体仍为 `[ ]`。

- [x] Web / 本地：真实两图、手动启动、0 网络、格式/缩放、下载和 ZIP。
- [x] Tauri / 本地（macOS）：新构建两图手动处理、0 网络、原生单图保存及 ZIP 完整性通过。
- [ ] Tauri / 本地（Windows/Linux）：原生 picker、目录、保存及边界状态待验。
- [ ] Web / 匿名：真实 Provider 完整处理与下载/ZIP。
- [ ] Tauri / 匿名：真实 Provider 完整处理与下载/ZIP。
- [ ] Web / 官方：真实 Provider 完整处理与下载/ZIP。
- [ ] Tauri / 官方：真实 Provider 完整处理与下载/ZIP。
- [ ] 三线路 × 两端均验证并发 5、20MB、取消和迟到结果、部分成功 `partial`、`output-failed`、只重试输出不耗额度、额度未知、内网 URL 及断线恢复。
- [ ] 匿名真实线路可用性与完整降级验收：本次真实试测 HTTP 401，线路未通过。
- [ ] E2：完整矩阵验收，问题记录并解决后交付。

S3/GCS 的 README 配置仅为后续示例。本阶段没有实现这些输出，也没有实施覆盖原图、裁切、兴趣区、元数据或管理员视图。构建及本地验证不代表已签名、发布或部署。
