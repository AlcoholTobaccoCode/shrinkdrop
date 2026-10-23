import { readFileSync, writeFileSync } from 'node:fs';
import {
  confirm, enterRepository, fetchMain, git, options, question, reportError, requireAncestor,
} from './repository.mjs';

const versionFiles = ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

function parseVersion(value) {
  const match = versionPattern.exec(value);
  if (!match) throw new Error(`无效版本：${value}。使用 0.1.1 或 0.2.0-beta.1；不支持 +build 元数据。`);
  return { numbers: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split('.') };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < 3; i++) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1;
  }
  if (!a.prerelease || !b.prerelease) return a.prerelease ? -1 : b.prerelease ? 1 : 0;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function versionField(text, file) {
  const blocks = text.match(file.endsWith('Cargo.lock') ? /\[\[package\]\][\s\S]*?(?=\n\[\[package\]\]|$)/g : /\[package\][\s\S]*?(?=\n\[|$)/g);
  const block = blocks?.find(value => /^name\s*=\s*"shrinkdrop"\s*$/m.test(value) && !/^source\s*=/m.test(value));
  const field = block?.match(/^version\s*=\s*"([^"]+)"/m);
  if (!field) throw new Error(`未找到 ${file} 中 shrinkdrop 的版本字段。`);
  return { block, field: field[0], version: field[1] };
}

function assertTagAbsent(tag) {
  if (git(['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], { allowFailure: true }).status === 0) {
    throw new Error(`本地标签 ${tag} 已存在。已发布版本请递增版本号；不要移动标签。`);
  }
  for (const remote of ['org', 'origin']) {
    if (git(['ls-remote', '--tags', remote, `refs/tags/${tag}`]).text) {
      throw new Error(`${remote} 已存在 ${tag}，请递增版本号。`);
    }
  }
}

async function main() {
  const args = options(process.argv.slice(2).filter(value => value !== '--'), { positional: true });
  if (args.help) {
    console.log(`用法：pnpm release [patch|minor|major|版本号] [--dry-run] [--yes]

无参数时交互选择版本；patch/minor/major 根据当前版本递增。
同步更新四个版本文件、单独提交版本变更、创建注释标签，再推送双仓 main 和标签。
要求位于 main，且所有功能改动已提交；不会自动提交其他文件。
--dry-run  查询远端并打印计划，不修改版本、提交、标签或远端分支。
--yes      跳过最终确认（非交互环境必须显式指定版本）。
示例：pnpm release patch --dry-run
      pnpm release 0.2.0 --yes`);
    return;
  }
  enterRepository();
  if (git(['branch', '--show-current']).text !== 'main') throw new Error('请在 main 分支发布。');
  if (git(['status', '--porcelain', '--untracked-files=all']).text) throw new Error('工作区有未提交文件，请先提交功能改动或自行暂存后发布。');
  const head = git(['rev-parse', 'HEAD']).text;
  const texts = new Map(versionFiles.map(file => [file, readFileSync(file, 'utf8')]));
  const current = JSON.parse(texts.get('package.json')).version;
  parseVersion(current);
  for (const file of versionFiles.slice(1)) {
    const version = file.endsWith('.json') ? JSON.parse(texts.get(file)).version : versionField(texts.get(file), file).version;
    if (version !== current) throw new Error(`版本不一致：package.json=${current}，${file}=${version}。请先统一并提交。`);
  }
  let choice = args.version;
  if (!choice) {
    if (!process.stdin.isTTY) throw new Error('请指定 patch、minor、major 或版本号；使用 --help 查看示例。');
    choice = (await question(`当前版本 ${current}。输入 patch / minor / major / 完整版本号 [patch]：`)) || 'patch';
  }
  let version = choice;
  if (['patch', 'minor', 'major'].includes(choice)) {
    const numbers = parseVersion(current).numbers;
    const index = { major: 0, minor: 1, patch: 2 }[choice];
    numbers[index] += 1n;
    for (let i = index + 1; i < 3; i++) numbers[i] = 0n;
    version = numbers.join('.');
  }
  if (compareVersions(version, current) < 0) throw new Error(`不能从 ${current} 降级到 ${version}。`);
  const tag = `v${version}`;
  for (const remote of ['org', 'origin']) {
    const remoteHead = fetchMain(remote);
    requireAncestor(remoteHead, head, `${remote}/main 有本地尚未包含的提交，请先整合到 main 并提交后发布。`);
  }
  assertTagAbsent(tag);
  const replacements = new Map();
  if (version !== current) {
    for (const [file, text] of texts) {
      if (file.endsWith('.json')) {
        const json = JSON.parse(text);
        json.version = version;
        replacements.set(file, `${JSON.stringify(json, null, 2)}\n`);
      } else {
        const { block, field } = versionField(text, file);
        replacements.set(file, text.replace(block, block.replace(field, field.replace(`"${current}"`, `"${version}"`))));
      }
    }
  }
  const plan = `发布计划：${current} → ${version}
源提交：${head}
版本文件：${replacements.size ? versionFiles.join(', ') : '已是目标版本，无需版本提交'}
标签：${tag}
推送：org/main + ${tag}，然后 origin/main + ${tag}（每个仓库原子推送）
公共标签将触发 Windows/macOS 构建并公开发布 GitHub Release。`;
  if (!await confirm(plan, args)) return;
  if (git(['rev-parse', 'HEAD']).text !== head || git(['status', '--porcelain', '--untracked-files=all']).text) {
    throw new Error('确认期间工作区或 HEAD 已改变，请重新执行。');
  }
  for (const [file, text] of replacements) writeFileSync(file, text);
  if (replacements.size) {
    git(['add', '--', ...versionFiles]);
    git(['commit', '-m', `release: ${version}`]);
  }
  git(['tag', '-a', tag, '-m', `shrinkdrop ${version}`]);
  const releaseHead = git(['rev-parse', 'HEAD']).text;
  try {
    for (const remote of ['org', 'origin']) {
      git(['push', '--atomic', '--no-follow-tags', remote, `${releaseHead}:refs/heads/main`, `refs/tags/${tag}:refs/tags/${tag}`]);
      console.log(`已推送 ${remote}/main 和 ${tag}`);
    }
  } catch (error) {
    throw new Error(`${error.message}\n本地版本提交及标签已保留。修复推送问题后，可对尚未成功的仓库执行：\ngit push --atomic --no-follow-tags <remote> ${releaseHead}:refs/heads/main refs/tags/${tag}:refs/tags/${tag}\n不要重新打标或移动标签。`);
  }
  console.log(`\n发布已触发：https://github.com/AlcoholTobaccoCode/shrinkdrop/actions/workflows/release.yml\n下载页面（构建成功后）：https://github.com/AlcoholTobaccoCode/shrinkdrop/releases/tag/${tag}`);
}

main().catch(reportError);
