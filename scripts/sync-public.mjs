import { readFileSync } from 'node:fs';
import {
  confirm, enterRepository, fetchMain, git, options, reportError, requireAncestor,
} from './repository.mjs';

/** 读取仓库当前版本，与 release 脚本使用同一来源。 */
function currentVersion() {
  return JSON.parse(readFileSync('package.json', 'utf8')).version;
}

/** 该版本是否已有远端标签；有标签说明已经发布过。 */
function tagPublished(version) {
  return Boolean(git(['ls-remote', '--tags', 'origin', `refs/tags/v${version}`]).text.trim());
}

/**
 * 同步只负责公开代码，不负责发版；这里提示下一步，避免把新提交错标成旧版本。
 * 返回需要打印的提示行。
 */
function publishHint(version) {
  if (tagPublished(version)) {
    return [
      `版本 ${version} 已有发布标签 v${version}，本次同步的新提交不会进入该 Release。`,
      `若这批提交需要发布，请先升版本：pnpm release patch --dry-run，确认后去掉 --dry-run。`,
    ];
  }
  return [
    `版本 ${version} 尚未打标发布。若这批提交就是该版本内容，运行 pnpm release ${version} 发布；`,
    '否则先升版本再发布。同步本身不会触发 Release。',
  ];
}

async function main() {
  const args = options(process.argv.slice(2).filter(value => value !== '--'));
  if (args.help) {
    console.log(`用法：pnpm sync:public [--dry-run] [--yes]

获取 org/main 和 origin/main，将 org/main 的已提交快照快进推送到 origin/main。
与当前分支、工作区和默认 push 目标无关；不会暂存、提交、合并或覆盖本地文件。
两边历史分叉或公共仓库领先时停止，不强推。此命令只同步 main，不同步标签。
公共 main 更新后会自动打包，产物保留在 Actions；不会发布 Release。
同步结束后会检查当前版本是否已发布，并提示下一步：已发布则需先升版本，
未发布则可用 pnpm release 打标。
--dry-run  获取远端引用并预览提交，不推送。
--yes      跳过最终确认。
示例：git push org main
      pnpm sync:public --dry-run
      pnpm sync:public`);
    return;
  }
  enterRepository();
  const source = fetchMain('org');
  const target = fetchMain('origin');
  if (source === target) {
    console.log(`双仓 main 已一致：${source}。无需推送。`);
    return;
  }
  requireAncestor(target, source, 'origin/main 包含 org/main 尚未包含的提交，无法快进同步。请先整合两边历史后重试；脚本不会强推。');
  const commits = git(['log', '--oneline', `${target}..${source}`]).text;
  const version = currentVersion();
  const hintLines = publishHint(version);
  if (!await confirm(`公开同步计划：org/main → origin/main
源提交：${source}
目标当前提交：${target}
待公开提交：
${commits}

将公开这些提交及其历史，并触发公共仓库的 Windows/macOS 打包。
仅推送远端已提交的 main；本地未提交文件、当前分支及标签不参与同步。

${hintLines.join('\n')}`, args)) return;
  git(['push', '--no-follow-tags', 'origin', `${source}:refs/heads/main`]);
  console.log(`\n公共 main 已同步到 ${source}。`);
  for (const line of hintLines) console.log(line);
  console.log('构建记录：https://github.com/AlcoholTobaccoCode/shrinkdrop/actions/workflows/release.yml');
}

main().catch(reportError);
