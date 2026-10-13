import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** 生成带渐变和圆形的 RGBA PNG（e2e 用，不依赖图片库） */
export function makePng(width: number, height: number, hue = 0): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++) {
      const dx = x - width / 2, dy = y - height / 2;
      const inCircle = dx * dx + dy * dy < (Math.min(width, height) / 3) ** 2;
      const i = 1 + x * 4;
      row[i] = inCircle ? 240 : Math.floor(x * 255 / width + hue) % 256;
      row[i + 1] = inCircle ? 180 : Math.floor(y * 255 / height);
      row[i + 2] = inCircle ? 90 : 160;
      row[i + 3] = 255;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

export function fixtureFiles(): string[] {
  const dir = join(tmpdir(), 'tinypng-e2e');
  mkdirSync(dir, { recursive: true });
  const a = join(dir, 'hero.png');
  const b = join(dir, 'banner@2x.png');
  writeFileSync(a, makePng(640, 400, 0));
  writeFileSync(b, makePng(480, 320, 90));
  return [a, b];
}
