# 未签名 macOS 构建：能用什么、怎么打开

日期：2026-11-04
结论先说：**不签名也能用「远程访问」的只读那半，用不了应用内开关。**
`xattr` 能解决“打不开”，解决不了“没有开关”——开关需要 `SMAppService`，而它要求 app 与 helper
用同一个 Apple Team ID 签名。

## 1. 未签名时功能边界

| 能力 | 未签名（当前构建） | 签名后 |
|---|---|---|
| 读取系统 Remote Login 状态（已开启 / 未开启 / 无法确认） | ✅ | ✅ |
| 显示局域网地址、`ssh user@ip`、host key 指纹 | ✅ | ✅ |
| 「打开共享设置」跳到系统设置 | ✅ | ✅ |
| 应用内开关 SSH | ❌（没有开关） | ✅ |
| 「仅应用运行时」退出即关 | ❌ | ✅ |
| 自定义端口 | ❌（macOS 固定 22） | ❌（同样不做，需自建 LaunchDaemon） |
| 压缩、分享、防休眠、设置 | ✅ 不受影响 | ✅ |

原因：应用内开关本质是“以 root 身份注册一个 LaunchDaemon 并控制它”。macOS 只允许通过
`SMAppService` 注册，且要求 app 与 helper 由同一个 Team ID 签名；ad-hoc / 自签名没有 Team ID。
所以未签名构建里，`ssh_status` 走的是只读探测（`launchctl print` + 22 端口 + host key），
`enable/disable/set_port` 一律返回 `read_only`。**这是设计，不是缺功能**。

## 2. 打开未签名构建

下载来的 `.zip`/`.dmg` 会被打上 `com.apple.quarantine`，直接双击会提示“无法验证开发者”。

```bash
# 1) 解压到 /Applications（或任意目录）
ditto -x -k ~/Downloads/shrinkdrop-*.zip /Applications/

# 2) 去掉隔离标记（对你自己的下载目录/解压结果执行）
sudo xattr -rd com.apple.quarantine /Applications/shrinkdrop.app
```

之后双击即可启动。不开终端也行：系统设置 → 隐私与安全性 → 安全性 → 「仍要打开」，
macOS 15+ 已移除“右键 → 打开”的旧入口。

说明与预期：

- `xattr` 只清 quarantine，不改签名。`spctl -a -vv /Applications/shrinkdrop.app` 仍会**拒绝**，
  这是正常的——未签名就是不满足 Gatekeeper；清掉 quarantine 后它能跑。
- Apple Silicon 上每个可执行文件必须有**至少** ad-hoc 签名才能执行；Rust 链接器会自动加，
  所以清 quarantine 后能启动。Intel 上同理，但 macOS 15+ 对未公证 app 的提示更严。
- 若系统仍拦：`xattr -l /Applications/shrinkdrop.app` 看还有没有 quarantine，
  再用 `sudo xattr -rd com.apple.provenance /Applications/shrinkdrop.app`（部分系统版本需要）。
- **不要**对来源不明的包这么做；这里只针对本仓库的构建产物。

## 3. 自签名到底能做到什么

三种“自签名”，能力完全不同：

| 方式 | 能启动 | 别人机器不弹提示 | 有 Team ID | 应用内开关 |
|---|---|---|---|---|
| 链接器 ad-hoc（构建产物自带） | ✅ | ❌ | ❌ | ❌ |
| `codesign --force --deep --sign -`（重签 ad-hoc） | ✅ | ❌ | ❌ | ❌ |
| 钥匙串自建 Code Signing 证书 | ✅（本机信任后） | ❌ | ❌ | ❌ |
| Apple Developer 免费账号（Apple Development 证书） | ✅ | ❌（仅团队内） | ✅ | 取决于是否实现 helper |
| Developer ID + 公证（99 美元/年） | ✅ | ✅ | ✅ | 需实现 helper |

关键点：**签名不是唯一的前置条件。** macOS 的应用内开关需要
（1）`SMAppService` 注册 LaunchDaemon 的 helper 实现——**这一版还没做**（plan 的 T4）；
（2）app 与 helper 同 Team ID 签名。
所以：

- 只做 ad-hoc：能跑，开关还是没有；
- 自建证书：能跑（本机信任后），开关还是没有，而且换台机器要重新信任；
- 就算买了 Developer ID，也还要先把 T4 的 helper 写完（估 1–2 天，含安装/卸载/崩溃兜底）。

自签命令（只是让签名信息完整，不改变上面任何一行）：

```bash
codesign --force --deep --sign - /Applications/shrinkdrop.app
```

自建证书签名：

```bash
# 钥匙串访问 → 证书助理 → 创建证书 → 类型选“代码签名”，然后用它的名字：
codesign --force --deep --sign "shrinkdrop self-signed" /Applications/shrinkdrop.app
```

⚠️ 自签证书签出来的 app 不要在别的机器上 `spctl --master-disable` 来“解决”问题；那是关 Gatekeeper，等于对所有下载生效。

## 4. 打开后怎么验

按 `docs/ssh/macos-regression.md` 的 R1–R6 走一遍即可，最短路径：

1. 设置 → 远程访问：应只有「打开共享设置」按钮，没有开关；状态是 `未开启` 或 `系统已启用`。
2. 系统设置 → 通用 → 共享 → 远程登录 打开；回到面板切走再切回：状态变 `系统已启用`，
   出现 `ssh 用户名@IP` 和 `SHA256:...` 指纹。
3. 用另一台机器 `ssh 用户名@IP` 登录，确认指纹与面板一致。
4. 关闭远程登录，面板应回到 `未开启`（不是缓存）。
5. 确认只读边界：`~/Library/Application Support/com.shrinkdrop.app/settings.json` 里的
   `ssh.enabled` 始终是 `false`；`ls /Library/LaunchDaemons | grep -i shrinkdrop` 无输出。

## 5. 什么时候必须签名

只有当你想在应用内一键开关、并要“退出应用即关闭”时。那时需要 Apple Developer Program
（99 美元/年）、Developer ID Application 证书，以及 helper 的 `SMAppService` 注册；
步骤见 `docs/ssh/signing-setup.md` §9。
