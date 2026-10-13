import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createProviderService } from '../src/providers/service';
import { accounts, config, fixture, image, signal, validateOrImage } from './provider-fixtures';

describe('B7 官方直连 Provider', () => {
  it('只向固定官方主机发 Basic Auth，返回解码可用的图片', async () => {
    const png = await image();
    const f = await fixture((req, res, body) => validateOrImage(req, res, body, png));
    const service = createProviderService(config, { accounts: accounts(), transport: f.transport, refreshOnStart: false });
    try {
      await service.refreshUsage('official-tinify');
      const out = await service.execute({ providerId: 'official-tinify', operations: [{ type: 'compress' }], data: png, mimeType: 'image/png', signal: signal() });
      expect(out).toMatchObject({ mimeType: 'image/png', width: 8, height: 4 });
      expect((await sharp(out.data).metadata()).width).toBe(8);
      expect(f.seen.every(req => new URL(req.url).host === 'api.tinify.com')).toBe(true);
      expect(f.seen.every(req => req.headers.Authorization?.startsWith('Basic '))).toBe(true);
      expect(f.seen.every(req => !Object.keys(req.headers).some(key => key.toLowerCase() === 'x-forwarded-for'))).toBe(true);
      expect(JSON.stringify(service.usage('official-tinify'))).not.toContain('fixture-key');
    } finally { service.close(); await f.close(); }
  });

  it('拒绝上游恶意 Location，key 不会发送给别的主机，也不降级匿名', async () => {
    const png = await image();
    const f = await fixture((req, res, body) => {
      if (!body.length) return validateOrImage(req, res, body, png);
      res.writeHead(201, { 'Compression-Count': '2', Location: 'https://evil.test/output/stolen' }); res.end('{}');
    });
    const service = createProviderService(config, { accounts: accounts(), transport: f.transport, refreshOnStart: false });
    try {
      await service.refreshUsage('official-tinify');
      await expect(service.execute({ providerId: 'official-tinify', operations: [{ type: 'compress' }], data: png, mimeType: 'image/png', signal: signal() })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(f.seen).toHaveLength(2);
      expect(f.seen.every(req => new URL(req.url).host === 'api.tinify.com')).toBe(true);
    } finally { service.close(); await f.close(); }
  });

  it.each(['inside', 'contain', 'cover'] as const)('实际图片实现 %s 尺寸且 convert 在官方请求里执行', async fit => {
    const png = await image();
    let uploaded = png;
    const f = await fixture(async (req, res, body) => {
      if (req.url === '/shrink') {
        if (!body.length) return validateOrImage(req, res, body, png, 0);
        uploaded = body;
        res.writeHead(201, { 'Compression-Count': '1', Location: 'https://api.tinify.com/output/fixture' }); res.end('{}');
      } else {
        const options = body.length ? JSON.parse(body.toString()) : {};
        if (options.convert) {
          expect(options).toEqual({ convert: { type: 'image/webp' } });
          res.writeHead(200, { 'Compression-Count': '2', 'Content-Type': 'image/webp' }); res.end(await sharp(uploaded).webp().toBuffer());
        } else if (options.resize) {
          res.writeHead(200, { 'Compression-Count': '2', 'Content-Type': 'image/png' });
          res.end(await sharp(uploaded).resize({ width: options.resize.width, height: options.resize.height, fit: 'inside', withoutEnlargement: true }).png().toBuffer());
        } else { res.writeHead(200, { 'Compression-Count': '1', 'Content-Type': 'image/png' }); res.end(uploaded); }
      }
    });
    const service = createProviderService(config, { accounts: accounts(), transport: f.transport, refreshOnStart: false });
    try {
      await service.refreshUsage('official-tinify');
      const out = await service.execute({ providerId: 'official-tinify', operations: [{ type: 'compress' }, { type: 'resize', width: 12, height: 12, fit }, { type: 'convert', format: 'webp' }], data: png, mimeType: 'image/png', signal: signal() });
      expect(out).toMatchObject({ width: fit === 'inside' ? 8 : 12, height: fit === 'inside' ? 4 : 12, mimeType: 'image/webp' });
      if (fit === 'contain') {
        const { data, info } = await sharp(out.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        expect(info.channels).toBe(4); expect(data[3]).toBe(0);
      }
    } finally { service.close(); await f.close(); }
  });

  it('JPEG contain 四周白底；多次 resize 依次作用', async () => {
    const png = await image(); let uploaded = png;
    const f = await fixture(async (req, res, body) => {
      if (!body.length && req.url === '/shrink') return validateOrImage(req, res, body, png, 0);
      if (req.url === '/shrink') { uploaded = body; res.writeHead(201, { 'Compression-Count': '1', Location: 'https://api.tinify.com/output/fixture' }); res.end('{}'); }
      else if (!body.length) { res.writeHead(200, { 'Compression-Count': '1', 'Content-Type': 'image/png' }); res.end(uploaded); }
      else {
        const options = JSON.parse(body.toString());
        if (options.resize) { res.writeHead(200, { 'Compression-Count': '2', 'Content-Type': 'image/png' }); res.end(await sharp(uploaded).resize({ width: options.resize.width, height: options.resize.height, fit: 'inside', withoutEnlargement: true }).png().toBuffer()); }
        else { expect(options).toEqual({ convert: { type: 'image/jpeg' }, transform: { background: '#ffffff' } }); res.writeHead(200, { 'Compression-Count': '2', 'Content-Type': 'image/jpeg' }); res.end(await sharp(uploaded).flatten({ background: '#ffffff' }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer()); }
      }
    });
    const service = createProviderService(config, { accounts: accounts(), transport: f.transport, refreshOnStart: false });
    try {
      await service.refreshUsage('official-tinify');
      const out = await service.execute({ providerId: 'official-tinify', operations: [{ type: 'resize', width: 8, height: 8, fit: 'contain' }, { type: 'resize', width: 4, height: 4, fit: 'inside' }, { type: 'convert', format: 'jpeg' }], data: png, mimeType: 'image/png', signal: signal() });
      expect(out).toMatchObject({ width: 4, height: 4, mimeType: 'image/jpeg' });
      const corner = await sharp(out.data).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
      expect([...corner].every(channel => channel > 235)).toBe(true);
    } finally { service.close(); await f.close(); }
  });

  it('连续 JPEG 再 PNG 转换保留前一阶段白底，不能只应用最后一个 convert', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    let uploaded = png, count = 0;
    const f = await fixture(async (req, res, body) => {
      if (req.url === '/shrink' && !body.length) return validateOrImage(req, res, body, png, count);
      if (req.url === '/shrink') { uploaded = body; res.writeHead(201, { 'Compression-Count': String(++count), Location: 'https://api.tinify.com/output/fixture' }); res.end('{}'); return; }
      let output = uploaded;
      if (body.length) {
        const format = JSON.parse(body.toString()).convert.type.split('/')[1];
        let converter = sharp(uploaded);
        if (format === 'jpeg') converter = converter.flatten({ background: '#ffffff' });
        output = await converter.toFormat(format).toBuffer(); count++;
      }
      const format = (await sharp(output).metadata()).format;
      res.writeHead(200, { 'Compression-Count': String(count), 'Content-Type': 'image/' + format }); res.end(output);
    });
    const service = createProviderService(config, { accounts: accounts(), transport: f.transport, refreshOnStart: false });
    try {
      await service.refreshUsage('official-tinify');
      const out = await service.execute({ providerId: 'official-tinify', operations: [{ type: 'compress' }, { type: 'convert', format: 'jpeg' }, { type: 'convert', format: 'png' }], data: png, mimeType: 'image/png', signal: signal() });
      const pixel = await sharp(out.data).ensureAlpha().raw().toBuffer();
      expect([...pixel.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
      expect(service.usage('official-tinify').accounts[0]).toMatchObject({ usedThisMonth: 4, remaining: 496 });
    } finally { service.close(); await f.close(); }
  });

  it('上游只给可读图片头但像素数据损坏时拒绝，不能把坏 bytes 报成功', async () => {
    const png = await image();
    const f = await fixture((req, res, body) => validateOrImage(req, res, body, png.subarray(0, 70)));
    const service = createProviderService(config, { accounts: accounts(), transport: f.transport, refreshOnStart: false });
    try {
      await service.refreshUsage('official-tinify');
      await expect(service.execute({ providerId: 'official-tinify', operations: [{ type: 'compress' }], data: png, mimeType: 'image/png', signal: signal() })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    } finally { service.close(); await f.close(); }
  });

  it('官方 AVIF 转换返回可解码 AV1 图片，识别 sharp 的 heif 容器标记', async () => {
    const png = await image();
    const avif = await sharp(png).avif().toBuffer();
    const f = await fixture((req, res, body) => {
      if (req.url === '/shrink' || !body.length) return validateOrImage(req, res, body, png, 0);
      expect(JSON.parse(body.toString())).toEqual({ convert: { type: 'image/avif' } });
      res.writeHead(200, { 'Compression-Count': '2', 'Content-Type': 'image/avif' }); res.end(avif);
    });
    const service = createProviderService(config, { accounts: accounts(), transport: f.transport, refreshOnStart: false });
    try {
      await service.refreshUsage('official-tinify');
      const out = await service.execute({ providerId: 'official-tinify', operations: [{ type: 'compress' }, { type: 'convert', format: 'avif' }], data: png, mimeType: 'image/png', signal: signal() });
      expect(out).toMatchObject({ mimeType: 'image/avif', width: 8, height: 4 });
      expect((await sharp(out.data).metadata()).compression).toBe('av1');
    } finally { service.close(); await f.close(); }
  });

  it('contain 先官方 fit 再补边：8×4 到12×12内容不放大，也不为仅补边再次收费', async () => {
    const png = await image(); let uploads = 0, fits = 0; let uploaded = png;
    const f = await fixture(async (req, res, body) => {
      if (req.url === '/shrink' && !body.length) return validateOrImage(req, res, body, png, 0);
      if (req.url === '/shrink') { uploads++; uploaded = body; res.writeHead(201, { 'Compression-Count': '1', Location: 'https://api.tinify.com/output/fixture' }); res.end('{}'); }
      else if (req.method === 'POST') {
        expect(JSON.parse(body.toString())).toEqual({ resize: { method: 'fit', width: 12, height: 12 } }); fits++;
        res.writeHead(200, { 'Compression-Count': '2', 'Content-Type': 'image/png' }); res.end(await sharp(uploaded).resize({ width: 12, height: 12, fit: 'inside', withoutEnlargement: true }).png().toBuffer());
      } else { res.writeHead(200, { 'Compression-Count': '1', 'Content-Type': 'image/png' }); res.end(uploaded); }
    });
    const service = createProviderService(config, { accounts: accounts(), transport: f.transport, refreshOnStart: false });
    try {
      await service.refreshUsage('official-tinify');
      const out = await service.execute({ providerId: 'official-tinify', operations: [{ type: 'compress' }, { type: 'resize', width: 12, height: 12, fit: 'contain' }], data: png, mimeType: 'image/png', signal: signal() });
      const { data, info } = await sharp(out.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const opaque = Array.from({ length: info.width * info.height }, (_, index) => data[index * 4 + 3]).filter(alpha => alpha === 255).length;
      expect(out).toMatchObject({ width: 12, height: 12 }); expect(opaque).toBe(8 * 4); expect(fits).toBe(1); expect(uploads).toBe(1);
      expect(service.usage('official-tinify').accounts[0]).toMatchObject({ usedThisMonth: 2, remaining: 498 });
    } finally { service.close(); await f.close(); }
  });
});
