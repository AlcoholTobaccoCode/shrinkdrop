# 轻量版发布检查

- [ ] 功能改动已提交；使用 `pnpm release <版本或 patch/minor/major> --dry-run` 检查 package.json、Cargo.toml、Cargo.lock、tauri.conf.json 与标签，确认后去掉 `--dry-run` 发布。
- [x] frozen依赖安装、Vue类型、Vitest、Web构建及敏感内容扫描通过。
- [x] Rust取消、固定网址、图像校验、限额及文件保存测试通过。
- [x] PNG/JPG/WebP匿名实际压缩成功，格式和尺寸保持原样。
- [x] 原生文件/目录导入、手动开始、取消、重试、单张与全部保存已验。
- [ ] Finder到窗口的真实拖放验收。
- [x] 退出后请求和临时结果已清理，开发测试端口已关闭。
- [ ] macOS和Windows安装包各自有原生启动验收；未验平台保持待验。
- [ ] 记录代码签名与 macOS 公证状态；未签名安装包必须在下载说明中明确标注，原生启动验收单独记录。
- [x] 隐私文档与匿名上传行为一致。
