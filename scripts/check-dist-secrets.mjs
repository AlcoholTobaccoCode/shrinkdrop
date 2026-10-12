// A3：构建后扫描 dist，确认没有混入 Tinify key、Server token 或账号文件内容
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv[2] ?? 'dist';
const needles = new Set(['TinifyAccounts', 'api_key', 'secretAccessKey', 'private_key']);
for (const f of ['TinifyAccounts.json', 'server/config/server.json']) {
  if (!existsSync(f)) continue;
  const raw = readFileSync(f, 'utf8');
  for (const m of raw.matchAll(/"(?:api_key|sha256|token)"\s*:\s*"([^"]{8,})"/g)) needles.add(m[1]);
}
const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
if (!existsSync(dist)) { console.error(`未找到 ${dist}`); process.exit(2); }
const hits = [];
for (const file of walk(dist)) {
  const text = readFileSync(file, 'latin1');
  for (const n of needles) if (text.includes(n)) hits.push(`${file}: ${n.length > 12 ? n.slice(0, 4) + '***' : n}`);
}
if (hits.length) { console.error('构建产物里发现疑似密钥：\n' + hits.join('\n')); process.exit(1); }
console.log(`✓ ${dist} 未发现密钥`);
