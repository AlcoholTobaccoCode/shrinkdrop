import { describe, it, expect } from 'vitest';
import { parseConfig, isLoopback } from '../src/config';

describe('只允许真实本机监听地址关闭认证', () => {
  it('拒绝看似 127 前缀的公共域名', () => {
    expect(isLoopback('127.0.0.1.public.example')).toBe(false);
    expect(() => parseConfig({ host: '127.0.0.1.public.example', auth: { disabled: true } })).toThrow(/loopback/);
  });
  it('保留 127/8 字面量、IPv6 本机和 localhost 的本机配置', () => {
    for (const host of ['127.0.0.1', '127.2.3.4', '::1', 'localhost']) {
      expect(parseConfig({ host, auth: { disabled: true } }).auth.disabled).toBe(true);
    }
  });
});
