import { describe, expect, it, vi } from 'vitest';
import { createLiteSession } from '../../src/core/lite/session';
import type { CompressionResult, LiteAdapter, SourceFile } from '../../src/core/lite/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const source = (id: string, overrides: Partial<SourceFile> = {}): SourceFile => ({
  id, name: `${id}.png`, size: 1000, mime: 'image/png', relativePath: `${id}.png`, ...overrides
});
const output = (id: string, size = 500): CompressionResult => ({
  tempFileId: `temp-${id}`, size, mime: 'image/png', width: 10, height: 10, site: 'tinypng.com'
});
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
const emptyImportMessage = '没有可导入的图片，请确认文件可读、格式为 PNG/JPG/WebP，单张不超过 20 MB';

function fixture(desktop = true) {
  const requests: Array<{ sourceId: string; taskId: string; gate: ReturnType<typeof deferred<CompressionResult>> }> = [];
  const adapter: LiteAdapter = {
    desktop,
    chooseFiles: vi.fn(async () => []),
    chooseDirectory: vi.fn(async () => []),
    readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
    compress: vi.fn((sourceId, taskId) => {
      const gate = deferred<CompressionResult>();
      requests.push({ sourceId, taskId, gate });
      return gate.promise;
    }),
    cancel: vi.fn(async () => undefined),
    save: vi.fn(async () => ({ saved: true })),
    saveResults: vi.fn(async ids => ({ saved: ids.length, failed: [], canceled: false })),
    overwrite: vi.fn(async () => ({ overwritten: true })),
    overwriteResults: vi.fn(async ids => ({ overwritten: ids.length, failed: [], canceled: false })),
    cleanup: vi.fn(async () => undefined)
  };
  let serial = 0;
  const urls = { createObjectURL: vi.fn(() => `blob:${++serial}`), revokeObjectURL: vi.fn() };
  const session = createLiteSession(adapter, { sessionId: 'session', ...urls });
  return { session, adapter, requests, urls };
}

