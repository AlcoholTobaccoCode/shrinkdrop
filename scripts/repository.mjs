import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

export function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')}\n${result.stderr.trim() || result.stdout.trim()}`);
  }
  return { status: result.status, text: result.stdout.trim() };
}

export function options(argv, { positional = false } = {}) {
  const result = { yes: false, dryRun: false, help: false, version: undefined };
  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') result.yes = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (positional && !arg.startsWith('-') && !result.version) result.version = arg;
    else throw new Error(`未知参数：${arg}。使用 --help 查看用法。`);
  }
  return result;
}

export function enterRepository() {
  process.chdir(git(['rev-parse', '--show-toplevel']).text);
}

export function fetchMain(remote) {
  git(['remote', 'get-url', remote]);
  git(['fetch', '--no-tags', remote, `+refs/heads/main:refs/remotes/${remote}/main`]);
  return git(['rev-parse', `refs/remotes/${remote}/main`]).text;
}

export function requireAncestor(ancestor, descendant, message) {
  const { status } = git(['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true });
  if (status === 1) throw new Error(message);
  if (status !== 0) throw new Error('无法比较提交历史，请检查仓库是否为浅克隆或缺少提交。');
}

export async function question(prompt) {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await input.question(prompt)).trim();
  } finally {
    input.close();
  }
}

export async function confirm(plan, { yes, dryRun }) {
  console.log(plan);
  if (dryRun) {
    console.log('\n预演完成：仅查询/获取远端引用，未修改文件、提交、标签或远端分支。');
    return false;
  }
  if (yes) return true;
  if (!process.stdin.isTTY) throw new Error('非交互环境请显式添加 --yes，或使用 --dry-run 预演。');
  if ((await question('\n确认执行？[y/N] ')).toLowerCase() !== 'y') {
    console.log('已取消。');
    return false;
  }
  return true;
}

export function reportError(error) {
  console.error(`\n失败：${error.message}`);
  process.exitCode = 1;
}
