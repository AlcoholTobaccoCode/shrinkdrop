import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [inputDirectory, outputDirectory] = process.argv.slice(2);
if (!inputDirectory || !outputDirectory) throw new Error('Usage: node scripts/prepare-release.mjs <input-directory> <output-directory>');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const expected = new Map([
  ['macos-universal', new Set(['.dmg'])],
  ['windows-x64', new Set(['.exe', '.msi'])],
]);
const builds = [];
const files = [];
const names = new Set();
await mkdir(outputDirectory, { recursive: true });
for (const entry of await readdir(inputDirectory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const root = path.join(inputDirectory, entry.name);
  const build = JSON.parse(await readFile(path.join(root, 'build-info.json'), 'utf8'));
  const extensions = expected.get(build.platform);
  if (!extensions || build.version !== version || build.commit !== process.env.GITHUB_SHA) {
    throw new Error(`Unexpected platform, version or commit in ${entry.name}`);
  }
  const actual = new Set(build.files.map((file) => path.extname(file.name)));
  if (actual.size !== extensions.size || [...extensions].some((extension) => !actual.has(extension))) {
    throw new Error(`Missing installer format in ${entry.name}`);
  }
  for (const file of build.files) {
    if (path.basename(file.name) !== file.name || names.has(file.name)) throw new Error(`Invalid or duplicate asset: ${file.name}`);
    const source = path.join(root, file.name);
    const bytes = await readFile(source);
    if (!bytes.length || bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new Error(`Installer checksum mismatch: ${file.name}`);
    }
    names.add(file.name);
    await copyFile(source, path.join(outputDirectory, file.name));
    files.push(file);
  }
  builds.push(build);
  expected.delete(build.platform);
}
if (expected.size) throw new Error(`Missing platforms: ${[...expected.keys()].join(', ')}`);
files.sort((a, b) => a.name.localeCompare(b.name));
await writeFile(path.join(outputDirectory, 'SHA256SUMS.txt'), files.map((file) => `${file.sha256}  ${file.name}\n`).join(''));
await writeFile(path.join(outputDirectory, 'build-info.json'), `${JSON.stringify({ version, commit: process.env.GITHUB_SHA, builds }, null, 2)}\n`);
const notes = [
  `shrinkdrop ${version} 安装包。`,
  '',
  '| 系统 | 下载文件 |',
  '| --- | --- |',
  '| Windows x64 | `shrinkdrop_' + version + '_x64-setup.exe`（推荐）或 `.msi` |',
  '| macOS Intel / Apple Silicon | `shrinkdrop_' + version + '_universal.dmg` |',
  '',
  '请在下方 Assets 中直接下载安装文件，无需登录 GitHub。macOS 打开 DMG 后将应用拖入 Applications。',
  '',
  '安装包暂未配置开发者签名及 macOS 公证，首次打开可能出现系统安全提示。',
  '',
  '`SHA256SUMS.txt` 用于校验下载文件，`build-info.json` 记录构建版本与提交。Release 安装包不受 Actions 产物 90 天保留期限制。',
  '',
  `构建提交：\`${process.env.GITHUB_SHA}\``,
  '',
  `构建记录：${builds[0].run}`,
  '',
].join('\n');
await writeFile(path.join(outputDirectory, 'RELEASE_NOTES.md'), notes);
console.log(`Verified ${files.length} installers for shrinkdrop ${version}`);
