# File Share 设计（局域网分享面）

日期：2026-10-22。状态：P0~P3 已完成，P4 待开始。

## 决策记录

1. 分享服务与压缩客户端在同一个 Tauri 进程内起停，用 Rust/axum 实现；不开子进程、不做 Node sidecar、没有独立控制端口。
2. 压缩链路不重构：网络、文件、覆盖仍在 Rust，队列与状态机保留在 Vue。
3. 产品名随翻面切换：压缩面显示 **shrinkdrop**，分享面显示 **File Share**；窗口标题同步切换。安装包名、`identifier`、Dock 名称暂不变，避免签名、更新与快捷方式连锁改动。
4. 访问保护三选一，同一时间只生效一种：链接访问 / 链接 + 6 位 PIN / 账号登录。
5. 访客页中英双语；桌面端多语言作为独立改造，不阻塞分享。
6. 关窗即停服务，不做托盘常驻。若后续要「关窗后手机继续下载」，需要先做托盘与队列下沉，另立需求。
7. 压缩结果可以直接进入分享，不复制文件；共享期间对临时结果做 pin，清理逻辑跳过。

## 功能范围

能力范围：文件、文件夹、文本分享；链接与二维码；单文件下载（Range）、目录打包 zip；网页上传与发文字；SSE 实时刷新；账号与权限；搜索与面包屑；中英双语。

在此基础上补强：会话 token、可选 PIN、Host/Origin/CSRF 校验、上传文件名消毒与配额、移动优先访客页、连接与传输状态回传桌面端。

明确不做：mDNS 自动发现、断点续传、多窗口、公网穿透、文件夹同步。

## 架构

```
src-tauri/src/share/
  mod.rs         ShareManager（Tauri state）、命令、生命周期
  server.rs      axum 路由、鉴权与安全中间件、静态页
  net.rs         局域网地址探测
  page.html/css/js  内嵌访客页（无构建，直接 include_str!）
```

- 服务在 `tauri::async_runtime` 的 tokio 上运行；`watch` 通道通知优雅关闭，2 秒后强制 abort。
- `ShareManager` 持有 `Option<Running>`；分享列表在停止后仍保留，重启复用。
- 状态变化通过 `share-status` 事件推给前端；访客侧通过 SSE。
- 访客页保持无构建的轻量单页（HTML/CSS/JS 直接内嵌），避免第二套 Vite 构建链；目录、搜索、SSE、中英都在原生 JS 内实现。

## 数据模型

```text
SharedItem { id, kind: file|dir, name, path, size, modified }; 文本与账号在后续阶段
Account   { id, username, passwordHash, permissions {download, uploadFile, uploadText}, enabled }
Settings  { port, uploadDir, language, ipFamily, interface, protection, pinHash, autoStart }
Runtime   { running, url, port, candidates[], connections, transfer }
```

- 持久化到应用配置目录下的 `share.json`，原子写（临时文件 + rename）。
- PIN 与账号口令只存 Argon2id 哈希；对比使用常量时间。
- 分享列表保存路径但不保存文件内容；启动时校验存在性，失效项标注不可用。

## HTTP API

所有访客接口都在 `/` 下，token 不在后续请求里重复出现，改由 HttpOnly cookie 维持会话。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 访客页，首次访问下发会话 cookie |
| GET | `/api/state` | 保护级别、权限、语言、是否需要 PIN/登录 |
| POST | `/api/unlock` | 校验 PIN，成功后可访问 |
| POST | `/api/login` | 账号登录（账号模式） |
| GET | `/api/items` | 列出全部分享根（文件/目录） |
| GET | `/api/list?id=&path=` | 列出目录内容，含面包屑路径 |
| GET | `/api/download?id=&path=` | 单文件 Range 下载；目录现场打包 zip |
| GET | `/api/preview?id=&path=` | 内联预览（Range + 显式 Content-Type + `inline`），仅限可预览类型 |
| GET | `/api/thumb?id=&path=` | 图片缩略图（200px JPEG） |
| POST | `/api/upload` | multipart 上传，写上传目录 |
| POST | `/api/text` | 写入一条文本 |
| GET | `/api/events` | SSE：列表与传输变化 |

