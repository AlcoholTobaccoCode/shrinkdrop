# TinyPNG Cross Platform

Vue 3 + Tauri 2 图片工作台，Web 和桌面共用操作链与任务状态。默认本地私有模式；加入图片只生成草稿，点击「开始处理」后才执行，同时处理最多 5 张。

## 第一阶段

- 本地：压缩、PNG/JPG/WebP 转换、缩放，处理期间不发网络请求。
- 云端：上传到自用 Node/TypeScript Server，选择匿名 Tinify 或官方 Tinify。匿名仅支持压缩，操作不支持时明确提示，需用户手动换线路。
- 单张下载、ZIP 批量下载、取消、失败重试；已处理但保存失败时只重试保存。
- SQLite 保存任务；Server 重启后未完成任务可重试，临时文件保留 24 小时。单文件上限 20MB，所有用户共享 Server 的 5 个处理槽位。
- `inside` 不放大小图；`contain` 不放大小图并居中补到固定画布，PNG/WebP 透明、JPG 白底；`cover` 从中心裁切到固定尺寸。

覆盖原图、S3/GCS 上传、裁切、兴趣区和元数据属于后续阶段。Web 的 PNG 编码效果不保证与 Tinify 相同，界面会提示。

## 启动 Web 和桌面

本次验证环境为 macOS arm64、Node 22.16.0、pnpm 11.3.0、Rust 1.96.0。桌面还需要对应平台的 [Tauri 开发依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

访问 `http://127.0.0.1:5170`。端口占用时会明确报错，避免桌面端连接错端口。

```bash
# 另开一套桌面开发环境时，先停止上面的 pnpm dev
pnpm tauri dev

# Web 正式构建
pnpm build
pnpm check:secrets
```

Tauri 的原图路径只保存在 Rust 中。下载使用原生保存窗口；取消保存不会重做压缩，保存失败后可重试。客户端令牌在 Web 中存于 sessionStorage，在桌面端存于系统钥匙串。

## 配置和启动 Server

在项目根目录执行：

```bash
pnpm server:init
pnpm server:dev
```

初始化会生成 `server/config/server.json`，只保存随机访问令牌的 SHA-256，并在终端显示原令牌一次。已有配置不会覆盖。默认监听 `127.0.0.1:8787`。客户端切到云端后填 Server 地址 `http://127.0.0.1:8787` 和刚才的访问令牌，连接后选择处理线路。

生产启动可用 `pnpm server:start`。默认配置可参考 [server/config/server.example.json](server/config/server.example.json)：

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "concurrency": 5,
  "maxFileBytes": 20971520,
  "tmpTtlHours": 24,
  "providerTimeoutMs": 60000,
  "maxRetries": 2,
  "corsOrigins": ["http://127.0.0.1:5170", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"],
  "anonymousTinify": { "enabled": true },
  "auth": {
    "disabled": false,
    "tokens": [{ "id": "qingshan", "label": "QingShan", "sha256": "填64位SHA-256" }]
  }
}
```

多人使用时每个人配一个不同令牌和 `id`，批次按 `id` 隔离。监听局域网或公网地址必须启用认证。把实际 Web 的来源加入 `corsOrigins`；这里填页面的协议、主机和端口，不是 Server 的地址。`SERVER_CONFIG` 可指定配置文件，`SERVER_DATA_DIR` 可指定 SQLite 和临时文件目录。

### 官方账号池和用量

在项目根目录放 `TinifyAccounts.json`，兼容旧数组格式：

```json
[
  { "username": "demo@example.com", "api_key": "填写真实TinifyKey", "monthlyLimit": 500, "enabled": true }
]
```

`TINIFY_ACCOUNTS` 可指定文件路径。一个 key 只配置一次，多人通过各自的访问令牌共用这个账号池。API key 仅供 Server 使用，不发送给客户端、日志或 SQLite。

官方用量来自响应头 `Compression-Count`；启动、每 30 分钟、每次请求后以及手动刷新时更新。缺少有效计数就显示「用量未知」。界面的剩余数是 `monthlyLimit - 已用次数` 的**配置预算**，不代表付费账户的全部剩余额度；转换和缩放等收费操作也计入预算。详见 [Tinify 用量说明](https://tinify.com/developers/reference/http#compression-count)。

Server 给每条管线预留预计次数，并在每个收费步骤前复核最新计数。同一个 key 在其他软件或另一台 Server 中产生的并发消耗无法用本机锁控制；本服务收到新计数或 429 后会更新预算并停止继续下单。

匿名线路依赖厂商网页接口，可能不可用。配置 `anonymousTinify.enabled: false` 即可关闭；错误会显示给用户，不会自动转官方收费线路。

### S3、兼容 S3 和 GCS 配置（后续阶段预留）

文件位置是 `server/config/storage.json`，第一阶段只做本地下载，不会据此上传：

```json
{
  "profiles": [
    { "id": "my-s3", "type": "s3", "bucket": "imgs", "region": "ap-east-1", "accessKeyId": "填写访问ID", "secretAccessKey": "填写访问密钥", "prefix": "tinypng/" },
    { "id": "minio", "type": "s3", "endpoint": "https://minio.example.com", "region": "us-east-1", "bucket": "imgs", "accessKeyId": "填写访问ID", "secretAccessKey": "填写访问密钥", "forcePathStyle": true },
    { "id": "my-gcs", "type": "gcs", "bucket": "imgs", "keyFile": "./gcs-service-account.json" }
  ]
}
```

S3 兼容服务填其实际 `endpoint`，`region` 和 `forcePathStyle` 按服务要求设置。GCS 服务账号 JSON 放在 Server 的配置目录。账号池、Server 配置、存储凭据和 `server/data/` 都在 Git 排除规则中。

## 验证

```bash
pnpm test
pnpm test:server
pnpm --filter @tinypng/server typecheck
pnpm build
pnpm check:secrets
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo check --manifest-path src-tauri/Cargo.toml --locked
```

Server 测试强制使用空账号 fixture，不读取开发者的真实账号池，也不对官方 key 发请求。

浏览器与 macOS 实测、真实 Tinify 和其他平台的验收状态分别记录在 [第一阶段验收记录](docs/superpowers/plans/2026-10-13-phase1-verification.md)。模拟 Provider 的测试不会记成真实 Tinify 成功。
