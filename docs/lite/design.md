# shrinkdrop 设计

日期：2026-10-13，交互更新于2026-10-20。用户已确认：不要API key、不要Server，直接走匿名网页接口并沿用固定请求头处理。新增行为见[2026-10-20交互补充](2026-10-20-enhancements.md)。

当前代码只保留桌面压缩与局域网分享。

## 功能与流程

PNG/JPG/WebP图片或文件夹拖入/选择→待处理列表→手动开始或开启自动压缩（最多并发5）→显示原大小、结果大小、节省比例→单图或整批保存副本，或确认后覆盖原图。
自动压缩默认关闭，仅本次会话有效；开启后处理既有待开始项和新导入项，关闭不取消已有任务，失败和取消不自动重试。
保留取消、手动失败重试、保存失败后只重试保存。处理不改图片格式或尺寸。会话结束清理临时结果。
页面采用紧凑行列表，顶部导入区、可滚动结果列表、底部汇总与开始/保存按钮。深浅色跟随系统，键盘可操作；窄窗行内换行，不依赖工作台四列。
匿名图片会上传厂商服务，页面明确提示这一点。每行背景和底部进度线反馈排队/上传/厂商压缩/下载/校验/完成/取消/失败；上传和下载按字节报告，厂商处理阶段不编造百分比。

## 实现

Vue3和Tauri2；Rust reqwest直接处理网络，保留固定User-Agent、Origin、Referer、随机X-Forwarded-For请求头和tinypng.com/tinyjpg.com/tinify.cn站点切换。无官方收费fallback。
单任务总预算240秒，上传并等待响应120秒、结果下载60秒，均按任务剩余预算截断；最多两条固定线路，POST超时后不自动整图重传，交由用户手动重试。401/403/429使用明确匿名拒绝/频率限制文案，禁止无限重试。
前端队列默认并发1–5，其中≥8,000,000字节的大图同时最多2张；缩略图由原生生成160px JPEG，不再把整图跨IPC传给前端。
固定HTTPS站点、不跟随任意跳转、输出URL只接受厂商站点的压缩结果路径；数据上限20MB（20,000,000字节）并验证图像类型，错误不回显任意上游HTML。
任务ID与原图/临时文件ID在Rust注册，取消传播到正在等待的HTTP操作，迟到结果不能覆盖取消状态。全局5槽位兜底，前端任务队列按需调用，仅开启自动压缩后导入才自动上传。
压缩列表支持列表/卡片切换，共用同一任务状态、进度与操作；整行或整卡背景渐变继续表示阶段进度，等待响应阶段显示真实已等待秒数，不伪造百分比。
Tauri原生保存窗口单张保存；全部保存选目录，重复文件名加序号，保留原图，保存失败的项可重试且不再上传。
覆盖使用原生层绑定的原图路径和SHA256摘要，客户端只能提交临时结果ID。每次单张/批量操作均通过依附主窗口的原生确认面板；原图变更、缺失、只读或结果被篡改时拒绝替换。同目录独占创建临时文件，写入刷盘、保留权限，替换前再次检查原图，然后重命名到原路径；失败保留原图和压缩结果。批量支持部分成功，已覆盖项不会再次进入批量操作。
原生拖放事件由Rust注册文件后发lite-files-imported，前端不能传任意路径给read_file。

## IPC合同

choose_files/choose_directory→[{id,name,size,mime,relativePath,lastModified?,handle?}]
read_file({sourceId})→number[]，仅已注册原图。
read_thumbnail({sourceId})→number[]，160px JPEG 缩略图；仅用于列表展示，不暴露路径。
compress_image({sourceId,taskId})→{tempFileId,size,mime,width,height,site}。
cancel_compression({taskId})→void，先到的取消同样有效。
save_temp_file({tempFileId,suggestedName})→{saved:boolean}。
save_results({tempFileIds})→{saved:number,failed:[{id,name,message}],canceled:boolean}。
overwrite_temp_file({tempFileId})→{overwritten:boolean}；取消返回false，失败返回用户可理解的错误。
overwrite_results({tempFileIds})→{overwritten:number,failed:[{id,name,message}],canceled:boolean}。
cleanup_temp_files({sessionId})→void；关闭窗口清理全部并取消请求。
lite-files-imported事件payload为原图描述符数组；状态事件lite-progress payload={taskId,stage:'uploading'|'processing'|'downloading'|'verifying',transferred?:number,total?:number}。

## 收缩范围

移除Node Server、SQLite、共享packages、Web处理模式、云端设置、操作链、转换/缩放、URL、云存储、对比画布、Pinia/Reka/fflate等不需要的依赖。保留一套桌面客户端、原生文件保护与小任务队列；2026-10-20按用户要求增加确认后覆盖原图。
浏览器开发预览只展示界面，明确提示需要桌面端处理；不伪造网络成功。

## 证据与验收

2026-10-13真实合成PNG探测：带固定请求头组合，上传HTTP201；结果PNG下载成功，480x360，1539bytes，不用key。
客户端须通过队列取消/重试/保存测试、原生协议边界测试、类型与构建、真实匿名压缩与Mac原生导入/保存验收。结束停止所有临时服务。
