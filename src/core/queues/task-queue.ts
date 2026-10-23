export interface QueueContext {
  signal: AbortSignal;
}

export interface QueueOptions {
  /** 分组上限，例如大图同时最多 2 张；未设置的分组只受总并发限制。 */
  groupConcurrency?: Record<string, number>;
  group?: string;
}

interface QueueItem<T> {
  run: (context: QueueContext) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  externalSignal?: AbortSignal;
  group?: string;
}

export class TaskQueue {
  private readonly pending: QueueItem<unknown>[] = [];
  private readonly controllers = new Set<AbortController>();
  private readonly idleWaiters: Array<() => void> = [];
  private readonly activeByGroup: Record<string, number> = {};
  private groupConcurrency: Record<string, number> = {};
  private active = 0;
  private maxConcurrency: number;

  constructor(maxConcurrency = 3) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new RangeError('maxConcurrency 必须是大于 0 的整数');
    }
    this.maxConcurrency = maxConcurrency;
  }

  setConcurrency(maxConcurrency: number): void {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new RangeError('maxConcurrency 必须是大于 0 的整数');
    }
    this.maxConcurrency = maxConcurrency;
    this.drain();
  }

  add<T>(
    run: (context: QueueContext) => Promise<T>,
    options: { signal?: AbortSignal; group?: string } = {}
  ): Promise<T> {
    if (options.signal?.aborted) {
      return Promise.reject(options.signal.reason ?? new Error('任务已取消'));
    }

    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
        externalSignal: options.signal,
        group: options.group
      });
      this.drain();
    });
  }

  /** 更新分组上限；已排队的任务会在下次调度时按新上限放行。 */
  setGroupConcurrency(groupConcurrency: Record<string, number>): void {
    this.groupConcurrency = { ...groupConcurrency };
    this.drain();
  }

  cancelAll(reason = new Error('队列已取消')): void {
    for (const controller of this.controllers) {
      controller.abort(reason);
    }

    while (this.pending.length > 0) {
      this.pending.shift()?.reject(reason);
    }

    this.resolveIdleIfNeeded();
  }

  async onIdle(): Promise<void> {
    if (this.active === 0 && this.pending.length === 0) return;
    await new Promise<void>(resolve => this.idleWaiters.push(resolve));
  }

  private drain(): void {
    while (this.active < this.maxConcurrency && this.pending.length > 0) {
      const index = this.pending.findIndex(item => {
        const limit = item.group ? this.groupConcurrency[item.group] : undefined;
        return limit === undefined || (this.activeByGroup[item.group!] ?? 0) < limit;
      });
      if (index < 0) return;
      const [item] = this.pending.splice(index, 1);
      if (item) void this.runItem(item);
    }
  }

  private async runItem<T>(item: QueueItem<T>): Promise<void> {
    this.active += 1;
    if (item.group) this.activeByGroup[item.group] = (this.activeByGroup[item.group] ?? 0) + 1;
    const controller = new AbortController();
    this.controllers.add(controller);
    const externalSignal = item.externalSignal;
    const forwardAbort = () => controller.abort(externalSignal?.reason);

    if (externalSignal) {
      externalSignal.addEventListener('abort', forwardAbort, { once: true });
      if (externalSignal.aborted) controller.abort(externalSignal.reason);
    }

    try {
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error('任务已取消');
      const value = await item.run({ signal: controller.signal });
      item.resolve(value);
    } catch (error) {
      item.reject(error);
    } finally {
      externalSignal?.removeEventListener('abort', forwardAbort);
      this.controllers.delete(controller);
      if (item.group) this.activeByGroup[item.group] = Math.max(0, (this.activeByGroup[item.group] ?? 1) - 1);
      this.active -= 1;
      this.drain();
      this.resolveIdleIfNeeded();
    }
  }

  private resolveIdleIfNeeded(): void {
    if (this.active !== 0 || this.pending.length !== 0) return;
    while (this.idleWaiters.length > 0) {
      this.idleWaiters.shift()?.();
    }
  }
}
