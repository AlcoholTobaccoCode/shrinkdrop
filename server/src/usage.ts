import type { AccountStatus, AccountUsage, ProviderUsageResponse } from '@tinypng/shared';
import { AccountPool, type AccountPublic } from './accounts';
import { AppError } from './errors';

interface AccountState {
  used?: number;
  /** 缺头时仅作保守下限，绝不再作为对外已确认的用量。 */
  lowerBound?: number;
  observedAt: string;
  status: AccountStatus;
  cooldownUntil: number;
  inFlight: number;
  lastManualRefresh?: number;
}

export interface AccountReservation {
  account: AccountPublic;
  /** 收费请求前复核；返回仅可调用一次的本步骤结算回调。 */
  beginCharge(): () => void;
  release(): void;
}

//#region 官方累计用量与进程内预留
export class UsageTracker {
  private readonly states = new Map<string, AccountState>();
  private month: string;

  constructor(private readonly pool: AccountPool, private readonly now: () => number = Date.now) {
    this.month = this.monthOfNow();
    for (const account of pool.accounts) this.states.set(account.accountId, this.empty());
  }

  private monthOfNow(): string { return new Date(this.now()).toISOString().slice(0, 7); }
  private empty(): AccountState {
    return { observedAt: new Date(this.now()).toISOString(), status: 'active', cooldownUntil: 0, inFlight: 0 };
  }

  /** 每月 UTC 切换后不沿用上月值；仍未结束的预留保持，防止月界处超分。 */
  resetMonthIfNeeded(): boolean {
    const month = this.monthOfNow();
    if (month === this.month) return false;
    this.month = month;
    for (const [id, old] of this.states) this.states.set(id, { ...this.empty(), inFlight: old.inFlight });
    return true;
  }

  private state(account: AccountPublic): AccountState { return this.states.get(account.accountId)!; }

  observe(account: AccountPublic, count: string | undefined, httpStatus: number, requestMonth?: string): void {
    this.resetMonthIfNeeded();
    // 月界前发出的请求归属不确定，迟到计数不能覆盖新月已刷新或 unknown 的快照。
    if (requestMonth !== undefined && requestMonth !== this.month) return;
    const state = this.state(account);
    const parsed = count !== undefined && /^(0|[1-9]\d*)$/.test(count.trim()) ? Number(count) : undefined;
    state.observedAt = new Date(this.now()).toISOString();
    if (parsed !== undefined && Number.isSafeInteger(parsed)) {
      // 并发响应可能乱序，同一月累计计数不能因迟到响应倒退。
      state.lowerBound = Math.max(state.lowerBound ?? 0, parsed);
      state.used = state.lowerBound;
    } else { state.used = undefined; }
    if (httpStatus === 401) { state.status = 'invalid'; state.cooldownUntil = Number.POSITIVE_INFINITY; }
    else if (state.lowerBound !== undefined && state.lowerBound >= account.monthlyLimit) { state.status = 'exhausted'; }
    else if (httpStatus === 429) { state.status = 'cooldown'; state.cooldownUntil = this.now() + 60_000; }
    else if (httpStatus >= 500 || httpStatus === 0) { state.status = 'cooldown'; state.cooldownUntil = this.now() + 60_000; }
    else { state.status = 'active'; state.cooldownUntil = 0; }
  }

  reserve(cost: number): AccountReservation {
    this.resetMonthIfNeeded();
    const candidates = this.pool.accounts.filter(account => {
      if (!account.enabled) return false;
      const state = this.state(account);
      if (state.status === 'invalid' || state.status === 'exhausted') return false;
      if (state.cooldownUntil > this.now()) return false;
      const available = account.monthlyLimit - (state.lowerBound ?? 0) - state.inFlight;
      // 用量未知时只放行单条管线，实际 429 由官方决定，不能声称还有某个数值。
      return available >= cost && (state.used !== undefined || state.inFlight === 0);
    }).sort((a, b) => {
      const sa = this.state(a), sb = this.state(b);
      return (b.monthlyLimit - (sb.lowerBound ?? 0) - sb.inFlight) - (a.monthlyLimit - (sa.lowerBound ?? 0) - sa.inFlight);
    });
    const account = candidates[0];
    if (!account) {
      if (!this.pool.accounts.some(account => account.enabled)) throw new AppError('PROVIDER_UNAVAILABLE', '尚未配置可用的官方账号', { providerId: 'official-tinify' });
      throw new AppError('QUOTA_EXHAUSTED', '官方账号预算不足或暂不可用，请刷新额度后重试', { providerId: 'official-tinify', retryable: true });
    }
    this.state(account).inFlight += cost;
    let released = false;
    let remaining = cost;
    return { account, beginCharge: () => {
      this.resetMonthIfNeeded();
      const state = this.state(account);
      const otherReservations = Math.max(0, state.inFlight - remaining);
      const availableForPipeline = account.monthlyLimit - (state.lowerBound ?? 0) - otherReservations;
      // 外部同 key 的消费可能在任意响应中显现，不能依赖管线开始时的余额。
      // 本进程无法锁住外部调用，复核到请求之间仍有竞争；只保证已观察耗尽后不再收费下单。
      if (released || remaining < 1 || state.status === 'invalid' || state.status === 'exhausted' || state.cooldownUntil > this.now() || availableForPipeline < remaining) {
        throw new AppError('QUOTA_EXHAUSTED', '官方账号预算不足或暂不可用，请刷新额度后重试', { providerId: 'official-tinify', retryable: true });
      }
      let settled = false;
      return () => {
        if (settled || released) return;
        settled = true;
        remaining--;
        this.state(account).inFlight = Math.max(0, this.state(account).inFlight - 1);
      };
    }, release: () => {
      if (released) return;
      released = true;
      const state = this.state(account);
      state.inFlight = Math.max(0, state.inFlight - remaining);
      remaining = 0;
    } };
  }

  accountsForRefresh(manual: boolean): readonly AccountPublic[] {
    this.resetMonthIfNeeded();
    const enabled = this.pool.accounts.filter(account => account.enabled);
    if (!manual) return enabled;
    const available = enabled.filter(account => this.state(account).lastManualRefresh === undefined || this.now() - this.state(account).lastManualRefresh! >= 60_000);
    if (enabled.length && !available.length) throw new AppError('RATE_LIMITED', '额度刚刚刷新过，请一分钟后再试', { providerId: 'official-tinify', retryable: true });
    for (const account of available) this.state(account).lastManualRefresh = this.now();
    return available;
  }

  snapshot(): ProviderUsageResponse {
    const accounts: AccountUsage[] = this.pool.accounts.map(account => {
      const state = this.state(account);
      const result: AccountUsage = {
        providerId: 'official-tinify', accountId: account.accountId, label: account.label,
        source: state.used === undefined ? 'unknown' : 'compression-count', observedAt: state.observedAt,
        status: state.status === 'cooldown' && state.cooldownUntil <= this.now() ? 'active' : state.status,
      };
      if (state.used !== undefined) {
        result.usedThisMonth = state.used;
        // 这是管理员配置的月预算，并非 Tinify 付费账户的余额查询。
        result.limitThisMonth = account.monthlyLimit;
        result.remaining = Math.max(0, account.monthlyLimit - state.used);
      }
      return result;
    });
    return { providerId: 'official-tinify', accounts };
  }
}
//#endregion
