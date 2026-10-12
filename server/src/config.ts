import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import { LIMITS } from '@tinypng/shared';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export const serverConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8787),
  concurrency: z.number().int().min(1).max(32).default(LIMITS.concurrency),
  maxFileBytes: z.number().int().positive().default(LIMITS.maxFileBytes),
  tmpTtlHours: z.number().positive().default(LIMITS.tmpTtlHours),
  providerTimeoutMs: z.number().int().positive().default(LIMITS.providerTimeoutMs),
  maxRetries: z.number().int().min(0).max(5).default(LIMITS.maxRetries),
  maxUploadsPerToken: z.number().int().positive().default(8),
  anonymousTinify: z.object({ enabled: z.boolean() }).default({ enabled: true }),
  auth: z.object({
    disabled: z.boolean().default(false),
    tokens: z.array(z.object({
      id: z.string().min(1),
      label: z.string().optional(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/, '必须是 64 位小写十六进制 SHA-256'),
    })).default([]),
  }).default({ disabled: false, tokens: [] }),
}).strict();

export type ServerConfig = z.infer<typeof serverConfigSchema>;

export class ConfigError extends Error {}

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host) || host.startsWith('127.');
}

export function parseConfig(raw: unknown): ServerConfig {
  const r = serverConfigSchema.safeParse(raw);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  - ${i.path.join('.') || '(根)'}: ${i.message}`);
    throw new ConfigError(`server.json 配置有误：\n${lines.join('\n')}`);
  }
  const c = r.data;
  if (!isLoopback(c.host) && c.auth.disabled) {
    throw new ConfigError(`监听非 loopback 地址 ${c.host} 时不能设置 auth.disabled=true`);
  }
  if (!c.auth.disabled && c.auth.tokens.length === 0) {
    throw new ConfigError('auth.tokens 为空：请至少配置一个访问令牌，或在 loopback 下设置 auth.disabled=true');
  }
  return c;
}

export function loadConfig(path = process.env.SERVER_CONFIG ?? 'config/server.json'): ServerConfig {
  if (!existsSync(path)) {
    throw new ConfigError(`找不到配置文件 ${path}，可以复制 config/server.example.json 作为起点`);
  }
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new ConfigError(`${path} 不是合法 JSON：${(e as Error).message}`); }
  return parseConfig(raw);
}
