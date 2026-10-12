export const API_ERROR_CODES = [
  'AUTH_REQUIRED', 'AUTH_INVALID', 'VALIDATION_FAILED', 'FILE_TOO_LARGE', 'UNSUPPORTED_MIME',
  'OPERATION_UNSUPPORTED', 'URL_FORBIDDEN', 'URL_FETCH_FAILED', 'PROVIDER_UNAVAILABLE',
  'ANONYMOUS_DISABLED', 'QUOTA_EXHAUSTED', 'PROVIDER_TIMEOUT', 'PROVIDER_ERROR', 'OUTPUT_FAILED',
  'JOB_NOT_FOUND', 'BATCH_NOT_FOUND', 'INVALID_STATE', 'RATE_LIMITED', 'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  providerId?: string;
  retryable: boolean;
  requestId: string;
  /** 仅 OPERATION_UNSUPPORTED */
  suggestProviderId?: string;
}

export function isApiError(v: unknown): v is ApiError {
  return typeof v === 'object' && v !== null && typeof (v as ApiError).code === 'string'
    && (API_ERROR_CODES as readonly string[]).includes((v as ApiError).code);
}
