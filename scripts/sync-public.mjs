import { readFileSync } from 'node:fs';
import {
  confirm, enterRepository, fetchMain, git, options, reportError,
} from './repository.mjs';
import {
  createPublicCommits, hasChanges, planPublicSync, PRIVATE_PATHS, summary,
} from './public-mirror.mjs';

/** 读取仓库当前版本，与 release 脚本使用同一来源。 */
function currentVersion() {
  return JSON.parse(readFileSync('package.json', 'utf8')).version;
}

/** 该版本是否已在公共仓库打标；有标签说明已经发布过。 */
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

获取 org/main（组织私仓，主仓）和 origin/main（公共仓库），把 org/main 的已提交快照推到公共 main。
${PRIVATE_PATHS.join('、')} 及其历史不会进入公共仓库：待同步区间一旦涉及这些路径，
公共提交改为按提交重建树后重放，因此公共哈希与私仓不同，提交体附带 Source-Commit 记录来源。
区间内没有私仓路径时仍按同一提交快进，两个仓库哈希保持一致。
与当前分支、工作区和默认 push 目标无关；不会暂存、提交、合并或覆盖本地文件。
公共 main 领先或两边历史分叉、区间含合并提交时停止，不强推。此命令只同步 main，不同步标签。
公共 main 更新后会自动打包，产物保留在 Actions；不会发布 Release。
同步结束后会检查当前版本是否已发布，并提示下一步：已发布则需先升版本，
未发布则可用 pnpm release 打标。
--dry-run  获取远端引用并预览提交，不推送。
--yes      跳过最终确认。
示例：pnpm sync:public --dry-run
      pnpm sync:public`);
    return;
  }
  enterRepository();
  const source = fetchMain('org');
  const target = fetchMain('origin');
  const plan = planPublicSync(source, target);
  const version = currentVersion();
  if (!hasChanges(plan)) {
    console.log(`公共 main 已包含组织 main 的全部公开改动（${target}），无需推送。`);
    return;
  }
  const hintLines = publishHint(version);
  const planLines = [
    '公开同步计划：org/main → origin/main',
    `源提交：${source}`,
    `公共当前提交：${target}`,
    summary(plan),
    '',
    '仅推送按上述规则生成的公共 main；本地未提交文件、当前分支及所有标签不参与同步。',
  ];
  if (plan.mode === 'mirror') planLines.push('公共提交哈希与私仓不同，但内容除私仓路径外完全一致。');
  planLines.push('', ...hintLines);
  if (!await confirm(planLines.join('\n'), args)) return;
  const head = createPublicCommits(plan);
  git(['push', '--no-follow-tags', 'origin', `${head}:refs/heads/main`]);
  console.log(`\n公共 main 已同步到 ${head}（来源 org/main ${source}）。`);
  for (const line of hintLines) console.log(line);
  console.log('构建记录：https://github.com/AlcoholTobaccoCode/shrinkdrop/actions/workflows/release.yml');
}

main().catch(reportError);