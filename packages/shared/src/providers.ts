import type { ImageFormat, MetadataField } from './operations';

export type ProviderId = 'local' | 'anonymous-tinify' | 'official-tinify' | (string & {});

export interface ImageProviderManifest {
  id: ProviderId;
  label: string;
  processing: 'local' | 'cloud';
  capabilities: {
    compress: boolean;
    convert: ImageFormat[];
    resize: boolean;
    smartResize: boolean;
    crop: boolean;
    smartCrop: boolean;
    metadata: MetadataField[];
    urlInput: boolean;
    storageOutput: boolean;
  };
}

export type UsageSource = 'compression-count' | 'provider-query' | 'unknown';

export interface UsageSnapshot {
  providerId: ProviderId;
  accountId: string;
  usedThisMonth?: number;
  limitThisMonth?: number;
  source: UsageSource;
  observedAt: string;
}

export type AccountStatus = 'active' | 'cooldown' | 'exhausted' | 'invalid';

/** GET /providers/:id/usage 里的单个账号；绝不包含 key */
export interface AccountUsage extends UsageSnapshot {
  label: string; // 掩码，如 ab***@x.com
  remaining?: number;
  status: AccountStatus;
}

export interface ProviderUsageResponse {
  providerId: ProviderId;
  accounts: AccountUsage[];
}

export interface StorageProfileSummary {
  id: string;
  type: 's3' | 'gcs';
}
