import type { ApiError, ApiErrorCode } from '@tinypng/shared';

const STATUS: Partial<Record<ApiErrorCode, number>> = {
  AUTH_REQUIRED: 401, AUTH_INVALID: 401, VALIDATION_FAILED: 422, FILE_TOO_LARGE: 413,
  UNSUPPORTED_MIME: 415, OPERATION_UNSUPPORTED: 422, URL_FORBIDDEN: 422, URL_FETCH_FAILED: 502,
  PROVIDER_UNAVAILABLE: 503, ANONYMOUS_DISABLED: 503, QUOTA_EXHAUSTED: 429, PROVIDER_TIMEOUT: 504,
  PROVIDER_ERROR: 502, OUTPUT_FAILED: 500, JOB_NOT_FOUND: 404, BATCH_NOT_FOUND: 404,
  INVALID_STATE: 409, RATE_LIMITED: 429, INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  constructor(
    public code: ApiErrorCode,
    message: string,
    public opts: { retryable?: boolean; providerId?: string; suggestProviderId?: string; httpStatus?: number } = {},
  ) { super(message); }
  get httpStatus(): number { return this.opts.httpStatus ?? STATUS[this.code] ?? 500; }
  toBody(requestId: string): ApiError {
    const body: ApiError = { code: this.code, message: this.message, retryable: this.opts.retryable ?? false, requestId };
    if (this.opts.providerId) body.providerId = this.opts.providerId;
    if (this.opts.suggestProviderId) body.suggestProviderId = this.opts.suggestProviderId;
    return body;
  }
}
