export interface QueueContext {
  signal: AbortSignal;
}

interface QueueItem<T> {
  run: (context: QueueContext) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  externalSignal?: AbortSignal;
}

export class TaskQueue {
  private readonly pending: QueueItem<unknown>[] = [];
  private readonly controllers = new Set<AbortController>();
  private readonly idleWaiters: Array<() => void> = [];
  private active = 0;

  constructor(private readonly maxConcurrency = 3) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new RangeError('maxConcurrency 必须是大于 0 的整数');
    }
  }

  add<T>(
    run: (context: QueueContext) => Promise<T>,
    options: { signal?: AbortSignal } = {}
  ): Promise<T> {
    if (options.signal?.aborted) {
      return Promise.reject(options.signal.reason ?? new Error('任务已取消'));
    }

    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
        externalSignal: options.signal
      });
      this.drain();
    });
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
      const item = this.pending.shift();
      if (item) void this.runItem(item);
    }
  }

  private async runItem<T>(item: QueueItem<T>): Promise<void> {
    this.active += 1;
    const controller = new AbortController();
    this.controllers.add(controller);
    const externalSignal = item.externalSignal;
    const forwardAbort = () => controller.abort(externalSignal?.reason);

    if (externalSignal) {
      externalSignal.addEventListener('abort', forwardAbort, { once: true });
      if (externalSignal.aborted) controller.abort(externalSignal.reason);
    }

    try {
      const value = await item.run({ signal: controller.signal });
      item.resolve(value);
    } catch (error) {
      item.reject(error);
    } finally {
      externalSignal?.removeEventListener('abort', forwardAbort);
      this.controllers.delete(controller);
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
