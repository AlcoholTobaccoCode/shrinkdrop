# 日常协作与发布规范

本文件只在组织私仓 `org`，不会出现在公共仓库。改动同步流程本身时，先看第 6、7 节。

## 1. 仓库角色

| 远端 | 仓库 | 角色 |
|---|---|---|
| `org` | `far-domain/shrinkdrop`（private） | **主仓**，唯一写入面；本地 `main` 跟踪它，裸 `git push` 默认推它 |
| `origin` | `AlcoholTobaccoCode/shrinkdrop`（public） | `org/main` 的过滤镜像；承载 Pages、公开 CI 与 Release |

- 只在 `org` 上开发提交；`origin/main` 由 `pnpm sync:public` / `pnpm release` 生成，**不要直接 push 或 commit**。
- 公共仓的 issue、PR 只能以 patch 形式带回私仓：两边提交哈希不同，不能 merge，也不能 cherry-pick。
- 私仓 push 会跑 `.github/workflows/ci.yml`；`release.yml` 有 `github.repository` 守卫，在私仓整体跳过。

## 2. 每日循环

```bash
git switch main && git pull          # pull 来自 org
# 改代码
pnpm test                            # 至少覆盖改动相关用例
git add -A && git commit             # 格式见第 4 节
git push                             # = git push org main
pnpm sync:public                     # 有新提交就同步公开仓
```

- `pnpm sync:public --dry-run` 先看计划，确认后去掉；自动化场景加 `--yes`。
- 同步只取**远端已提交**的 `main`：没 push 到 org 的提交不会公开；未提交文件也不会。
- 同步与发布都不读工作区、不改本地分支，可在任意本地分支上执行。

## 3. 分支、历史与存档

- `main` 必须线性。镜像只支持线性历史，区间内出现 merge 提交时同步直接中止。
- 临时分支用 `codex/<主题>`，合回 `main` 用 `git rebase` 或 squash，不产生 merge commit。
- 已推到 `org/main` 的提交不要 force-push、amend 或 rebase 重写：镜像以提交体里的 `Source-Commit` 为基线，重写会被判为分叉并拒绝同步。
- 需要长期冻结的节点打 `archive/<主题>` 标签（例：`archive/pre-batch-split`），不要靠长期分支存档；`codex/*` 用完即删。

## 4. 提交规范

格式：`<type>(<scope>): <emoji> <中文描述>`；type 小写，scope 用已有模块名。

| type | 用途 | 例 |
|---|---|---|
| `feat` | 新功能 | `feat(share): 🖼️ 修复上传预览与重复保存，新增多文件上传` |
| `fix` | 缺陷修复 | `fix(settings): 🐛 修复 Windows 打开设置后白屏` |
| `perf` | 性能 | `perf(settings): 🔐 防休眠改为一次授权、常驻 root helper` |
| `refactor` | 重构，无行为变化 | `refactor(brand): ...` |
| `style` | 纯样式/格式 | `style(share): ...` |
| `docs` | 文档 | `docs(ssh): 🔌 补充端口与占用检测` |
| `ci` | 流水线 | `ci: 🔁 main 推送在对应标签已存在时跳过重复打包` |
| `chore` | 杂务、依赖、脚本 | `chore(release): ...` |
| `release` | 版本提交，只由 `pnpm release` 产生 | `release: 0.1.6` |

- 现有 scope：`share`、`settings`、`compress`、`installer`、`i18n`、`power`、`windows`、`deps`、`release`、`ci`、`docs`、`brand`、`ssh`、`sync`。新增模块再补一个。
- 一个提交一件事；不要把无关格式化、版本号、文档混进同一个提交。
- 描述写清"做了什么 + 为什么"，不写 "update files"。
- 用户可见的行为变化同步写 `CHANGELOG.md` 的 `[Unreleased]`（规范见 `docs/changelog-spec.md`）。

## 5. `org.private` 使用边界

放这里：密钥与账号样例、内部决策、客户信息、只许内部看的草稿。

- 本目录随私仓历史提交，**不要**加进 `.gitignore`。
- 代码、构建、CI **不得**引用本目录：公共仓是私仓树减掉本目录，引用会导致公共构建失败。
- 需要公开的内容放到仓库其他位置；从本目录复制出去的内容按公开处理。
- `pnpm check:secrets` 只扫描 `dist`，源码与文档里的密钥靠人工检查，提交前自己过一眼 diff。

## 6. 发版

```bash
pnpm release patch --dry-run         # 预览计划
pnpm release patch                   # 交互确认后执行
```

发布动作：升四个版本文件（`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`）→ 单独 `release: <版本>` 提交 → 打注释标签 `v<版本>` → 推 `org` main + 标签 → 镜像 main 到 `origin` 并在公共仓同位置打**轻量**标签 → 公共标签触发双平台构建并发布 Release。

- 标签一旦推送不要移动；发错了升版本重发。
- 公共仓 `v<版本>` 必须等于公共 `package.json` 的 version，流水线会校验。
- 公共 `main` 推送只产出 Actions Artifacts（保留 90 天）；发布 Release 靠标签。
- 同步不会带标签，`release` 是唯一产生公共标签的入口。

## 7. 失败与恢复

| 报错/现象 | 含义 | 处理 |
|---|---|---|
| `公共 main 含有组织 main 尚未包含的提交` | 有人在公共仓直接提交过 | 以 patch 把改动带回私仓并提交，再同步 |
| `组织 main 已不含上次同步的提交` | 私仓历史被重写 | 停止同步，人工比对；不要用 force-push 掩盖 |
| `待同步区间包含合并提交` | 区间内有 merge | rebase 成线性后重试 |
| `含有只应留在组织私仓的路径` | 公共历史已泄漏 | 停止公开推送，用 `git filter-repo` 清理公共历史后重试 |
| `LibreSSL SSL_ERROR_SYSCALL` | 网络/代理抖动 | 直接重跑；镜像提交哈希确定，重试安全 |
| `组织私仓已发布 … 公共仓库未完成` | org 已发版，origin 未完成 | 按提示执行 `git push --atomic …`，或先 `pnpm sync:public --yes` 再推标签 |

同步的两种模式：

- **快进**：区间内没有 `org.private` 改动，公共仓直接前移到同一提交，两仓哈希一致。
- **镜像重放**：区间涉及 `org.private`，公共提交按提交重建树后重放，哈希与私仓不同，提交体带 `Source-Commit: <私仓提交>` 作为下次基线；只改 `org.private` 的提交在公共侧跳过。

## 8. 提交前校验

```bash
pnpm test
pnpm build
pnpm check:secrets
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

与公共仓 `ci.yml` 一致；私仓 push 也会跑同一套，别把它当免费门禁。