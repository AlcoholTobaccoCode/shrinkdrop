import {
  confirm, enterRepository, fetchMain, git, options, reportError, requireAncestor,
} from './repository.mjs';

async function main() {
  const args = options(process.argv.slice(2).filter(value => value !== '--'));
  if (args.help) {
    console.log(`用法：pnpm sync:public [--dry-run] [--yes]

获取 org/main 和 origin/main，将 org/main 的已提交快照快进推送到 origin/main。
与当前分支、工作区和默认 push 目标无关；不会暂存、提交、合并或覆盖本地文件。
两边历史分叉或公共仓库领先时停止，不强推。此命令只同步 main，不同步标签。
公共 main 更新后会自动打包，产物保留在 Actions；不会发布 Release。
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
  if (!await confirm(`公开同步计划：org/main → origin/main
源提交：${source}
目标当前提交：${target}
待公开提交：
${commits}

将公开这些提交及其历史，并触发公共仓库的 Windows/macOS 打包。
仅推送远端已提交的 main；本地未提交文件、当前分支及标签不参与同步。`, args)) return;
  git(['push', '--no-follow-tags', 'origin', `${source}:refs/heads/main`]);
  console.log(`\n公共 main 已同步到 ${source}。
构建记录：https://github.com/AlcoholTobaccoCode/shrinkdrop/actions/workflows/release.yml`);
}

main().catch(reportError);
