import { describe, expect, it, vi } from 'vitest';
import { createShareSession } from '../../src/core/share/session';
import type { ShareAdapter, ShareStatus } from '../../src/core/share/types';

const runningStatus = (overrides: Partial<ShareStatus> = {}): ShareStatus => ({
  running: true,
  url: 'http://192.168.1.5:5421/s/token',
  port: null,
  files: [{ id: 1, name: 'a.png', size: 1024, url: '/s/token/f/1' }],
  addresses: ['192.168.1.5'],
  warning: null,
  ...overrides
});

const stoppedStatus = (): ShareStatus => ({
  running: false, url: null, port: null, files: [], addresses: [], warning: null
});

const flush = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };

function fixture() {
  let push: (status: ShareStatus) => void = () => {};
  const adapter: ShareAdapter = {
    desktop: true,
    status: vi.fn(async () => stoppedStatus()),
    start: vi.fn(async () => runningStatus()),
    stop: vi.fn(async () => stoppedStatus()),
    addFiles: vi.fn(async () => runningStatus({
      files: [
        { id: 1, name: 'a.png', size: 1024, url: '/s/token/f/1' },
        { id: 2, name: 'b.png', size: 2048, url: '/s/token/f/2' }
      ]
    })),
    removeFile: vi.fn(async () => runningStatus({ files: [] })),
    pickFiles: vi.fn(async () => ['/tmp/a.png']),
    qrSvg: vi.fn(async () => '<svg></svg>'),
    onStatus: vi.fn(async handler => { push = handler; return () => {}; }),
    setTitle: vi.fn(async () => {})
  };
  return { adapter, emit: (status: ShareStatus) => push(status) };
}

describe('share session', () => {
  it('subscribes to native events and starts idle', async () => {
    const { adapter } = fixture();
    const session = createShareSession(adapter);
    const stop = await session.connect();
    expect(adapter.onStatus).toHaveBeenCalledOnce();
    expect(adapter.status).toHaveBeenCalledOnce();
    expect(session.state.phase).toBe('idle');
    expect(session.running.value).toBe(false);
    stop();
  });

  it('picks files, starts sharing and renders the QR code', async () => {
    const { adapter } = fixture();
    const session = createShareSession(adapter);
    await session.pickAndShare();
    await flush();

    expect(adapter.start).toHaveBeenCalledWith(['/tmp/a.png']);
    expect(session.state.phase).toBe('running');
    expect(session.running.value).toBe(true);
    expect(session.state.url).toContain('/s/token');
    expect(session.state.files).toHaveLength(1);
    expect(session.state.qr).toBe('<svg></svg>');
    expect(session.port.value).toBe(5421);
  });

  it('returns to idle when the picker is canceled', async () => {
    const { adapter } = fixture();
    adapter.pickFiles = vi.fn(async () => []);
    const session = createShareSession(adapter);
    await session.pickAndShare();
    expect(adapter.start).not.toHaveBeenCalled();
    expect(session.state.phase).toBe('idle');
    expect(session.state.error).toBe('');
  });

  it('surfaces start failures without leaving the starting state', async () => {
    const { adapter } = fixture();
    adapter.start = vi.fn(async () => { throw new Error('端口被占用'); });
    const session = createShareSession(adapter);
    await session.pickAndShare();
    expect(session.state.phase).toBe('idle');
    expect(session.state.error).toBe('端口被占用');
  });

  it('adds and removes files while running', async () => {
    const { adapter } = fixture();
    const session = createShareSession(adapter);
    await session.pickAndShare();
    await session.addFiles();
    expect(session.state.files).toHaveLength(2);

    await session.remove(1);
    expect(adapter.removeFile).toHaveBeenCalledWith(1);
    expect(session.state.files).toHaveLength(0);
  });

  it('stops sharing and clears the link', async () => {
    const { adapter } = fixture();
    const session = createShareSession(adapter);
    await session.pickAndShare();
    await session.stop();
    expect(session.state.phase).toBe('idle');
    expect(session.state.url).toBe('');
    expect(session.state.qr).toBe('');
  });

  it('applies pushed status events', async () => {
    const { adapter, emit } = fixture();
    const session = createShareSession(adapter);
    await session.connect();
    emit(runningStatus({ files: [] }));
    await flush();
    expect(session.state.phase).toBe('running');
    expect(session.state.files).toHaveLength(0);
  });
});
