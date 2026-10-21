# File Share 设计（局域网分享面）

日期：2026-10-21。状态：P0、P1 已完成，P2 待开始。

参考项目：[file-share](https://github.com/cky-thinker/file-share)（Electron/uTools + Express + Vue 访客页，MIT）。只借鉴能力与协议形状，服务端与访客页均重写。

## 决策记录

1. 分享服务与压缩客户端在同一个 Tauri 进程内起停，用 Rust/axum 实现；不开子进程、不做 Node sidecar、没有独立控制端口。
2. 压缩链路不重构：网络、文件、覆盖仍在 Rust，队列与状态机保留在 Vue。
3. 产品名随翻面切换：压缩面显示 **TinyPNG Lite**，分享面显示 **File Share**；窗口标题同步切换。安装包名、`identifier`、Dock 名称暂不变，避免签名、更新与快捷方式连锁改动。
4. 访问保护三选一，同一时间只生效一种：链接访问 / 链接 + 6 位 PIN / 账号登录。
5. 访客页中英双语；桌面端多语言作为独立改造，不阻塞分享。
6. 关窗即停服务，不做托盘常驻。若后续要「关窗后手机继续下载」，需要先做托盘与队列下沉，另立需求。
7. 压缩结果可以直接进入分享，不复制文件；共享期间对临时结果做 pin，清理逻辑跳过。

## 功能范围

对齐参考项目：文件、文件夹、文本分享；链接与二维码；单文件下载（Range）、目录打包 zip；网页上传与发文字；SSE 实时刷新；账号与权限；搜索与面包屑；中英双语。

在参考项目之上补：会话 token、可选 PIN、Host/Origin/CSRF 校验、上传文件名消毒与配额、移动优先访客页、连接与传输状态回传桌面端。

明确不做：mDNS 自动发现、断点续传、多窗口、公网穿透、文件夹同步。

## 架构

```
src-tauri/src/share/
  mod.rs         ShareManager（Tauri state）、命令、生命周期
  server.rs      axum 路由、鉴权与安全中间件、静态页
  session.rs     会话状态：token、文件表、账号、设置、连接计数
  auth.rs        token、PIN、账号口令、cookie、锁定
  files.rs       路径校验、列目录、Range、缩略图
  archive.rs     目录 zip（复用缓存、超时清理）
  upload.rs      multipart 落盘、消毒、配额
  events.rs      SSE 广播
  page/          P0 内嵌静态页；P2 起换成 share-web 构建产物
```

- 服务在 `tauri::async_runtime` 的 tokio 上运行；`watch` 通道通知优雅关闭，2 秒后强制 abort。
- `ShareManager` 持有 `Option<Running>`；分享列表在停止后仍保留，重启复用。
- 状态变化通过 `share-status` 事件推给前端；访客侧通过 SSE。
- 访客页独立 Vite 入口 `share-web/`，构建产物用 `include_dir!` 嵌入二进制（预计 gzip 后 60~90KB）。

## 数据模型

```text
ShareItem { id, kind: file|dir|text, name, path?, text?, size?, addedAt }
Account   { id, username, passwordHash, permissions {download, uploadFile, uploadText}, enabled }
Settings  { port, uploadDir, language, ipFamily, interface, protection, pinHash, autoStart }
Runtime   { running, url, port, candidates[], connections, transfer }
```

- 持久化到应用配置目录下的 `share.json`，原子写（临时文件 + rename）。
- PIN 与账号口令只存 Argon2id 哈希；对比使用常量时间。
- 分享列表保存路径但不保存文件内容；启动时校验存在性，失效项标注不可用。

## HTTP API

所有访客接口都在 `/s/{token}` 下，token 不在后续请求里重复出现，改由 HttpOnly cookie 维持会话。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/s/{token}` | 访客页，首次访问下发会话 cookie |
| GET | `/s/{token}/api/state` | 保护级别、权限、语言、是否需要 PIN/登录 |
| POST | `/s/{token}/api/unlock` | 校验 PIN，成功后可访问 |
| POST | `/s/{token}/api/login` | 账号登录（账号模式） |
| GET | `/s/{token}/api/files?path=` | 列分享项或目录 |
| GET | `/s/{token}/api/download?name=` | 单文件 Range 下载；目录流式 zip |
| GET | `/s/{token}/api/thumb?name=` | 图片缩略图（P2） |
| POST | `/s/{token}/api/upload` | multipart 上传，写上传目录 |
| POST | `/s/{token}/api/text` | 写入一条文本 |
| GET | `/s/{token}/api/events` | SSE：列表与传输变化 |

错误统一为 `{ code, message }`，不返回内部路径。鉴权失败一律 404/403，不回显 token 是否存在的细节。

## 认证与权限

- **token**：32 字节随机数的 base32/hex 表示，只在分享链接中出现一次；校验使用常量时间比较。停止服务即失效。
- **PIN**：6 位数字，Argon2id 加盐哈希；每 IP 5 次失败锁 10 分钟；解锁后 cookie 有效期 12 小时。
- **账号**：用户名 + Argon2id 口令；登录后 cookie 携带权限声明并签名（HMAC-SHA256，进程内随机密钥，重启失效）。
- **权限**：`download` / `uploadFile` / `uploadText` 三个位；链接模式下由分享者用三个开关决定，账号模式下按账号配置。
- 切换保护级别会让现有会话失效，访客需要重新进入；桌面端二次确认。

## 安全清单

- 校验 Host 必须是 IP 字面量、`localhost` 或本机名，防 DNS rebinding；写操作校验 Origin/Sec-Fetch-Site，并要求 CSRF 头。
- 路径必须 `canonicalize` 后落在允许根目录内；拒绝 `..`、软链接越界、隐藏文件；Windows 大小写不敏感比较。
- 上传文件名去掉路径分隔符与控制字符，重名加序号；限制单文件大小、总配额与并发。
- 上传文件与下载响应统一 `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`，防止访客页被当 HTML 执行。
- 访客页设置严格 CSP；不加载第三方资源。
- 每 IP 连接数与请求速率限制；SSE 客户端上限；上传总大小上限。
- 停止服务、关窗、退出应用都走同一条优雅关闭路径，保证端口释放。

## 生命周期

```text
stopped → starting → running { url, port } → stopping → stopped
                    ↘ failed { reason }
```

- 启动：绑定 `0.0.0.0`，优先 5421，被占则顺延/回退随机端口；生成 token；返回 URL 与所有候选地址。
- 停止：停止接受连接 → 断开 SSE → 等待在途下载最多 2 秒 → 清理临时 zip → 释放端口 → 清 cookie 密钥。
- 睡眠唤醒、网络切换后重新计算候选地址；`share_status` 实时返回。
- 关窗与退出：在现有 `CloseRequested` 处理里调用 `share_stop`。
- 失败提示：端口占用、权限不足、无可用网卡分别给可操作文案。

## 桌面 UI

- 头部左侧「压缩 / 分享」两段开关；整块工作区做 3D 翻面，两面都保持挂载。
- 翻面：`perspective: 1400px`、`preserve-3d`、`rotateY(180deg)`、620~700ms、`cubic-bezier(.22,.61,.36,1)`；隐藏面 `inert` + `aria-hidden`，焦点转移到可见面标题；`prefers-reduced-motion` 降级为 160ms 淡入；动画结束移除 `will-change`。
- 品牌名随面切换：压缩面 `TinyPNG Lite`，分享面 `File Share`；窗口标题同步。
- 分享面：启停开关、链接 + 复制 + 二维码、网卡与 IPv4/IPv6 选择、实际端口、保护级别与 PIN 设置、分享列表（文件/目录/文本，可拖入）、在线连接与传输状态、上传目录设置。
- 空状态、启动中、失败、无网卡都要有明确文案；按钮在过渡期间禁用。
- 键盘可操作：开关 `role="switch"` / 两段按钮，翻面后焦点落在对应面。

## 访客页

- 移动优先；顶部显示分享者名称与保护状态，列表支持面包屑、搜索、文件类型图标、图片缩略图。
- 下载单文件、整目录 zip、多选逐个下载；上传与发文字按权限显示。
- SSE 实时刷新；断线退避重连。
- 中英双语跟随 `Accept-Language`，可手动切换；亮/暗色跟随系统。
- 无 JavaScript 时至少能列出文件和下载链接（渐进增强）。

## 分期

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | axum 骨架、token、Host 校验、内嵌页、单文件 Range 下载、网卡/端口、优雅关闭、体积测量 | 局域网设备能下载文件；集成测试通过 |
| P1 | 桌面分享面、翻面动效、分享列表、二维码、状态事件 | 起停与翻面不打断压缩；桌面可完成一次真实分享 |
| P2 | 访客页完整版：目录、zip、搜索、SSE、中英、缩略图 | iPhone/Android/桌面浏览器体验完整 |
| P3 | 上传、文字、PIN、账号与权限、登录、锁定与限速 | 三种保护级别实测通过，越权被拒 |
| P4 | 压缩结果直连分享、活动面板、防火墙自检、文档与打包 | 全流程验收 + Windows/Linux 实测 |

## P0 结果（2026-10-21）

- 已实现：进程内 axum 起停、32 位十六进制 token、Host 与端口校验、内嵌访客页（HTML/CSS/JS 分离）、文件列表、单文件 Range 下载、`Content-Disposition`、`nosniff` / CSP / `X-Frame-Options`、关窗即停、局域网地址探测（过滤虚拟网卡）。
- 测试：`cargo test --lib` 47 项通过（新增 8 项：token 长度、Host 白名单、token 路径匹配、文件名编码、空文件拒绝、列表与 206、错误 token 404、外站 Host 403）。
- 体积：release 二进制 11.2MB → 13.2MB（+1.94MB）；手动 `strip` 后 9.2MB → 11.0MB（+1.83MB）。后续可在发布 profile 打开 `strip` 抵消这部分增长。
- 当时未做：桌面分享面、翻面动效、二维码、上传、PIN/账号、SSE（已在 P1 补上前四项）。

## P1 结果（2026-10-21）

- 已实现：顶部「压缩 / 分享」两段开关与整卡 3D 翻面；品牌名与窗口标题随面切换；分享面起停、追加/移除文件、复制链接、SVG 二维码、状态与错误提示；两面保持挂载，翻面不打断压缩队列。
- 原生端新增 `share_pick_files`、`share_add_files`、`share_remove_file`、`share_qr_svg`、`share_set_title`；运行中列表用 `RwLock` 动态更新，状态通过 `share-status` 事件同步。
- 修复：运行中追加文件时 ID 从 1 重新分配，删除一项会连带删掉同 ID 的旧文件；现在从已有最大 ID 递增。
- 验证：vitest 94 项、cargo test 50 项通过；Mac 实测翻面与标题切换，真实分享 `docs/panda.avif`：页面 200、列表 JSON 正确、下载 SHA256 与源文件一致、Range 206、错误 token 404、外站 Host 403、停止后端口释放。
- 未做：访客页仍是 P0 的移动优先单页（目录、搜索、上传、SSE、中英在 P2）；PIN 与账号在 P3；压缩结果直连分享在 P4。

## 测试

- Rust 单测：token、Host、路径越界、文件名消毒、权限矩阵、PIN 锁定。
- Rust 集成：随机端口起服务，reqwest 验证列表、200/206、越权 403/404、SSE 首帧。
- 前端：翻面状态机、焦点与 aria、分享面状态、访客页 i18n。
- 手工：同一 Wi-Fi 下 iPhone Safari、Android Chrome、Windows 浏览器；1GB 文件、500 文件目录、断网重连、关闭应用后端口释放。

## 风险

- 防火墙与本地网络权限是首次使用最大障碍，UI 必须给自检与说明。
- 上传是新增攻击面，消毒与配额不能只靠前端。
- 二进制体积预计增加 1.5~2.5MB，P0 测量；超标则压缩 argon2 参数或改用 scrypt。
- WKWebView 的 3D 变换在静止时可能文字发虚，动画结束需清理 `will-change`。
- 明文 HTTP 仅限可信局域网，链接外泄等于可访问，PIN/账号用于降低风险。

## 未定

- 桌面端多语言排期（P4 之后）。
- 是否支持断点续传上传（参考项目只有普通 multipart）。
- 是否加入 mDNS 自动发现。
