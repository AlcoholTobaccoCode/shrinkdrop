#!/usr/bin/env node
// 把特权 helper 编译成 Tauri sidecar 需要的文件名，供 Windows 打包使用。
//
// Tauri 的 externalBin 要求文件带 target triple 后缀：
//   src-tauri/binaries/shrinkdrop-ssh-helper-<triple>.exe
// 该文件不进仓库（见 .gitignore），由本脚本或 CI 在打包前生成。

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const triple = process.env.SSHELPER_TARGET ?? 'x86_64-pc-windows-msvc';
const profile = process.env.SSHELPER_PROFILE ?? 'release';

if (!triple.includes('windows')) {
  console.error(`build-ssh-helper: helper 只用于 Windows，收到 ${triple}`);
  process.exit(1);
}

execFileSync(
  'cargo',
  ['build', '-p', 'shrinkdrop-ssh-helper', '--target', triple, ...(profile === 'release' ? ['--release'] : [])],
  { cwd: join(root, 'src-tauri'), stdio: 'inherit' }
);

const built = join(root, 'src-tauri', 'target', triple, profile, 'shrinkdrop-ssh-helper.exe');
const sidecarDir = join(root, 'src-tauri', 'binaries');
const sidecar = join(sidecarDir, `shrinkdrop-ssh-helper-${triple}.exe`);

mkdirSync(sidecarDir, { recursive: true });
rmSync(sidecar, { force: true });
copyFileSync(built, sidecar);
console.log(`build-ssh-helper: ${sidecar}`);
