import { defineStore } from 'pinia';
import type { ImageProviderManifest, ProviderId } from '@tinypng/shared';
import { LOCAL_MANIFEST, findConflicts, type OperationConflict } from '../core/workbench/providers';
import type { Pipeline } from '../core/workbench/model';

export type ManifestFetcher = () => Promise<ImageProviderManifest[]>;

export const useProviderStore = defineStore('provider', {
  state: () => ({
    /** 云端 manifest 来自 GET /providers；本地内置 */
    cloudManifests: [] as ImageProviderManifest[],
    selectedCloudId: 'official-tinify' as ProviderId,
    loading: false,
    error: undefined as string | undefined
  }),
  getters: {
    all(state): ImageProviderManifest[] {
      return [LOCAL_MANIFEST, ...state.cloudManifests];
    }
  },
  actions: {
    manifest(id: ProviderId): ImageProviderManifest | undefined {
      return this.all.find(item => item.id === id);
    },
    async refresh(fetcher: ManifestFetcher): Promise<void> {
      this.loading = true;
      this.error = undefined;
      try {
        this.cloudManifests = (await fetcher()).filter(item => item.processing === 'cloud');
        if (!this.cloudManifests.some(item => item.id === this.selectedCloudId) && this.cloudManifests[0]) {
          this.selectedCloudId = this.cloudManifests[0].id;
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : '获取线路失败';
      } finally {
        this.loading = false;
      }
    },
    selectCloud(id: ProviderId): void {
      this.selectedCloudId = id;
    },
    conflicts(pipeline: Pipeline): OperationConflict[] {
      const manifest = this.manifest(pipeline.providerId);
      if (!manifest) return [];
      return findConflicts(manifest, pipeline.operations);
    }
  }
});
