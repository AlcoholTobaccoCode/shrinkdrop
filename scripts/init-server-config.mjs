import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'server/config/server.json');
const config = JSON.parse(await readFile(resolve(root, 'server/config/server.example.json'), 'utf8'));
const token = randomBytes(32).toString('base64url');
config.auth = { disabled: false, tokens: [{ id: 'qingshan', label: 'QingShan', sha256: createHash('sha256').update(token).digest('hex') }] };
await mkdir(dirname(target), { recursive: true });
try {
  await writeFile(target, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code === 'EEXIST') { console.error('配置已经存在，已保留原配置。请直接启动 Server，或手动编辑配置。'); process.exit(1); }
  throw error;
}
console.log(`已创建 ${target}\nServer 仅监听本机，配置中只保存令牌的 SHA-256。\n在客户端的“访问令牌”中粘贴下面的值（只显示这一次）：\n${token}`);
