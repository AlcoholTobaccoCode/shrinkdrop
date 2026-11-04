# Changelog

本项目的重要变更记录在此文件。格式参考 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning 2.0.0](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 设置里的「远程访问」支持 Windows 全功能：开启/关闭系统 OpenSSH Server、两种生命周期（仅应用运行时 / 后台常驻）、自定义端口（改端口会重启 sshd 并回滚失败的改动）、端口占用检测、防火墙放行、host key 指纹。
- Windows 缺少 OpenSSH 时提供两条兜底：打开官方发布页，或安装随包固定版 MSI（安装前校验 SHA256，不静默安装）。
- macOS 13+ 在不签名构建里以只读方式展示系统「远程登录」状态，并提供“打开共享设置”入口；不写系统配置。

### Notes

- Windows 侧尚未在真机上验证（仅通过交叉类型检查与平台无关单测）；辅助服务二进制尚未打进安装包。

## [0.1.6] - 2026-11-02

本版本作为 changelog 基线，之前版本未追溯。

[Unreleased]: ../../compare/v0.1.6...HEAD
[0.1.6]: ../../releases/tag/v0.1.6
