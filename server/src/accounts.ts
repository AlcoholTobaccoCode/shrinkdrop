import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LIMITS } from '@tinypng/shared';
import { ConfigError } from './config';

const entrySchema = z.object({
  username: z.string().min(1),
  api_key: z.string().min(8),
  monthlyLimit: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
}).passthrough();

/** 对外可见的账号信息：绝不包含 key */
export interface AccountPublic {
  accountId: string;
  label: string;
  monthlyLimit: number;
  enabled: boolean;
}

export function accountIdOf(username: string): string {
  return createHash('sha256').update(username).digest('hex').slice(0, 8);
}

export function maskUsername(u: string): string {
  const at = u.indexOf('@');
  const name = at >= 0 ? u.slice(0, at) : u;
  const domain = at >= 0 ? u.slice(at) : '';
  return `${name.slice(0, 2)}***${domain}`;
}

/**
 * 账号池：key 只放在模块私有的 WeakMap 里，账号对象本身不带 key，
 * JSON.stringify / 日志 / 响应都拿不到原始 key。
 */
const keys = new WeakMap<AccountPublic, string>();

export class AccountPool {
  private constructor(readonly accounts: readonly AccountPublic[]) {}

  static fromJson(raw: unknown): AccountPool {
    const r = z.array(entrySchema).safeParse(raw);
    if (!r.success) {
      const i = r.error.issues[0];
      // 只报路径和字段名，不回显内容
      throw new ConfigError(`TinifyAccounts.json 格式错误：${i?.path.join('.')} ${i?.message ?? ''}`.trim());
    }
    const seen = new Set<string>();
    const list: AccountPublic[] = [];
    for (const e of r.data) {
      const accountId = accountIdOf(e.username);
      if (seen.has(accountId)) throw new ConfigError(`TinifyAccounts.json 有重复账号：${maskUsername(e.username)}`);
      seen.add(accountId);
      const a: AccountPublic = Object.freeze({
        accountId,
        label: maskUsername(e.username),
        monthlyLimit: e.monthlyLimit ?? LIMITS.defaultMonthlyLimit,
        enabled: e.enabled ?? true,
      });
      keys.set(a, e.api_key);
      list.push(a);
    }
    return new AccountPool(Object.freeze(list));
  }

  static load(path = process.env.TINIFY_ACCOUNTS ?? '../TinifyAccounts.json'): AccountPool {
    if (!existsSync(path)) return new AccountPool([]);
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, 'utf8')); }
    catch { throw new ConfigError('TinifyAccounts.json 不是合法 JSON'); }
    return AccountPool.fromJson(raw);
  }

  get(accountId: string): AccountPublic | undefined {
    return this.accounts.find((a) => a.accountId === accountId);
  }

  /** 仅供官方 Provider 组装 Basic Auth 使用 */
  keyOf(account: AccountPublic): string {
    const k = keys.get(account);
    if (!k) throw new Error('unknown account');
    return k;
  }
}
