import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const releaseScript = fileURLToPath(new URL('../scripts/release.mjs', import.meta.url));
const syncScript = fileURLToPath(new URL('../scripts/sync-public.mjs', import.meta.url));
const versionFiles = ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];
const temporaryRoots: string[] = [];

function versionContents(version: string) {
  return {
    'package.json': `${JSON.stringify({ name: 'shrinkdrop', version, private: true }, null, 2)}\n`,
    'src-tauri/tauri.conf.json': `${JSON.stringify({ productName: 'ShrinkDrop', version }, null, 2)}\n`,
    'src-tauri/Cargo.toml': `[package]\nname = "shrinkdrop"\nversion = "${version}"\nedition = "2021"\n\n[dependencies]\nother = "1.2.3"\n`,
    'src-tauri/Cargo.lock': `version = 4\n\n[[package]]\nname = "other"\nversion = "1.2.3"\n\n[[package]]\nname = "shrinkdrop"\nversion = "1.2.3"\nsource = "registry+https://example.invalid/index"\n\n[[package]]\nname = "shrinkdrop"\nversion = "${version}"\ndependencies = ["other"]\n`,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'shrinkdrop-release-'));
  temporaryRoots.push(root);
  const home = join(root, 'home');
  const hooks = join(root, 'empty-hooks');
  const work = join(root, 'work');
  const org = join(root, 'org.git');
  const origin = join(root, 'origin.git');
  mkdirSync(home);
  mkdirSync(hooks);
  mkdirSync(work);
  const config = join(home, 'gitconfig');
  writeFileSync(config, `[core]\n\thooksPath = ${JSON.stringify(hooks)}\n[commit]\n\tgpgSign = false\n[tag]\n\tgpgSign = false\n`);
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: config,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Release Test',
    GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
    GIT_COMMITTER_NAME: 'Release Test',
    GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  });

  function command(executable: string, args: string[], cwd = work) {
    const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', input: '', timeout: 10_000 });
    if (result.error) throw result.error;
    return result;
  }

  function git(args: string[], cwd = work) {
    const result = command('git', args, cwd);
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  }

  function commitFile(cwd: string, name: string, text: string) {
    writeFileSync(join(cwd, name), text);
    git(['add', '--', name], cwd);
    git(['commit', '-m', `Add ${name}`], cwd);
    return git(['rev-parse', 'HEAD'], cwd);
  }

  function publisher(remote: string, name: string) {
    const cwd = join(root, name);
    git(['clone', '--quiet', remote, cwd]);
    return cwd;
  }

  function localState() {
    return {
      head: git(['rev-parse', 'HEAD']),
      branch: git(['branch', '--show-current']),
      tags: git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags']),
      status: git(['status', '--porcelain', '--untracked-files=all']),
      diff: git(['diff', '--binary', 'HEAD']),
      files: Object.fromEntries([...versionFiles, 'notes.txt'].map(file => [file, readFileSync(join(work, file), 'utf8')])),
    };
  }

  function remoteRefs(cwd: string) {
    return git(['for-each-ref', '--format=%(refname) %(objectname)'], cwd);
  }

  function state() {
    return { local: localState(), org: remoteRefs(org), origin: remoteRefs(origin) };
  }

  git(['init', '--quiet', '--initial-branch=main']);
  git(['init', '--quiet', '--bare', '--initial-branch=main', org]);
  git(['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  mkdirSync(join(work, 'src-tauri'));
  for (const [file, text] of Object.entries(versionContents('1.2.3'))) writeFileSync(join(work, file), text);
  writeFileSync(join(work, 'notes.txt'), 'Committed application content\n');
  git(['add', '.']);
  git(['commit', '-m', 'Initial application']);
  git(['remote', 'add', 'org', org]);
  git(['remote', 'add', 'origin', origin]);
  git(['push', '--quiet', 'org', 'main']);
  git(['push', '--quiet', 'origin', 'main']);

  return {
    work, org, origin, git, command, commitFile, publisher, localState, remoteRefs, state,
    release: (...args: string[]) => command(process.execPath, [releaseScript, ...args], join(work, 'src-tauri')),
    sync: (...args: string[]) => command(process.execPath, [syncScript, ...args], join(work, 'src-tauri')),
  };
}

function expectSuccess(result: SpawnSyncReturns<string>) {
  expect(result.status, String(result.stderr || result.stdout)).toBe(0);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('release scripts with isolated local remotes', () => {
  it('bumps exactly four version files, creates an annotated tag, and publishes the same commit and tag to both remotes', () => {
    const f = fixture();
    f.git(['config', 'push.followTags', 'true']);
    f.git(['tag', '-a', 'unrelated-local-tag', '-m', 'Must remain local']);
    const before = f.localState();

    expectSuccess(f.release('patch', '--yes'));

    const head = f.git(['rev-parse', 'HEAD']);
    expect(head).not.toBe(before.head);
    expect(f.git(['rev-parse', 'HEAD^'])).toBe(before.head);
    expect(f.localState().files).toEqual({ ...versionContents('1.2.4'), 'notes.txt': before.files['notes.txt'] });
    expect(f.git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n').sort()).toEqual([...versionFiles].sort());
    expect(f.git(['status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect(f.git(['cat-file', '-t', 'refs/tags/v1.2.4'])).toBe('tag');
    expect(f.git(['rev-parse', 'v1.2.4^{}'])).toBe(head);
    const tagObject = f.git(['rev-parse', 'refs/tags/v1.2.4']);
    for (const remote of [f.org, f.origin]) {
      expect(f.git(['rev-parse', 'refs/heads/main'], remote)).toBe(head);
      expect(f.git(['rev-parse', 'refs/tags/v1.2.4'], remote)).toBe(tagObject);
      expect(f.git(['rev-parse', 'v1.2.4^{}'], remote)).toBe(head);
      expect(f.git(['for-each-ref', '--format=%(refname)', 'refs/tags'], remote)).toBe('refs/tags/v1.2.4');
    }
  }, 30_000);

  it('leaves version files, HEAD, tags, and both remotes unchanged during a release dry-run', () => {
    const f = fixture();
    const before = f.state();

    expectSuccess(f.release('minor', '--dry-run'));

    expect(f.state()).toEqual(before);
  }, 30_000);

  it('rejects a dirty release without staging, committing, tagging, or publishing its changes', () => {
    const f = fixture();
    writeFileSync(join(f.work, 'notes.txt'), 'Private uncommitted edit\n');
    writeFileSync(join(f.work, 'untracked.txt'), 'Untracked private content\n');
    const before = f.state();

    expect(f.release('patch', '--yes').status).not.toBe(0);

    expect(f.state()).toEqual(before);
    expect(readFileSync(join(f.work, 'untracked.txt'), 'utf8')).toBe('Untracked private content\n');
  }, 30_000);

  it('rejects existing local or remote release tags and either remote being ahead without release side effects', () => {
    for (const blocker of ['local-tag', 'org-tag', 'origin-tag', 'org-ahead', 'origin-ahead']) {
      const f = fixture();
      if (blocker === 'local-tag') {
        f.git(['tag', '-a', 'v1.2.4', '-m', 'Already released']);
      } else {
        const remote = blocker.startsWith('org-') ? f.org : f.origin;
        const publisher = f.publisher(remote, 'publisher');
        if (blocker.endsWith('-tag')) {
          f.git(['tag', '-a', 'v1.2.4', '-m', 'Already released'], publisher);
          f.git(['push', 'origin', 'refs/tags/v1.2.4'], publisher);
        } else {
          f.commitFile(publisher, 'remote-only.txt', 'Remote work not integrated locally\n');
          f.git(['push', 'origin', 'main'], publisher);
        }
      }
      const before = f.state();

      expect(f.release('patch', '--yes').status, blocker).not.toBe(0);

      expect(f.state(), blocker).toEqual(before);
    }
  }, 60_000);

  it('syncs committed org main even from an unrelated dirty local branch, without publishing local content or any tags', () => {
    const f = fixture();
    f.git(['config', 'push.followTags', 'true']);
    f.git(['tag', '-a', 'reachable-local-tag', '-m', 'Must remain local']);
    const publisher = f.publisher(f.org, 'publisher');
    const source = f.commitFile(publisher, 'published.txt', 'Latest committed organization work\n');
    f.git(['tag', '-a', 'org-only', '-m', 'Organization tag'], publisher);
    f.git(['push', 'origin', 'main', 'refs/tags/org-only'], publisher);
    f.git(['checkout', '--orphan', 'local-work']);
    const privateHead = f.commitFile(f.work, 'private.txt', 'Local committed content\n');
    f.git(['tag', '-a', 'private-only', '-m', 'Local tag']);
    writeFileSync(join(f.work, 'notes.txt'), 'Dirty local content\n');
    writeFileSync(join(f.work, 'untracked.txt'), 'Untracked local content\n');
    const localBefore = f.localState();
    const orgBefore = f.remoteRefs(f.org);

    expectSuccess(f.sync('--yes'));

    expect(f.git(['rev-parse', 'refs/heads/main'], f.origin)).toBe(source);
    expect(f.git(['show', 'main:published.txt'], f.origin)).toBe('Latest committed organization work');
    expect(f.git(['ls-tree', '-r', '--name-only', 'main'], f.origin).split('\n')).not.toContain('private.txt');
    expect(f.command('git', ['cat-file', '-e', privateHead], f.origin).status).not.toBe(0);
    expect(f.git(['for-each-ref', '--format=%(refname)', 'refs/tags'], f.origin)).toBe('');
    expect(f.remoteRefs(f.org)).toBe(orgBefore);
    expect(f.localState()).toEqual(localBefore);
    expect(readFileSync(join(f.work, 'untracked.txt'), 'utf8')).toBe('Untracked local content\n');
  }, 30_000);

  it('refuses to overwrite a diverged public main', () => {
    const f = fixture();
    for (const [name, remote] of [['organization', f.org], ['public', f.origin]] as const) {
      const publisher = f.publisher(remote, `${name}-publisher`);
      f.commitFile(publisher, `${name}.txt`, `${name} independent work\n`);
      f.git(['push', 'origin', 'main'], publisher);
    }
    const before = f.state();

    expect(f.sync('--yes').status).not.toBe(0);

    expect(f.state()).toEqual(before);
  }, 30_000);

  it('fetches the latest organization commit during a sync dry-run without changing public main or local work', () => {
    const f = fixture();
    const publisher = f.publisher(f.org, 'publisher');
    const source = f.commitFile(publisher, 'published.txt', 'Organization work awaiting publication\n');
    f.git(['push', 'origin', 'main'], publisher);
    const before = f.state();

    expectSuccess(f.sync('--dry-run'));

    expect(f.state()).toEqual(before);
    expect(f.git(['rev-parse', 'refs/remotes/org/main'])).toBe(source);
  }, 30_000);
});
