export const LIMITS = {
  maxFileBytes: 20 * 1024 * 1024,
  concurrency: 5,
  tmpTtlHours: 24,
  providerTimeoutMs: 60_000,
  maxRetries: 2,
  defaultMonthlyLimit: 500,
  maxRedirects: 3,
} as const;
