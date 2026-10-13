import { defineStore } from 'pinia';
import type { AccountUsage, ProviderId, ProviderUsageResponse } from '@tinypng/shared';

export interface UsageView {
  label: string;
  status: AccountUsage['status'];
  /** 额度未知时为 undefined：界面显示“未知”，不显示数字 */
  used?: number;
  remaining?: number;
  limit?: number;
  source: AccountUsage['source'];
  observedAt: string;
}

export function toUsageView(account: AccountUsage): UsageView {
  const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : undefined;
  const used = count(account.usedThisMonth);
  const limit = count(account.limitThisMonth);
  const known = account.source !== 'unknown' && used !== undefined;
  return {
    label: account.label,
    status: account.status,
    used: known ? used : undefined,
    limit: known ? limit : undefined,
    remaining: known
      ? count(account.remaining) ?? (limit !== undefined ? Math.max(0, limit - used) : undefined)
      : undefined,
    source: known ? account.source : 'unknown',
    observedAt: account.observedAt
  };
}

export type UsageFetcher = (providerId: ProviderId) => Promise<ProviderUsageResponse>;

export const useUsageStore = defineStore('usage', {
  state: () => ({
    byProvider: {} as Record<string, UsageView[]>,
    loading: false,
    error: undefined as string | undefined
  }),
  actions: {
    async refresh(providerId: ProviderId, fetcher: UsageFetcher): Promise<void> {
      if (providerId === 'local') return;
      if (this.loading) return;
      this.loading = true;
      try {
        const res = await fetcher(providerId);
        this.byProvider[providerId] = res.accounts.map(toUsageView);
        this.error = undefined;
      } catch (error) {
        this.byProvider[providerId] = [];
        this.error = error instanceof Error ? error.message : '获取额度失败';
      } finally {
        this.loading = false;
      }
    },
    views(providerId: ProviderId): UsageView[] {
      return this.byProvider[providerId] ?? [];
    }
  }
});