describe('shrinkdrop session', () => {
  it('imports drafts and thumbnails without uploading', async () => {
    const { session, adapter } = fixture();
    await session.importSources([source('a')]);
    expect(session.state.items[0]).toMatchObject({ status: 'draft', thumbnailUrl: 'blob:1' });
    expect(adapter.compress).not.toHaveBeenCalled();
  });

  it('auto compression is opt-in, starts existing drafts and keeps at most five active requests', async () => {
    const { session, requests } = fixture();
    expect(session.state.autoCompress).toBe(false);
    await session.importSources(Array.from({ length: 7 }, (_, index) => source(String(index))));
    expect(requests).toHaveLength(0);
    session.setAutoCompress(true);
    expect(requests).toHaveLength(5);
    expect(session.state.items.filter(item => item.status === 'queued')).toHaveLength(2);
    requests[0]!.gate.resolve(output('0')); await flush();
    requests[1]!.gate.resolve(output('1')); await flush();
    requests.forEach(request => request.gate.resolve(output(request.sourceId)));
    await session.whenIdle();
  });

  it('auto compression starts newly imported images before slow thumbnails finish', async () => {
    const { session, requests, adapter } = fixture();
    const reading = deferred<Uint8Array>();
    vi.mocked(adapter.readFile).mockReturnValue(reading.promise);
    session.setAutoCompress(true);
    const importing = session.importSources([source('a')]);
    expect(requests).toHaveLength(1);
    reading.resolve(new Uint8Array([1])); await importing;
    requests[0]!.gate.resolve(output('a')); await session.whenIdle();
    session.setAutoCompress(false);
    await session.importSources([source('b')]);
    expect(session.state.items[1]!.status).toBe('draft');
    expect(requests).toHaveLength(1);
  });

  it('turning auto compression off preserves active work and never retries failed or canceled rows', async () => {
    const { session, requests } = fixture();
    session.setAutoCompress(true); await session.importSources([source('a'), source('b')]);
    session.setAutoCompress(false);
    expect(session.state.items[0]!.status).toBe('processing');
    requests[0]!.gate.reject('HTTP 401');
    await session.cancel(session.state.items[1]!.id);
    requests[1]!.gate.resolve(output('b')); await session.whenIdle();
    session.setAutoCompress(true);
    expect(requests).toHaveLength(2);
    expect(session.state.items.map(item => item.status)).toEqual(['failed', 'canceled']);
  });

  it.each(['files', 'directory'] as const)('reports the native empty-import reason for %s selection', async kind => {
    const { session, adapter } = fixture();
    const picker = kind === 'files' ? adapter.chooseFiles : adapter.chooseDirectory;
    vi.mocked(picker).mockRejectedValue(emptyImportMessage);
    await session.choose(kind);
    expect(session.state.notice).toBe(emptyImportMessage);
    expect(session.state.noticeKind).toBe('error');
    expect(session.state.items).toHaveLength(0);
    expect(session.state.importing).toBe(false);
  });

  it.each(['files', 'directory'] as const)('keeps canceled %s selection silent', async kind => {
    const { session } = fixture();
    await session.choose(kind);
    expect(session.state.notice).toBe('');
    expect(session.state.items).toHaveLength(0);
  });

  it('reports a rejected native drop and still imports valid dropped files as drafts', async () => {
    const { session, adapter } = fixture();
    await session.importSources([], { reportEmpty: true });
    expect(session.state.notice).toBe(emptyImportMessage);
    expect(session.state.noticeKind).toBe('error');
    await session.importSources([source('a')], { reportEmpty: true });
    expect(session.state.items[0]!.status).toBe('draft');
    expect(session.state.notice).toBe('');
    expect(adapter.compress).not.toHaveBeenCalled();
  });

  it('does not echo an unknown import response', async () => {
    const { session, adapter } = fixture();
    vi.mocked(adapter.chooseFiles).mockRejectedValue(`<html>${emptyImportMessage}</html>`);
    await session.choose('files');
    expect(session.state.notice).toBe('无法读取所选文件，请重新选择。');
  });

  it('rejects invalid or oversized files and keeps distinct files with the same basename', async () => {
    const { session } = fixture();
    await session.importSources([
      source('a', { name: 'same.png' }), source('b', { name: 'same.png' }), source('a'),
      source('text', { name: 'note.txt', mime: 'text/plain' }), source('large', { size: 20_000_001 }),
      source('wrong', { name: 'wrong.png', mime: 'text/plain' }), source('empty', { size: 0 })
    ]);
    expect(session.state.items.map(item => item.source.id)).toEqual(['a', 'b']);
    expect(session.state.notice).toMatch(/5/);
  });

  it('rejects AVIF while retaining only PNG, JPEG and WebP support', async () => {
    const { session } = fixture();
    await session.importSources([
      source('avif', { name: 'picture.avif', mime: 'image/avif' }),
      source('jpeg', { name: 'picture.jpg', mime: 'image/jpeg' }),
      source('webp', { name: 'picture.webp', mime: 'image/webp' })
    ]);
    expect(session.state.items.map(item => item.source.id)).toEqual(['jpeg', 'webp']);
    expect(session.state.notice).toContain('PNG、JPEG、WebP');
    expect(session.state.notice).not.toContain('AVIF');
  });

  it('starts at most five uploads and a repeated Start never duplicates tasks', async () => {
    const { session, requests } = fixture();
    await session.importSources(Array.from({ length: 8 }, (_, index) => source(String(index))));
    session.start(); session.start();
    expect(requests).toHaveLength(5);
    expect(session.state.items.filter(item => item.status === 'queued')).toHaveLength(3);
    requests[0]!.gate.resolve(output('0')); await flush();
    expect(requests).toHaveLength(6);
    requests.forEach(request => request.gate.resolve(output(request.sourceId)));
    await flush(); requests.forEach(request => request.gate.resolve(output(request.sourceId)));
    await session.whenIdle();
    expect(requests).toHaveLength(8);
  });

  it('canceling a queued item never starts its upload', async () => {
    const { session, requests, adapter } = fixture();
    await session.importSources(Array.from({ length: 6 }, (_, index) => source(String(index))));
    session.start();
    await session.cancel(session.state.items[5]!.id);
    requests.forEach(request => request.gate.resolve(output(request.sourceId)));
    await session.whenIdle();
    expect(requests).toHaveLength(5);
    expect(adapter.cancel).not.toHaveBeenCalled();
    expect(session.state.items[5]!.status).toBe('canceled');
  });

  it('ignores completion after an acknowledged cancel', async () => {
    const { session, requests } = fixture();
    await session.importSources([source('a')]); session.start();
    await session.cancel(session.state.items[0]!.id);
    requests[0]!.gate.resolve(output('a')); await session.whenIdle();
    expect(session.state.items[0]).toMatchObject({ status: 'canceled' });
    expect(session.state.items[0]!.result).toBeUndefined();
  });

  it('retry uses a new task id while canceled work still occupies its native slot', async () => {
    const { session, requests } = fixture();
    await session.importSources(Array.from({ length: 5 }, (_, index) => source(String(index))));
    session.start();
    const item = session.state.items[0]!;
    await session.cancel(item.id); session.retry(item.id);
    expect(requests).toHaveLength(5);
    expect(item.status).toBe('queued');
    requests[0]!.gate.resolve(output('0')); await flush();
    expect(requests).toHaveLength(6);
    expect(requests[5]!.taskId).not.toBe(requests[0]!.taskId);
    requests.slice(1).forEach(request => request.gate.resolve(output(request.sourceId)));
    await session.whenIdle();
    expect(item.status).toBe('completed');
  });

  it('shows cancel pending until acknowledgement and preserves a task when native cancellation fails', async () => {
    const { session, requests, adapter } = fixture();
    const cancellation = deferred<void>();
    vi.mocked(adapter.cancel).mockImplementation(() => cancellation.promise);
    await session.importSources([source('a')]); session.start();
    const item = session.state.items[0]!;
    const canceling = session.cancel(item.id);
    expect(item.status).toBe('processing'); expect(item.cancelPending).toBe(true);
    cancellation.reject(new Error('native unavailable')); await canceling;
    expect(item.status).toBe('processing'); expect(item.cancelPending).toBe(false);
    expect(item.cancelError).toMatch(/取消.*仍在/);
    requests[0]!.gate.resolve(output('a')); await session.whenIdle();
    expect(item.status).toBe('completed');
    expect(item.cancelError).toBeUndefined();
  });

  it('clear cancels active tasks, waits for settlement, then removes and cleans thumbnails', async () => {
    const { session, requests, adapter, urls } = fixture();
    await session.importSources([source('a'), source('b')]); session.start();
    const clearing = session.clear(); await flush();
    expect(adapter.cancel).toHaveBeenCalledTimes(2);
    expect(adapter.cleanup).not.toHaveBeenCalled();
    requests.forEach(request => request.gate.reject(new Error('canceled')));
    await clearing;
    expect(session.state.items).toHaveLength(0);
    expect(urls.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(adapter.cleanup).toHaveBeenCalledWith('session');
  });

  it('clear preserves rows if any active cancellation fails', async () => {
    const { session, adapter, requests } = fixture();
    vi.mocked(adapter.cancel).mockRejectedValue(new Error('failed'));
    await session.importSources([source('a')]); session.start();
    expect(await session.clear()).toBe(false);
    expect(session.state.items).toHaveLength(1);
    expect(adapter.cleanup).not.toHaveBeenCalled();
    requests[0]!.gate.resolve(output('a')); await session.whenIdle();
  });

  it('starts a fresh native session after Clear permanently retires the old prefix', async () => {
    const { session, adapter } = fixture();
    const retired = new Set<string>();
    const taskIds: string[] = [];
    vi.mocked(adapter.cleanup).mockImplementation(async id => { retired.add(id); });
    vi.mocked(adapter.compress).mockImplementation(async (sourceId, taskId) => {
      taskIds.push(taskId);
      if (Array.from(retired).some(id => taskId.startsWith(`${id}-`))) throw '任务已取消';
      return output(sourceId);
    });
    await session.importSources([source('first')]); session.start(); await session.whenIdle();
    const firstSession = session.sessionId;
    await session.clear();
    expect(retired.has(firstSession)).toBe(true);
    await session.importSources([source('next')]); session.start(); await session.whenIdle();
    expect(session.state.items[0]!.status).toBe('completed');
    expect(session.sessionId).not.toBe(firstSession);
    expect(taskIds[1]).toContain(`${session.sessionId}-`);
    await session.dispose();
    expect(adapter.cleanup).toHaveBeenLastCalledWith(session.sessionId);
  });

  it('rotates the retired session even when native file cleanup reports a failure', async () => {
    const { session, adapter } = fixture();
    vi.mocked(adapter.cleanup).mockRejectedValue(new Error('部分临时文件清理失败，请重新启动应用后重试'));
    const retiredId = session.sessionId;
    await session.importSources([source('a')]); await session.clear();
    expect(session.sessionId).not.toBe(retiredId);
    expect(adapter.cleanup).toHaveBeenCalledWith(retiredId);
    expect(session.state.notice).toContain('清理未完成');
  });

  it.each([
    '匿名压缩被服务拒绝，请稍后再试',
    '压缩请求太频繁，请稍后再试',
    '无法连接压缩服务，请检查网络后重试',
    '无法初始化网络连接，请重新启动应用',
    '压缩服务响应超时，请重试',
    '压缩超过 60 秒，请检查网络后重试',
    '图片已损坏，无法读取',
    '图片内容不完整或已损坏，请换一张图片',
    '图片尺寸过大，请先缩小图片',
    '服务拒绝了这张图片，请选择较小的图片',
    '压缩服务暂时不可用，请稍后重试'
  ])('retains the approved native failure reason: %s', async message => {
    const { session, requests } = fixture();
    await session.importSources([source('a')]); session.start();
    requests[0]!.gate.reject(message); await session.whenIdle();
    expect(session.state.items[0]!.error).toBe(message);
  });

  it.each([
    ['HTTP 401', '匿名压缩被服务拒绝，请稍后再试'],
    ['HTTP 403', '匿名压缩被服务拒绝，请稍后再试'],
    ['HTTP 429', '压缩请求太频繁，请稍后再试'],
    ['HTTP 413', '服务拒绝了这张图片，请选择较小的图片'],
    ['Network connection timed out', '网络连接失败，请检查网络后重试。'],
    ['<html><body>401 匿名压缩被服务拒绝<script>alert(1)</script></body></html>', '压缩失败，请稍后重试。'],
    ['unexpected response', '压缩失败，请稍后重试。']
  ])('maps technical errors to fixed Chinese feedback without echoing remote bodies: %s', async (error, expected) => {
    const { session, requests } = fixture();
    await session.importSources([source('a')]); session.start();
    requests[0]!.gate.reject(new Error(error)); await session.whenIdle();
    expect(session.state.items[0]!.error).toBe(expected);
  });

  it('dispose cancels work and defers cleanup until late completion', async () => {
    const { session, adapter, requests, urls } = fixture();
    await session.importSources([source('a')]); session.start();
    const disposing = session.dispose(); await flush();
    expect(adapter.cancel).toHaveBeenCalledTimes(1);
    expect(adapter.cleanup).not.toHaveBeenCalled();
    expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:1');
    requests[0]!.gate.resolve(output('a')); await disposing;
    expect(adapter.cleanup).toHaveBeenCalledWith('session');
  });

  it('dispose does not delete a completed output while its save dialog is still pending', async () => {
    const { session, adapter, requests } = fixture();
    await session.importSources([source('a')]); session.start();
    requests[0]!.gate.resolve(output('a')); await session.whenIdle();
    const saving = deferred<{ saved: boolean }>();
    vi.mocked(adapter.save).mockImplementation(() => saving.promise);
    const save = session.save(session.state.items[0]!.id);
    const disposing = session.dispose(); await flush();
    expect(adapter.cleanup).not.toHaveBeenCalled();
    saving.resolve({ saved: true }); await save; await disposing;
    expect(adapter.cleanup).toHaveBeenCalledWith('session');
  });

  it('removing a row revokes its thumbnail and cannot remove processing work', async () => {
    const { session, urls, requests } = fixture();
    await session.importSources([source('a'), source('b')]);
    expect(session.remove(session.state.items[0]!.id)).toBe(true);
    expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:1');
    session.start();
    expect(session.remove(session.state.items[0]!.id)).toBe(false);
    requests[0]!.gate.resolve(output('b')); await session.whenIdle();
  });

  it('revokes a thumbnail whose read finishes after removal', async () => {
    const { session, adapter, urls } = fixture();
    const read = deferred<Uint8Array>();
    vi.mocked(adapter.readFile).mockImplementation(() => read.promise);
    const importing = session.importSources([source('a')]);
    session.remove(session.state.items[0]!.id);
    read.resolve(new Uint8Array([1])); await importing;
    expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:1');
  });

  it('save failure leaves compression completed and retry only saves again', async () => {
    const { session, adapter, requests } = fixture();
    await session.importSources([source('a')]); session.start();
    requests[0]!.gate.resolve(output('a')); await session.whenIdle();
    const item = session.state.items[0]!;
    vi.mocked(adapter.save).mockRejectedValueOnce(new Error('disk full'));
    await session.save(item.id);
    expect(item.status).toBe('completed'); expect(item.saveError).toMatch(/保存/);
    await session.save(item.id);
    expect(item.saved).toBe(true); expect(item.saveError).toBeUndefined();
    expect(adapter.compress).toHaveBeenCalledTimes(1);
  });

  it.each([
    '请换一个文件名或目录，保存结果不能覆盖原图',
    '目标文件已存在，请换一个文件名',
    '无法访问保存目录，请换一个位置',
    '压缩结果已失效，请重新处理',
    '压缩结果无法读取，请重新处理',
    '保存失败，目标文件已存在或目录不可写',
    '同名文件过多，请换一个保存目录'
  ])('retains the controlled native single-save failure: %s', async message => {
    const { session, adapter, requests } = fixture();
    await session.importSources([source('a')]); session.start();
    requests[0]!.gate.resolve(output('a')); await session.whenIdle();
    vi.mocked(adapter.save).mockRejectedValue(new Error(message));
    await session.save(session.state.items[0]!.id);
    expect(session.state.items[0]!.saveError).toBe(message);
    expect(session.state.items[0]!.status).toBe('completed');
    expect(session.state.items[0]!.saved).toBe(false);
    expect(adapter.compress).toHaveBeenCalledTimes(1);
  });

  it.each(['unknown disk error', '<html>目标文件已存在，请换一个文件名</html>'])('does not echo an uncontrolled single-save response: %s', async message => {
    const { session, adapter, requests } = fixture();
    await session.importSources([source('a')]); session.start();
    requests[0]!.gate.resolve(output('a')); await session.whenIdle();
    vi.mocked(adapter.save).mockRejectedValue(message);
    await session.save(session.state.items[0]!.id);
    expect(session.state.items[0]!.saveError).toBe('保存失败，请检查目标文件夹或可用空间后重试。');
  });

  it('maps partial bulk save failures by temporary file id', async () => {
    const { session, adapter, requests } = fixture();
    await session.importSources([source('a'), source('b')]); session.start();
    requests.forEach(request => request.gate.resolve(output(request.sourceId))); await session.whenIdle();
    vi.mocked(adapter.saveResults).mockResolvedValue({
      saved: 1, failed: [{ id: 'temp-b', name: 'b.png', message: 'disk full' }], canceled: false
    });
    await session.saveAll();
    expect(session.state.items[0]!.saved).toBe(true);
    expect(session.state.items[1]!.saveError).toMatch(/保存/);
    expect(session.state.notice).toMatch(/1.*1/);
  });

  it.each([
    ['请换一个文件名或目录，保存结果不能覆盖原图', '请换一个文件名或目录，保存结果不能覆盖原图'],
    ['目标文件已存在，请换一个文件名', '目标文件已存在，请换一个文件名'],
    ['无法访问保存目录，请换一个位置', '无法访问保存目录，请换一个位置'],
    ['压缩结果已失效，请重新处理', '压缩结果已失效，请重新处理'],
    ['<html>cannot save</html>', '保存失败，请检查目标文件夹或可用空间后重试。'],
    ['unknown error', '保存失败，请检查目标文件夹或可用空间后重试。']
  ])('maps a partial bulk failure using the same controlled save feedback: %s', async (message, expected) => {
    const { session, adapter, requests } = fixture();
    await session.importSources([source('a'), source('b')]); session.start();
    requests.forEach(request => request.gate.resolve(output(request.sourceId))); await session.whenIdle();
    vi.mocked(adapter.saveResults).mockResolvedValue({
      saved: 1, failed: [{ id: 'temp-b', name: 'b.png', message }], canceled: false
    });
    await session.saveAll();
    expect(session.state.items[0]!.saved).toBe(true);
    expect(session.state.items[1]!.saveError).toBe(expected);
    expect(session.state.items[1]!.status).toBe('completed');
  });

  it.each([
    ['无法访问保存目录，请换一个位置', '无法访问保存目录，请换一个位置'],
    ['<html>access denied</html>', '保存失败，请检查目标文件夹或可用空间后重试。']
  ])('also controls feedback when bulk save rejects before returning per-file results: %s', async (message, expected) => {
    const { session, adapter, requests } = fixture();
    await session.importSources([source('a')]); session.start();
    requests[0]!.gate.resolve(output('a')); await session.whenIdle();
    vi.mocked(adapter.saveResults).mockRejectedValue(message);
    await session.saveAll();
    expect(session.state.items[0]!.saveError).toBe(expected);
    expect(session.state.notice).toBe(expected);
    expect(session.state.items[0]!.status).toBe('completed');
  });

  it('a canceled bulk dialog does not mark unsaved items saved or announce success', async () => {
    const { session, adapter, requests } = fixture();
    await session.importSources([source('a')]); session.start();
    requests[0]!.gate.resolve(output('a')); await session.whenIdle();
    vi.mocked(adapter.saveResults).mockResolvedValue({ saved: 0, failed: [], canceled: true });
    await session.saveAll();
    expect(session.state.items[0]!.saved).toBe(false);
    expect(session.state.notice).toBe('已取消保存。');
  });

  it('single overwrite cancellation leaves the result and original status unchanged', async () => {
    const { session, adapter, requests } = fixture();
    await session.importSources([source('a')]); session.start();
    requests[0]!.gate.resolve(output('a')); await session.whenIdle();
    vi.mocked(adapter.overwrite).mockResolvedValueOnce({ overwritten: false });
    const item = session.state.items[0]!;
    await session.overwrite(item.id);
    expect(item.overwritten).toBe(false);
    expect(item.result?.tempFileId).toBe('temp-a');
    expect(session.state.notice).toBe('已取消覆盖，原图未修改。');
    await session.overwrite(item.id);
    expect(item.overwritten).toBe(true);
    expect(adapter.overwrite).toHaveBeenCalledTimes(2);
    expect(adapter.compress).toHaveBeenCalledTimes(1);
  });

  it('overwrite blocks duplicate dialogs and clearing until native confirmation and replacement settle', async () => {
    const { session, adapter, requests } = fixture();
    await session.importSources([source('a')]); session.start();
    requests[0]!.gate.resolve(output('a')); await session.whenIdle();
    const gate = deferred<{ overwritten: boolean }>();
    vi.mocked(adapter.overwrite).mockReturnValue(gate.promise);
    const replacing = session.overwrite(session.state.items[0]!.id);
    expect(session.summary.value.saving).toBe(true);
    await session.overwrite(session.state.items[0]!.id);
    expect(await session.clear()).toBe(false);
    expect(adapter.overwrite).toHaveBeenCalledTimes(1);
    gate.resolve({ overwritten: true }); await replacing;
    expect(session.summary.value.saving).toBe(false);
    expect(session.state.items[0]!.overwritten).toBe(true);
  });

  it('partial batch overwrite reports failures by result id and retries only remaining rows', async () => {
    const { session, adapter, requests } = fixture();
    await session.importSources([source('a'), source('b')]); session.start();
    requests.forEach(request => request.gate.resolve(output(request.sourceId))); await session.whenIdle();
    vi.mocked(adapter.overwriteResults).mockResolvedValueOnce({
      overwritten: 1, failed: [{ id: 'temp-b', name: 'b.png', message: '原图已被修改，请重新导入并压缩后再覆盖' }], canceled: false
    });
    await session.overwriteAll();
    expect(session.state.items[0]!.overwritten).toBe(true);
    expect(session.state.items[1]!.overwritten).toBe(false);
    expect(session.state.items[1]!.overwriteError).toContain('原图已被修改');
    expect(session.state.notice).toMatch(/1.*1/);
    await session.overwriteAll();
    expect(adapter.overwriteResults).toHaveBeenLastCalledWith(['temp-b']);
    expect(session.state.items[1]!.overwritten).toBe(true);
    expect(session.state.items[1]!.overwriteError).toBeUndefined();
    expect(adapter.compress).toHaveBeenCalledTimes(2);
  });

  it('canceling batch overwrite never marks rows overwritten and allows saving copies', async () => {
    const { session, adapter, requests } = fixture();
    await session.importSources([source('a')]); session.start();
    requests[0]!.gate.resolve(output('a')); await session.whenIdle();
    vi.mocked(adapter.overwriteResults).mockResolvedValue({ overwritten: 0, failed: [], canceled: true });
    await session.overwriteAll();
    expect(session.state.items[0]!.overwritten).toBe(false);
    expect(session.state.notice).toBe('已取消覆盖，原图未修改。');
    await session.save(session.state.items[0]!.id);
    expect(session.state.items[0]!.saved).toBe(true);
  });

  it('unknown overwrite errors are friendly and retry never uploads again', async () => {
    const { session, adapter, requests } = fixture();
    await session.importSources([source('a')]); session.start();
    requests[0]!.gate.resolve(output('a')); await session.whenIdle();
    vi.mocked(adapter.overwrite).mockRejectedValueOnce('<html>disk full</html>');
    const item = session.state.items[0]!;
    await session.overwrite(item.id);
    expect(item.overwriteError).toBe('覆盖失败，请检查原图权限或可用空间后重试。');
    expect(item.status).toBe('completed');
    await session.overwrite(item.id);
    expect(item.overwritten).toBe(true);
    expect(adapter.compress).toHaveBeenCalledTimes(1);
  });

  it('retains completed output and reports an increased size truthfully', async () => {
    const { session, requests } = fixture();
    await session.importSources([source('a')]); session.start();
    requests[0]!.gate.resolve(output('a', 1500)); await session.whenIdle();
    expect(session.summary.value.savedBytes).toBe(-500);
    expect(session.summary.value.completed).toBe(1);
  });

  it('browser preview cannot upload or save even when commands are called directly', async () => {
    const { session, adapter } = fixture(false);
    await session.importSources([source('a')]); session.start();
    await session.saveAll();
    expect(adapter.compress).not.toHaveBeenCalled(); expect(adapter.saveResults).not.toHaveBeenCalled();
    expect(session.state.items[0]!.status).toBe('draft');
  });

  it('progress only updates the current attempt and does not invent percentages', async () => {
    const { session, requests } = fixture();
    await session.importSources([source('a')]); session.start();
    session.updateProgress({ taskId: requests[0]!.taskId, stage: 'downloading' });
    expect(session.state.items[0]!.stage).toBe('downloading');
    await session.cancel(session.state.items[0]!.id); session.retry(session.state.items[0]!.id);
    session.updateProgress({ taskId: requests[0]!.taskId, stage: 'downloading' });
    expect(session.state.items[0]!.stage).toBe('uploading');
    requests[0]!.gate.resolve(output('a')); await flush();
    requests[1]!.gate.resolve(output('a')); await session.whenIdle();
  });

  it('keeps byte progress bounded, ignores stale attempts, and only completes after the result is ready', async () => {
    const { session, requests } = fixture();
    await session.importSources([source('a')]); session.start();
    const item = session.state.items[0]!;
    session.updateProgress({ taskId: requests[0]!.taskId, stage: 'uploading', transferred: 500, total: 1000 });
    expect(item.progress).toBeGreaterThan(0);
    expect(item.progress).toBeLessThan(0.5);
    session.updateProgress({ taskId: requests[0]!.taskId, stage: 'processing' });
    const waiting = item.progress;
    session.updateProgress({ taskId: requests[0]!.taskId, stage: 'downloading', transferred: 500, total: 500 });
    expect(item.progress).toBeGreaterThan(waiting);
    expect(item.progress).toBeLessThan(1);
    session.updateProgress({ taskId: requests[0]!.taskId, stage: 'downloading', transferred: -2, total: 500 });
    expect(item.progress).toBeGreaterThan(waiting);
    requests[0]!.gate.resolve(output('a')); await session.whenIdle();
    expect(item.progress).toBe(1);
    expect(item.status).toBe('completed');
  });
});
