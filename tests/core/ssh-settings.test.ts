import { describe, expect, it, vi } from 'vitest';
import { createSshSession } from '../../src/core/ssh/session';
import { sshCommand, sshErrorMessages } from '../../src/core/ssh/messages';
import {
  defaultSshRuntime,
  defaultSshSettings,
  type SshAdapter,
  type SshErrorCode,
  type SshOutcome,
  type SshRuntime
} from '../../src/core/ssh/types';

const runtime = (overrides: Partial<SshRuntime> = {}): SshRuntime => ({
  ...defaultSshRuntime(),
  supported: true,
  platform: 'macos',
  admin: true,
  username: 'qingshan',
  address: '192.168.1.20',
  helperInstalled: true,
  helperApproved: true,
  ...overrides
});

const outcome = (
  next: SshRuntime,
  error: SshErrorCode | null = null,
  ssh = defaultSshSettings()
): SshOutcome => ({ runtime: { ...next, error }, ssh, error });

function fixture(initial: SshOutcome) {
  let pushStatus: (value: SshRuntime) => void = () => {};
  const adapter: SshAdapter = {
    status: vi.fn(async () => ({ runtime: initial.runtime, ssh: initial.ssh })),
    enable: vi.fn(async () => initial),
    disable: vi.fn(async () => initial),
    setLifetime: vi.fn(async () => initial),
    setPort: vi.fn(async () => initial),
    installHelper: vi.fn(async () => initial),
    installBundledOpenSsh: vi.fn(async () => initial),
    openOpenSshDownload: vi.fn(async () => {}),
    openSharingSettings: vi.fn(async () => {}),
    uninstallHelper: vi.fn(async () => initial),
    onStatus: vi.fn(async handler => {
      pushStatus = handler;
      return () => {};
    })
  };
  return { adapter, session: createSshSession(adapter), pushStatus: (value: SshRuntime) => pushStatus(value) };
}

