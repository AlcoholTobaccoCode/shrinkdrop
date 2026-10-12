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
  const known = account.source !== 'unknown' && account.usedThisMonth !== undefined;
  return {
    label: account.label,
    status: account.status,
    used: known ? account.usedThisMonth : undefined,
    limit: known ? account.limitThisMonth : undefined,
    remaining: known
      ? account.remaining ?? (account.limitThisMonth !== undefined ? Math.max(0, account.limitThisMonth - (account.usedThisMonth ?? 0)) : undefined)
      : undefined,
    source: account.source,
    observedAt: account.observedAt
  };
}

export type UsageFetcher = (providerId: ProviderId) => Promise<ProviderUsageResponse>;

export const useUsageStore = defineStore('usage', {
  state: () => ({
    byProvider: {} as Record<string, UsageView[]>,
    error: undefined as string | undefined
  }),
  actions: {
    async refresh(providerId: ProviderId, fetcher: UsageFetcher): Promise<void> {
      if (providerId === 'local') return;
      try {
        const res = await fetcher(providerId);
        this.byProvider[providerId] = res.accounts.map(toUsageView);
        this.error = undefined;
      } catch (error) {
        this.error = error instanceof Error ? error.message : '获取额度失败';
      }
    },
    views(providerId: ProviderId): UsageView[] {
      return this.byProvider[providerId] ?? [];
    }
  }
});
