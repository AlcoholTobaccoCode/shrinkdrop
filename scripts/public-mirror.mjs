import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, requireAncestor } from './repository.mjs';

/**
 * 只同步到组织私仓的路径（相对仓库根目录，可含子路径）。
 * 这些路径不会出现在公共仓库的任何提交里：同步按提交重建树，
 * 因此公共提交的哈希必然与组织私仓不同，公共历史是私仓历史的线性镜像。
 */
export const PRIVATE_PATHS = ['org.private'];

/** 镜像提交体里记录来源提交，作为下次同步的基准。 */
const SOURCE_TRAILER = /^Source-Commit: ([0-9a-f]{40,64})$/m;

function isPrivatePath(path) {
  return PRIVATE_PATHS.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

export function treeOf(commit) {
  return git(['rev-parse', `${commit}^{tree}`]).text;
}

/** 按提交重建树并剔除私仓路径；不检出工作区，也不改动本地索引。 */
export function filteredTree(commit) {
  const directory = mkdtempSync(join(tmpdir(), 'shrinkdrop-public-'));
  try {
    const env = { GIT_INDEX_FILE: join(directory, 'index') };
    git(['read-tree', commit], { env });
    git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...PRIVATE_PATHS], { env });
    return git(['write-tree'], { env }).text;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function assertNoPrivatePaths(treeish, label) {
  const leaked = git(['ls-tree', '-r', '--name-only', treeish]).text
    .split('\n')
    .filter(path => path && isPrivatePath(path));
  if (leaked.length) {
    throw new Error(
      `${label} 含有只应留在组织私仓的路径：${leaked.join('、')}。`
      + '请先用 git filter-repo 清理公共仓库历史，再执行同步；脚本不会强推或改写公共历史。',
    );
  }
}

export function lastSyncedSource(commit) {
  const match = SOURCE_TRAILER.exec(git(['log', '-1', '--format=%B', commit]).text);
  return match ? match[1] : null;
}

/**
 * 计算把组织 main 镜像到公共 main 的步骤，不创建对象、不推送。
 * mode=direct：待同步区间没有私仓路径，公共仓可直接快进到同一个提交（哈希一致）。
 * mode=mirror：逐个提交剔除私仓路径后重放，提交哈希与私仓不同，追加 Source-Commit 记录来源。
 */
export function planPublicSync(privateHead, publicHead) {
  const recorded = lastSyncedSource(publicHead);
  if (recorded) {
    requireAncestor(recorded, privateHead,
      `组织 main 已不含上次同步的提交 ${recorded.slice(0, 12)}，历史似被重写。请人工确认后再同步；脚本不会强推。`);
  } else {
    requireAncestor(publicHead, privateHead,
      '公共 main 含有组织 main 尚未包含的提交，无法镜像。请先整合两边历史；脚本不会强推。');
  }
  assertNoPrivatePaths(publicHead, '公共 main 的现有提交');
  const base = recorded ?? publicHead;
  if (git(['rev-list', '--merges', `${base}..${privateHead}`]).text) {
    throw new Error('待同步区间包含合并提交，镜像只支持线性历史。请先 rebase 成线性再同步。');
  }
  const commits = git(['rev-list', '--reverse', '--topo-order', `${base}..${privateHead}`]).text
    .split('\n')
    .filter(Boolean);
  const touchesPrivate = Boolean(git(['rev-list', `${base}..${privateHead}`, '--', ...PRIVATE_PATHS]).text);
  const mode = recorded === null && !touchesPrivate ? 'direct' : 'mirror';
  if (mode === 'direct') return { mode, base, privateHead, publicHead, steps: [] };
  let previousTree = treeOf(publicHead);
  const steps = commits.map(source => {
    const tree = filteredTree(source);
    const skipped = tree === previousTree;
    if (!skipped) previousTree = tree;
    return { source, tree, skipped };
  });
  return { mode, base, privateHead, publicHead, steps };
}

function identity(commit) {
  const [authorName, authorEmail, authorDate, committerName, committerEmail, committerDate] =
    git(['log', '-1', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI', commit]).text.split('\0');
  return { authorName, authorEmail, authorDate, committerName, committerEmail, committerDate };
}

/** 按计划创建镜像提交对象，返回新的公共 main 提交。只写对象，不动任何引用。 */
export function createPublicCommits(plan) {
  if (plan.mode === 'direct') return plan.privateHead;
  let head = plan.publicHead;
  for (const step of plan.steps) {
    if (step.skipped) continue;
    const author = identity(step.source);
    const body = git(['log', '-1', '--format=%B', step.source]).text;
    head = git(['commit-tree', step.tree, '-p', head, '-F', '-'], {
      input: `${body}\n\nSource-Commit: ${step.source}\n`,
      env: {
        GIT_AUTHOR_NAME: author.authorName,
        GIT_AUTHOR_EMAIL: author.authorEmail,
        GIT_AUTHOR_DATE: author.authorDate,
        GIT_COMMITTER_NAME: author.committerName,
        GIT_COMMITTER_EMAIL: author.committerEmail,
        GIT_COMMITTER_DATE: author.committerDate,
      },
    }).text;
  }
  assertNoPrivatePaths(head, '镜像结果');
  return head;
}

export function hasChanges(plan) {
  return plan.mode === 'direct' ? plan.privateHead !== plan.publicHead : plan.steps.some(step => !step.skipped);
}

export function summary(plan) {
  if (plan.mode === 'direct') {
    return `同步方式：快进（待同步区间没有 ${PRIVATE_PATHS.join('、')}，公共提交与私仓一致）\n`
      + git(['log', '--oneline', `${plan.publicHead}..${plan.privateHead}`]).text;
  }
  const lines = plan.steps.map(({ source, skipped }) => {
    const subject = git(['log', '-1', '--format=%h %s', source]).text;
    return skipped ? `${subject}（仅私仓路径改动，公共侧跳过）` : subject;
  });
  return `同步方式：镜像重放（公共提交哈希与私仓不同，隐藏 ${PRIVATE_PATHS.join('、')}）\n${lines.join('\n')}`;
}