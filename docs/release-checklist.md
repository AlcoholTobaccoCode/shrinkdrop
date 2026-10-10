# 发布检查清单

- [ ] 版本号同步 `package.json`、`src-tauri/tauri.conf.json` 和发布 tag。
- [ ] `pnpm install --frozen-lockfile`、`pnpm build`、`pnpm test` 通过。
- [ ] Web 浏览器测试在带 Chromium 的 CI runner 通过。
- [ ] macOS universal 安装包能启动，Windows x64 安装包能启动。
- [ ] 文件选择、目录扫描、拖拽、取消、重试、下载和错误提示已验证。
- [ ] 桌面端原子覆盖失败时不会提示成功，窗口退出后临时文件已清理。
- [ ] Web 端不展示覆盖原图入口，复制不支持时有明确错误文案。
- [ ] 未配置代码签名时不得把产物称为生产发布版本。
- [ ] 隐私文档与实际 Provider 行为一致。
