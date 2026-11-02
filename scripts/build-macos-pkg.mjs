import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [appPath, outputDirectory, version] = process.argv.slice(2);
if (!appPath || !outputDirectory || !version) {
  throw new Error('Usage: node scripts/build-macos-pkg.mjs <app-path> <output-directory> <version>');
}
if (process.platform !== 'darwin') {
  throw new Error('macOS PKG 只能在 macOS 上构建');
}

await mkdir(outputDirectory, { recursive: true });
const identifier = 'com.shrinkdrop.app';
const target = path.resolve(outputDirectory, `shrinkdrop_${version}_universal.pkg`);
const resources = fileURLToPath(new URL('../src-tauri/installer/macos/', import.meta.url));
const template = await readFile(path.join(resources, 'distribution.xml'), 'utf8');
const work = await mkdtemp(path.join(tmpdir(), 'shrinkdrop-pkg-'));
try {
  const root = path.join(work, 'root');
  const component = path.join(work, 'component.pkg');
  const plist = path.join(work, 'components.plist');
  const distribution = path.join(work, 'distribution.xml');
  const preparedResources = path.join(work, 'resources');
  await mkdir(root);
  await cp(appPath, path.join(root, 'shrinkdrop.app'), { recursive: true, preserveTimestamps: true });
  await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><array><dict>
  <key>RootRelativeBundlePath</key><string>shrinkdrop.app</string>
  <key>BundleIsRelocatable</key><false/>
  <key>BundleIsVersionChecked</key><true/>
  <key>BundleHasStrictIdentifier</key><true/>
  <key>BundleOverwriteAction</key><string>upgrade</string>
</dict></array></plist>\n`);
  execFileSync('pkgbuild', [
    '--root', root,
    '--component-plist', plist,
    '--install-location', '/Applications',
    '--identifier', identifier,
    '--version', version,
    component,
  ], { stdio: 'inherit' });
  await writeFile(distribution, template.replaceAll('__VERSION__', version));
  await mkdir(preparedResources);
  for (const name of ['welcome.html', 'conclusion.html']) {
    const html = await readFile(path.join(resources, name), 'utf8');
    await writeFile(path.join(preparedResources, name), html.replaceAll('__VERSION__', version));
  }
  execFileSync('productbuild', [
    '--distribution', distribution,
    '--package-path', work,
    '--resources', preparedResources,
    target,
  ], { stdio: 'inherit' });
  console.log(target);
} finally {
  await rm(work, { recursive: true, force: true });
}
