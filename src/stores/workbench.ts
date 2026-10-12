import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import { LIMITS, type ProcessingPolicy } from '@tinypng/shared';
import type { SourceFile } from '../core/files/contracts';
import type { Executor } from '../core/workbench/executor';
import { batchStatus, defaultPipeline, type Pipeline, type WorkbenchItem } from '../core/workbench/model';
import { queueItemView } from '../core/workbench/queue-view';

export interface RejectedFile {
  name: string;
  reason: string;
}

export type ExecutorFactory = (mode: ProcessingPolicy, pipeline: Pipeline) => Executor;

let factory: ExecutorFactory | undefined;
/** main.ts 注入：local → LocalExecutor（D3），cloud → CloudExecutor（D4） */
export function configureExecutorFactory(next: ExecutorFactory): void {
  factory = next;
}

export const useWorkbenchStore = defineStore('workbench', {
  state: () => ({
    mode: 'private-local' as ProcessingPolicy,
    pipeline: defaultPipeline(),
    items: [] as WorkbenchItem[],
    selectedItemId: undefined as string | undefined,
    rejected: [] as RejectedFile[],
    executor: undefined as Executor | undefined,
    unsubscribe: undefined as (() => void) | undefined,
    starting: false
  }),
  getters: {
    draftCount: state => state.items.filter(item => item.status === 'draft').length,
    batchStatus: state => batchStatus(state.items),
    selectedItem: state => state.items.find(item => item.id === state.selectedItemId),
    /** 本地模式不显示 URL 输入（D3 验收） */
    canAddUrls: state => state.mode === 'cloud',
    canStart(): boolean {
      return this.draftCount > 0 && !this.starting;
    },
    queue: state => {
      let position = 0;
      return state.items.map(item => ({ item, view: queueItemView(item, item.status === 'queued' ? ++position : undefined) }));
    }
  },
  actions: {
    ensureExecutor(): Executor {
      if (this.executor) return this.executor;
      if (!factory) throw new Error('执行器未配置');
      const executor = markRaw(factory(this.mode, this.pipeline));
      this.unsubscribe = markRaw(executor.subscribe(items => {
        this.items = items.map(item => ({ ...item, outputs: item.outputs.map(o => ({ ...o })) }));
        if (!this.selectedItemId && this.items[0]) this.selectedItemId = this.items[0].id;
      }));
      this.executor = executor;
      return executor;
    },
    /** 只加草稿；超过 20MB 的不进草稿，记到 rejected */
    addFiles(files: readonly SourceFile[]): void {
      const accepted: SourceFile[] = [];
      for (const file of files) {
        if (file.size > LIMITS.maxFileBytes) {
          this.rejected.push({ name: file.name, reason: '超过 ' + String(LIMITS.maxFileBytes / 1024 / 1024) + ' MB，未加入' });
        } else {
          accepted.push(file);
        }
      }
      if (accepted.length) this.ensureExecutor().addFiles(accepted);
    },
    addUrls(urls: readonly string[]): void {
      if (!this.canAddUrls) throw new Error('本地私有模式不支持 URL 输入');
      const executor = this.ensureExecutor();
      if (!executor.addUrls) throw new Error('当前执行器不支持 URL 输入');
      executor.addUrls(urls);
    },
    dismissRejected(index: number): void {
      this.rejected.splice(index, 1);
    },
    setPipeline(pipeline: Pipeline): void {
      this.pipeline = pipeline;
      this.executor?.setPipeline(pipeline);
    },
    /** 用户点“开始处理 (n)” */
    async start(): Promise<void> {
      if (!this.canStart || !this.executor) return;
      this.starting = true;
      const run = this.executor.start();
      this.starting = false;
      await run;
    },
    cancel(id: string): void { this.executor?.cancel(id); },
    cancelAll(): void { this.executor?.cancelAll(); },
    retry(id: string, scope: 'all' | 'outputs' = 'all'): Promise<void> {
      return this.executor?.retry(id, scope) ?? Promise.resolve();
    },
    remove(id: string): boolean {
      const ok = this.executor?.remove(id) ?? false;
      if (ok && this.selectedItemId === id) this.selectedItemId = undefined;
      return ok;
    },
    select(id: string | undefined): void {
      this.selectedItemId = id;
    },
    /**
     * 切换模式：已有草稿在新执行器里重建；切到本地时移除 URL 草稿，返回移除数量（UI toast）。
     * 运行中不允许切换。
     */
    async switchMode(mode: ProcessingPolicy, providerId = mode === 'private-local' ? 'local' : 'official-tinify'): Promise<{ removedUrlDrafts: number }> {
      if (mode === this.mode) return { removedUrlDrafts: 0 };
      if (this.items.some(item => ['queued', 'uploading', 'processing', 'saving'].includes(item.status))) {
        throw new Error('处理中不能切换模式');
      }
      const drafts = this.items.filter(item => item.status === 'draft');
      const fileDrafts = drafts.flatMap(item => (item.source.kind === 'file' ? [item.source.file] : []));
      const urlDrafts = drafts.flatMap(item => (item.source.kind === 'url' ? [item.source.url] : []));
      this.unsubscribe?.();
      await this.executor?.dispose();
      this.executor = undefined;
      this.items = [];
      this.selectedItemId = undefined;
      this.mode = mode;
      this.pipeline = { ...this.pipeline, providerId };
      if (fileDrafts.length) this.addFiles(fileDrafts);
      let removed = 0;
      if (mode === 'cloud' && urlDrafts.length) this.addUrls(urlDrafts);
      else removed = urlDrafts.length;
      return { removedUrlDrafts: removed };
    },
    async clear(): Promise<void> {
      this.unsubscribe?.();
      await this.executor?.dispose();
      this.executor = undefined;
      this.items = [];
      this.selectedItemId = undefined;
      this.rejected = [];
    }
  }
});