错误统一为 `{ code, message }`，不返回内部路径。鉴权失败一律 404/403，不回显 token 是否存在的细节。

## 条目预览

访客页按条目就地展开，同一列表只展开一项；展开后才请求媒体，收起音视频时暂停并记住本次会话的位置与倍率。

| 类型 | 行为 |
|---|---|
| 图片 | 280×180 固定框等比完整显示；点击进入全屏，可切换原图尺寸，Esc 关闭 |
| 音频 | 拖动进度、±15 秒、倍率循环 1× → 1.5× → 2× → 2.5× → 3× → 1×，横向铺满 |
| 视频 | 原生控件，横向铺满 |
| 文本 | 默认单行；展开后限高 240px 内滚动，可复制全文 |
| Markdown | 内嵌 marked + DOMPurify，预览/源码切换；相对图片显示占位提示 |
| 代码 | html/css/js/ts/json/py/java/go/rs/sh/sql/yaml 等按扩展名高亮，超 512 KB 提示下载 |
| Office / PDF | 保留下载，不做预览 |

预览路由复用下载鉴权与路径校验，只额外切换 `Content-Disposition: inline` 与显式 MIME；`nosniff` 保持开启。支持类型以扩展名白名单为入口，能否播放仍由浏览器解码决定，失败时提供下载。CSP 增加 `media-src 'self'`。

代码高亮使用内嵌 highlight.js（约 127 KB），浅深两套主题随系统切换，不请求外部资源。列表按 key 增量更新，SSE 刷新不会替换正在播放的媒体元素；不支持预览的文件显示「暂不预览」。

## 认证与权限

- **token**：16 字节随机数仍用于内部会话/临时目录；URL 不再携带 token，默认分组直接挂在根路径。停止或重启服务即失效。
- **PIN**：6 位数字，Argon2id 加盐哈希；每 IP 5 次失败锁 10 分钟；解锁后 cookie 有效期 12 小时。
- **账号**：用户名 + 明文口令（按用户要求保存以便设置页展示），登录比对使用常量时间比较；登录后 cookie 携带权限声明并签名（HMAC-SHA256，进程内随机密钥，重启失效）。
- **权限**：`download` / `upload` / `text` 三个位；链接和 PIN 模式下由分享者的「允许上传/发文字」开关决定，账号模式下按账号配置。
- **会话**：HMAC-SHA256 签名 cookie，12 小时有效、HttpOnly、SameSite=Strict、路径限定到 `/s/<token>`；写操作要求 `X-Share-Csrf: 1`；每 IP 5 次失败锁 10 分钟。
- 切换保护级别会让现有会话失效，访客需要重新进入；桌面端二次确认。

## 安全清单

- 校验 Host 必须是 IP 字面量、`localhost` 或本机名，防 DNS rebinding；写操作校验 Origin/Sec-Fetch-Site，并要求 CSRF 头。
- 路径必须 `canonicalize` 后落在允许根目录内；拒绝 `..`、软链接越界、隐藏文件；Windows 大小写不敏感比较。
- 上传文件名去掉路径分隔符与控制字符，重名加序号；单文件 1GB、单次 20 个，先写临时文件再原子改名。
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
- 品牌名随面切换：压缩面 `shrinkdrop`，分享面 `File Share`；窗口标题同步。
- 分享面：启停开关、链接 + 复制 + 二维码、网卡与 IPv4/IPv6 选择、实际端口、保护级别与 PIN 设置、分享列表（文件/目录/文本，可拖入）、在线连接与传输状态、上传目录设置。
- 空状态、启动中、失败、无网卡都要有明确文案；按钮在过渡期间禁用。
- 键盘可操作：开关 `role="switch"` / 两段按钮，翻面后焦点落在对应面。

## 访客页

- 移动优先；顶部显示分享者名称与保护状态，列表支持面包屑、搜索、文件类型图标、图片缩略图。
- 下载单文件、整目录 zip、多选逐个下载；上传与发文字按权限显示。
- SSE 实时刷新；断线退避重连。
- 中英双语跟随 `Accept-Language`，可手动切换；亮/暗色跟随系统。
- 无 JavaScript 时至少能列出文件和下载链接（渐进增强）。

