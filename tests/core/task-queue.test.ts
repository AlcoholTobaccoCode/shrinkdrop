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

  it('分组上限限制同时运行数量且不阻塞其他分组', async () => {
    const queue = new TaskQueue(3);
    queue.setGroupConcurrency({ large: 2 });
    const largeGates = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
    const smallGates = Array.from({ length: 2 }, () => Promise.withResolvers<void>());
    let largeActive = 0;
    let largePeak = 0;
    let smallActive = 0;
    let smallPeak = 0;

    const large = (index: number) => queue.add(async () => {
      largeActive += 1;
      largePeak = Math.max(largePeak, largeActive);
      await largeGates[index].promise;
      largeActive -= 1;
    }, { group: 'large' });
    const small = (index: number) => queue.add(async () => {
      smallActive += 1;
      smallPeak = Math.max(smallPeak, smallActive);
      await smallGates[index].promise;
      smallActive -= 1;
    });

    const all = [large(0), large(1), large(2), large(3), small(0), small(1)];
    expect(largePeak).toBe(2);
    expect(smallPeak).toBe(1);

    largeGates.forEach(gate => gate.resolve());
    smallGates.forEach(gate => gate.resolve());
    await Promise.all(all);
    expect(largePeak).toBe(2);
    expect(largeActive).toBe(0);
    expect(smallActive).toBe(0);
  });

  it('分组任务结束释放名额后排队任务继续', async () => {
    const queue = new TaskQueue(5);
    queue.setGroupConcurrency({ large: 2 });
    const gates = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
    const started: number[] = [];
    const task = (index: number) => queue.add(async () => {
      started.push(index);
      await gates[index].promise;
      return index;
    }, { group: 'large' });

    const all = [task(0), task(1), task(2), task(3)];
    expect(started).toEqual([0, 1]);

    gates[0].resolve();
    gates[1].resolve();
    await Promise.all([all[0], all[1]]);
    expect(started).toEqual([0, 1, 2, 3]);

    gates[2].resolve();
    gates[3].resolve();
    await expect(Promise.all(all)).resolves.toEqual([0, 1, 2, 3]);
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
