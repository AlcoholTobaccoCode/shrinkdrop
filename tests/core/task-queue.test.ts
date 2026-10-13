import { describe, expect, it } from 'vitest';
import { TaskQueue } from '../../src/core/queues/task-queue';

describe('TaskQueue', () => {
  it('排队期间取消的任务不执行run，后续任务仍正常', async () => {
    const queue = new TaskQueue(1);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = queue.add(() => gate);
    const controller = new AbortController();
    let executions = 0;
    const queued = queue.add(async () => { executions++; }, { signal: controller.signal });
    const rejection = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    const next = queue.add(async () => 'ok');
    release();
    await first;
    await rejection;
    await expect(next).resolves.toBe('ok');
    expect(executions).toBe(0);
  });
  it('限制并发数量并等待空闲', async () => {
    const queue = new TaskQueue(2);
    let active = 0;
    let peak = 0;

    const run = () =>
      queue.add(async ({ signal }) => {
        expect(signal.aborted).toBe(false);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
        return true;
      });

    await Promise.all([run(), run(), run(), run(), run()]);
    await queue.onIdle();

    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it('单个任务失败不会阻塞后续任务', async () => {
    const queue = new TaskQueue(1);
    const failed = queue.add(async () => {
      throw new Error('boom');
    });
    const succeeded = queue.add(async () => 'ok');

    await expect(failed).rejects.toThrow('boom');
    await expect(succeeded).resolves.toBe('ok');
  });

  it('外部取消会传递到任务信号', async () => {
    const queue = new TaskQueue(1);
    const controller = new AbortController();
    const started = queue.add(
      ({ signal }) =>
        new Promise<boolean>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          setTimeout(() => resolve(true), 50);
        }),
      { signal: controller.signal }
    );

    controller.abort(new Error('cancelled'));
    await expect(started).rejects.toThrow('cancelled');
  });
});
