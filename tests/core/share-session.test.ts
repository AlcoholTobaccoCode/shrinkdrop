import { describe, expect, it, vi } from 'vitest';
import { createShareSession } from '../../src/core/share/session';
import type { ShareAdapter, ShareStatus } from '../../src/core/share/types';

const runningStatus = (overrides: Partial<ShareStatus> = {}): ShareStatus => ({
  running: true,
  url: 'http://192.168.1.5:5421/s/token',
  port: null,
  items: [{ id: 1, kind: 'file', name: 'a.png', size: 1024, modified: null }],
  addresses: ['192.168.1.5'],
  warning: null,
  ...overrides
});

const stoppedStatus = (): ShareStatus => ({
  running: false, url: null, port: null, items: [], addresses: [], warning: null
});

const flush = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };

function fixture() {
  let push: (status: ShareStatus) => void = () => {};
  const adapter: ShareAdapter = {
    desktop: true,
    status: vi.fn(async () => stoppedStatus()),
    start: vi.fn(async () => runningStatus()),
    stop: vi.fn(async () => stoppedStatus()),
    addItems: vi.fn(async () => runningStatus({
      items: [
        { id: 1, kind: 'file', name: 'a.png', size: 1024, modified: null },
        { id: 2, kind: 'dir', name: 'photos', size: 0, modified: null }
      ]
    })),
    removeItem: vi.fn(async () => runningStatus({ items: [] })),
    pickFiles: vi.fn(async () => ['/tmp/a.png']),
    pickDirectory: vi.fn(async () => ['/tmp/photos']),
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
    expect(session.state.items).toHaveLength(1);
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
    expect(session.state.items).toHaveLength(2);
    expect(session.state.items[1].kind).toBe('dir');

    await session.remove(1);
    expect(adapter.removeItem).toHaveBeenCalledWith(1);
    expect(session.state.items).toHaveLength(0);
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

  it('starts sharing a folder through the directory picker', async () => {
    const { adapter } = fixture();
    const session = createShareSession(adapter);
    await session.pickAndShareFolder();
    expect(adapter.pickDirectory).toHaveBeenCalledOnce();
    expect(adapter.start).toHaveBeenCalledWith(['/tmp/photos']);
    expect(session.state.phase).toBe('running');
  });

  it('applies pushed status events', async () => {
    const { adapter, emit } = fixture();
    const session = createShareSession(adapter);
    await session.connect();
    emit(runningStatus({ items: [] }));
    await flush();
    expect(session.state.phase).toBe('running');
    expect(session.state.items).toHaveLength(0);
  });
});