## 设置（S1/S2）

- 存储：应用配置目录下的 `settings.json`，原子写；PIN 保存 Argon2id 哈希，账号口令按展示需求明文保存。
- 入口：头部齿轮打开独立单实例窗口（`settings.html`），分「通用 / 压缩 / 分享 / 关于」四组；修改即时保存并生效，主窗口通过事件同步。
- 字段：通用（启动面、语言）、压缩（默认自动压缩、并发 1~5、保存目录）、分享（端口、上传目录、保护级别、公开访问开关、PIN、账号与权限、允许上传/文字、自定义分组）、关于。
- 联动：端口、保护级别、PIN、账号或访客语言变化时，若分享正在运行则自动重启并保留分享列表；前端 toast 提示旧链接失效，需要手动关闭。并发与默认自动压缩即时应用到会话；保存目录注入原生保存/选目录对话框。

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

## P2 结果（2026-10-21）

- 后端：分享根支持文件与目录；新增 `/api/items`、`/api/list`、`/api/thumb`、`/api/events`，下载接口按 id + 相对路径定位，目录现场打包 zip（单并发、8GB/2 万文件上限、10 分钟清理）。
- 路径安全：相对路径按段校验，拒绝 `..`、反斜杠与 NUL；canonicalize 后必须仍在分享根内，越界软链被过滤。
- 访客页：共享根与目录浏览、面包屑、搜索过滤、文件夹打包下载、图片缩略图、SSE 实时刷新、中英切换（跟随浏览器）、亮暗色、加载/空/错误状态与重试。
- 桌面端：空状态与运行态都支持追加文件/文件夹，分享行区分「文件夹」。
- 验证：vitest 95 项、cargo test 54 项通过；Mac 实测分享 `docs/lite`：条目/子目录列表正确，zip 9 个条目、288KB，缩略图 200×156 JPEG；访客页 390/900 宽度截图正常，SSE 显示「实时更新」。
- 未做：上传、文字、PIN、账号权限（P3）；压缩结果直连分享（P4）。

## 拖拽、下载与设置窗口

- 分享面接受系统拖拽：未开始分享时拖入直接启动，运行中拖入追加到当前分组；文件列表同样可拖入。
- 访客上传项带 `visitor` 标记，在桌面列表高亮并显示「访客上传」；支持单文件、文件夹、多选打包 zip 手动保存。
- 设置新增「上传后自动保存到下载目录」，默认关闭；开启后上传文件额外复制到系统下载目录。
- 设置窗口固定 760×680，使用系统标题栏关闭，不再绘制自定义顶部栏。

## 分组

- 默认分组固定在根路径 `/`，自定义分组挂在 `/g/<slug>`；slug 可自定义，留空则随机生成。
- 每个分组有独立的分享列表与上传子目录，文件互不共享；桌面分享面用分组标签切换。
- 每个分组有独立的公开访问、PIN、上传/文字开关，PIN 会话 cookie 按分组路径隔离；账号为全局账号，权限仍按账号全局配置。

## P3 结果（2026-10-22）

- 设置：`settings_get/update/touch_face/pick_directory` 与 PIN/账号命令；JSON 持久化、即时保存、按影响范围自动重启分享。
- 鉴权：链接 / PIN / 账号三级；PIN 与口令 Argon2id；HMAC 会话 cookie；失败锁定；写接口 CSRF 头。
- 上传：multipart 流式写入上传目录（单文件 1GB、单次 20 个），文件名消毒、重名加序号、临时文件刷盘后原子改名；上传项登记进分享列表并触发 SSE。
- 文字：`/api/text` 最长 1 万字，作为 text 项进入列表，访客页可复制。
- 桌面：设置弹窗；并发与保存目录接入现有压缩流程；分享面显示文字与上传项。
- 验证：cargo test 63 项、vitest 95 项通过；访客页 PIN/上传/文字界面通过浏览器预览核对。

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
- 是否支持断点续传上传（目前只有普通 multipart）。
- 是否加入 mDNS 自动发现。
