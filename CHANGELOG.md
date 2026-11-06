# Changelog

本项目的重要变更记录在此文件。格式参考 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning 2.0.0](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.7] - 2026-11-06

### Added

- 设置里的「远程访问」支持 Windows 全功能：开启/关闭系统 OpenSSH Server、两种生命周期（仅应用运行时 / 后台常驻）、自定义端口（改端口会重启 sshd 并回滚失败的改动）、端口占用检测、防火墙放行、host key 指纹。
- Windows 缺少 OpenSSH 时提供两条兜底：打开官方发布页，或安装随包固定版 MSI（安装前校验 SHA256，不静默安装）。
- macOS 13+ 在不签名构建里以只读方式展示系统「远程登录」状态，并提供“打开共享设置”入口；不写系统配置。

### Fixed

- Windows：辅助服务没在运行时，设置面板不再显示成 macOS 的只读界面（不再出现「打开共享设置」），改为提示安装辅助服务并给出按钮。
- Windows：安装辅助服务会真正启动服务并等到进入运行状态；失败时直接显示 Win32 错误码，不再出现“装完仍提示不可用”。
- Windows：卸载辅助服务补齐删除权限，之前会静默失败。
- Windows：防火墙规则按名字幂等创建，并对「域」网络一起放行，与系统 OpenSSH 的规则一致。
- 「远程访问」面板按平台显示提示：macOS 只显示共享设置、睡眠与 FileVault；Windows 只显示辅助服务、防火墙与网段相关提示。未在监听时不再显示连不上的连接命令。

### Notes

- Windows 已在真机验证到设置面板与安装流程；完整 SSH 登录验收仍未跑完。macOS 未签名构建仅只读。

## [0.1.6] - 2026-11-02

本版本作为 changelog 基线，之前版本未追溯。

[Unreleased]: ../../compare/v0.1.7...HEAD
[0.1.7]: ../../compare/v0.1.6...v0.1.7
[0.1.6]: ../../releases/tag/v0.1.6