describe('ssh session', () => {
  it('shows which action is running and how long it has waited', async () => {
    const initial = outcome(runtime(), null);
    let release: (value: SshOutcome) => void = () => {};
    const { adapter, session } = fixture(initial);
    adapter.installHelper = vi.fn(
      () => new Promise<SshOutcome>(resolve => { release = resolve; })
    );
    vi.useFakeTimers();
    try {
      const pending = session.installHelper();
      expect(session.state.busy).toBe(true);
      expect(session.state.action).toBe('install');
      await vi.advanceTimersByTimeAsync(3000);
      expect(session.state.elapsed).toBe(3);
      release(initial);
      await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(session.state.busy).toBe(false);
    expect(session.state.action).toBeNull();
  });

  it('keeps the backend error detail so the panel can name the failing step', async () => {
    const failed = outcome(
      runtime({ errorDetail: '启动 sshd 失败（错误 5），sshd_config 已回滚' }),
      'service_start_failed'
    );
    const { session } = fixture(failed);
    await session.load();
    expect(session.state.error).toBe('service_start_failed');
    expect(session.state.runtime.errorDetail).toBe('启动 sshd 失败（错误 5），sshd_config 已回滚');
  });

  it('loads the runtime and surfaces the helper error', async () => {
    const helperMissing = outcome(runtime({ helperInstalled: false }), 'helper_unavailable');
    const { session } = fixture(helperMissing);
    const loaded = await session.load();
    expect(loaded.helperInstalled).toBe(false);
    expect(session.state.error).toBe('helper_unavailable');
    expect(session.state.loaded).toBe(true);
  });

  it('keeps a failed enable out of the persisted settings', async () => {
    const failed = outcome(runtime(), 'helper_unavailable', { enabled: false, lifetime: 'app', port: 22 });
    const { session } = fixture(failed);
    await session.enable('app', 22);
    expect(session.state.error).toBe('helper_unavailable');
    expect(session.state.settings.enabled).toBe(false);
    expect(session.state.busy).toBe(false);
  });

  it('adopts the persisted settings returned by a successful enable', async () => {
    const enabled = outcome(
      runtime({ osEnabled: true, owned: true, listening: true }),
      null,
      { enabled: true, lifetime: 'persistent', port: 22 }
    );
    const { session } = fixture(enabled);
    await session.enable('persistent', 22);
    expect(session.state.error).toBeNull();
    expect(session.state.settings).toEqual({ enabled: true, lifetime: 'persistent', port: 22 });
    expect(session.state.runtime.owned).toBe(true);
  });

  it('records adapter validation errors without inventing a runtime change', async () => {
    const { adapter, session } = fixture(outcome(runtime()));
    adapter.setPort = vi.fn(async () => {
      throw 'SSH 端口需要在 1 到 65535 之间';
    });
    await session.setPort(0);
    expect(session.state.error).toBe('internal');
    expect(session.state.detail).toBe('SSH 端口需要在 1 到 65535 之间');
    expect(session.state.settings.port).toBe(22);
  });

  it('follows ssh-status events from the main window', async () => {
    const { session, pushStatus } = fixture(outcome(runtime()));
    await session.subscribe();
    pushStatus(runtime({ osEnabled: true, owned: false, error: 'needs_admin' }));
    expect(session.state.runtime.osEnabled).toBe(true);
    expect(session.state.error).toBe('needs_admin');
  });

  it('seeds the persisted preference from the status snapshot', async () => {
    const persisted = outcome(runtime(), null, { enabled: true, lifetime: 'persistent', port: 22 });
    const { session } = fixture(persisted);
    await session.load();
    expect(session.state.settings).toEqual({ enabled: true, lifetime: 'persistent', port: 22 });
  });

  it('marks the session loaded even when the status probe throws', async () => {
    const { adapter, session } = fixture(outcome(runtime()));
    adapter.status = vi.fn(async () => {
      throw 'boom';
    });
    await session.load();
    expect(session.state.error).toBe('internal');
    expect(session.state.loaded).toBe(true);
  });
});

describe('ssh read-only route', () => {
  it('keeps the app from writing when the backend is read-only', async () => {
    const readOnly = outcome(
      runtime({ readOnly: true, osState: 'unknown', backendAvailable: true }),
      'read_only',
      { enabled: false, lifetime: 'app', port: 22 }
    );
    const { session } = fixture(readOnly);
    await session.load();
    expect(session.state.runtime.readOnly).toBe(true);
    expect(session.state.runtime.osState).toBe('unknown');
    expect(session.state.error).toBe('read_only');
    expect(session.state.settings.enabled).toBe(false);
  });

  it('opens the system sharing panel through the adapter', async () => {
    const { adapter, session } = fixture(outcome(runtime({ readOnly: true })));
    await session.openSharingSettings();
    expect(adapter.openSharingSettings).toHaveBeenCalled();
  });
});

describe('ssh bundled OpenSSH fallback', () => {
  it('runs the bundled install through the adapter', async () => {
    const { adapter, session } = fixture(outcome(runtime({ platform: 'windows' })));
    await session.installBundledOpenSsh();
    expect(adapter.installBundledOpenSsh).toHaveBeenCalled();
  });

  it('reports the fixed download entry without inventing a URL', async () => {
    const { adapter, session } = fixture(outcome(runtime({ platform: 'windows' })));
    await session.openOpenSshDownload();
    expect(adapter.openOpenSshDownload).toHaveBeenCalled();
  });
});

describe('ssh connection copy', () => {
  it('builds ssh user@host for port 22', () => {
    expect(sshCommand(runtime())).toBe('ssh qingshan@192.168.1.20');
  });

  it('adds -p for custom ports and falls back when the address is unknown', () => {
    expect(sshCommand(runtime({ port: 2222 }))).toBe('ssh -p 2222 qingshan@192.168.1.20');
    expect(sshCommand(runtime({ address: null, port: 22 }))).toBe('ssh qingshan@127.0.0.1');
  });
});

describe('ssh error copy', () => {
  it('covers every error code the helper can return', () => {
    const codes: SshErrorCode[] = [
      'unsupported_os',
      'unsupported_custom_port',
      'needs_admin',
      'helper_unavailable',
      'helper_version_mismatch',
      'feature_missing',
      'service_missing',
      'service_start_failed',
      'service_stop_failed',
      'firewall_blocked',
      'policy_blocked',
      'port_in_use',
      'busy',
      'read_only',
      'internal',
      'unsupported_verb',
      'frame_too_large',
      'timeout'
    ];
    for (const code of codes) {
      expect(sshErrorMessages[code], code).toBeTruthy();
    }
  });
});
