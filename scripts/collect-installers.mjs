import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [bundleDirectory, outputDirectory, platform] = process.argv.slice(2);
const formats = {
  'macos-universal': { dmg: '.dmg' },
  'windows-x64': { nsis: '.exe', msi: '.msi' },
}[platform];
if (!bundleDirectory || !outputDirectory || !formats) {
  throw new Error('Usage: node scripts/collect-installers.mjs <bundle-directory> <output-directory> <macos-universal|windows-x64>');
}

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir(outputDirectory, { recursive: true });
const files = [];
for (const [folder, extension] of Object.entries(formats)) {
  const entries = await readdir(path.join(bundleDirectory, folder), { withFileTypes: true });
  const installers = entries.filter((entry) => entry.isFile() && entry.name.endsWith(extension));
  if (installers.length === 0) throw new Error(`Missing ${extension} installer in ${folder}`);
  for (const installer of installers) {
    const source = path.join(bundleDirectory, folder, installer.name);
    const bytes = await readFile(source);
    if (bytes.length === 0) throw new Error(`Empty installer: ${source}`);
    await copyFile(source, path.join(outputDirectory, installer.name));
    files.push({ name: installer.name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
}
files.sort((a, b) => a.name.localeCompare(b.name));
await writeFile(path.join(outputDirectory, 'SHA256SUMS.txt'), files.map((file) => `${file.sha256}  ${file.name}\n`).join(''));
const build = {
  version,
  platform,
  commit: process.env.GITHUB_SHA || null,
  ref: process.env.GITHUB_REF || null,
  run: process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null,
  files,
};
await writeFile(path.join(outputDirectory, 'build-info.json'), `${JSON.stringify(build, null, 2)}\n`);
const summary = [
  `### shrinkdrop ${version} — ${platform}`,
  '',
  `Commit: \`${build.commit || 'local'}\``,
  '',
  'Installers are available in this run’s **Artifacts** section for 90 days.',
  '',
  '| File | Size (MiB) |',
  '| --- | ---: |',
  ...files.map((file) => `| ${file.name} | ${(file.bytes / 1024 / 1024).toFixed(2)} |`),
  '',
  'The artifact also includes `SHA256SUMS.txt` and `build-info.json`.',
  '',
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) {
  await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
}
console.log(summary);
