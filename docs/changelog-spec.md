# Changelog 规范

- 文件：仓库根目录 `CHANGELOG.md`
- 格式：Keep a Changelog 1.1.0
- 版本：Semantic Versioning 2.0.0
- 面向读者：用户、集成方和维护者；条目描述可观察行为，不写内部重构细节

## 1. 版本号

| 变更类型 | 版本位 | 示例 |
| --- | --- | --- |
| 不兼容的 API、设置或行为变更 | MAJOR | `1.0.0 → 2.0.0` |
| 向后兼容的新功能 | MINOR | `0.1.6 → 0.2.0` |
| 向后兼容的问题修复 | PATCH | `0.1.6 → 0.1.7` |
| 预发布 | 后缀 | `0.2.0-beta.1` |

`0.x` 阶段允许 MINOR 带破坏性变更，但必须在 `Changed` 或 `Removed` 中明确写出。

前四项由 `scripts/release.mjs` 校验：

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`

Git 标签 `v<version>` 由 `.github/workflows/release.yml` 校验必须与版本一致；`release.mjs` 只负责拒绝已存在标签并创建新标签。

## 2. 文件结构

```markdown
# Changelog

## [Unreleased]

## [0.2.0] - 2026-12-01

### Added
- 新功能

### Changed
- 行为或默认值调整

### Fixed
- 用户可见的问题修复

### Security
- 安全修复

[Unreleased]: ../../compare/v0.2.0...HEAD
[0.2.0]: ../../compare/v0.1.6...v0.2.0
```

根目录 `CHANGELOG.md` 使用上述相对链接，避免硬编码仓库地址。

允许的分类：

- `Added`：新功能
- `Changed`：现有行为变更
- `Deprecated`：即将移除的能力
- `Removed`：已移除的能力
- `Fixed`：问题修复
- `Security`：漏洞、权限或数据安全修复

没有条目的分类不要保留空标题。

## 3. 写作规则

1. 用用户能理解的结果描述，不写“重构了 X 模块”。
2. 每条以动词开头，一句话说清影响；必要时补充平台或限制。
3. 破坏性变更必须写明迁移方式或替代入口。
4. 同一变更只出现在一个分类中；安全修复优先放 `Security`。
5. 不粘贴完整 commit 列表，不按提交顺序记录。
6. 可以附 issue/PR 编号，但不强制。
7. 日期使用 `YYYY-MM-DD`，以发布当天为准。
8. 已发布版本的条目只做事实纠错，不追加重写历史。
9. 不写未交付的计划；计划放在文档或里程碑中。
10. 中英文均可，同一版本内保持一致；用户可见名称保留原文。

示例：

```markdown
### Fixed
- 修复覆盖原图时，外部程序修改文件后仍继续写入的问题。
- 修复 macOS 通用安装包在 Intel 机器上启动失败的问题。

### Changed
- 默认并发数从 3 调整为 5。
```

## 4. 更新时机

- 每个用户可见变更的 PR 同时更新 `[Unreleased]`。
- 纯内部重构、测试调整、依赖升级且无行为变化，可以不写。
- 在运行 `pnpm release` **之前**把 `[Unreleased]` 内容移到新版本标题下，补日期与 compare 链接，并单独提交；`release.mjs` 只提交四个版本文件并打标签，工作区有未提交文件会拒绝发布。
- 当前 Release 说明由 `scripts/prepare-release.mjs` 的固定模板生成，不读取 `CHANGELOG.md`；实现自动提取前，发布后按需手工补充，且不要重跑该标签（重跑会覆盖 Release 说明与资产）。
- 修复已发布版本的错误条目时，只改该版本段落，并在必要时补一条当前版本的 `Fixed`。

## 5. 发布检查清单

- [ ] `[Unreleased]` 已清空或移到新版本
- [ ] 新版本日期、compare 链接正确
- [ ] 破坏性变更写明迁移方式
- [ ] 版本号在四处元数据一致
- [ ] Git 标签等于 `v<version>`，且发布前 changelog 已提交
- [ ] 如手工补充了 Release 说明，确认该标签未被重跑覆盖
