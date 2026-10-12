import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountPool, maskUsername } from '../src/accounts';

const KEY = 'SECRETKEY1234567890abcdef';
const raw = [{ username: 'alice@example.com', api_key: KEY }, { username: 'bob@x.io', api_key: 'OTHERKEY999999', monthlyLimit: 1000, enabled: false }];

describe('B6 账号池', () => {
  it('兼容旧数组格式，monthlyLimit 默认 500', () => {
    const p = AccountPool.fromJson(raw);
    expect(p.accounts).toHaveLength(2);
    expect(p.accounts[0]).toMatchObject({ label: 'al***@example.com', monthlyLimit: 500, enabled: true });
    expect(p.accounts[1]).toMatchObject({ monthlyLimit: 1000, enabled: false });
    expect(p.accounts[0]!.accountId).toMatch(/^[a-f0-9]{8}$/);
  });
  it('序列化、打印都拿不到原始 key', () => {
    const p = AccountPool.fromJson(raw);
    expect(JSON.stringify(p)).not.toContain(KEY);
    expect(JSON.stringify(p.accounts)).not.toContain(KEY);
    expect(String(Object.values(p.accounts[0]!))).not.toContain(KEY);
    expect(p.keyOf(p.accounts[0]!)).toBe(KEY);
  });
  it('格式错误时报错且不回显 key', () => {
    expect(() => AccountPool.fromJson([{ username: 'a', api_key: 1 }])).toThrow(/0\.api_key/);
    try { AccountPool.fromJson([{ username: 'a', api_key: 'short' }]); } catch (e) { expect(String(e)).not.toContain('short'); }
  });
  it('重复账号报错', () => {
    expect(() => AccountPool.fromJson([raw[0], raw[0]])).toThrow(/重复/);
  });
  it('文件不存在时返回空池，非法 JSON 报错', () => {
    const d = mkdtempSync(join(tmpdir(), 'acc-'));
    expect(AccountPool.load(join(d, 'none.json')).accounts).toHaveLength(0);
    writeFileSync(join(d, 'bad.json'), `{ ${KEY}`);
    expect(() => AccountPool.load(join(d, 'bad.json'))).toThrow(/不是合法 JSON/);
    try { AccountPool.load(join(d, 'bad.json')); } catch (e) { expect(String(e)).not.toContain(KEY); }
  });
  it('掩码', () => { expect(maskUsername('qingshan')).toBe('qi***'); });
});
