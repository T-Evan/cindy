import { describe, expect, it, vi } from 'vitest';
import { createDchatSetupHandlers, verifyDchatSetupReaders } from '../connectionSetup';
import { detectDchatLocalPaths } from '../localPaths';
import type { NativeBinding } from '../nativeRuntime';
import type { DchatSetupPath } from '../../../../shared/dchatConnection';
// Save/enable's real verification body previously queried an empty parent for a
// normal group, while handler-only mocks hid the bug. Unit: cached group with
// parentId='', plus official gate rejection/account change before the local read.
describe('native setup reader verification', () => {
  function readers(kind = 'channel', parentId = '') {
    let accountId = '101'; const order: string[] = [];
    const identity = {
      identity: vi.fn(async () => ({ accountId })),
      assertHistoryAccess: vi.fn(async (chatId: string) => { expect(chatId).toBe('303'); order.push('gate'); }),
      members: vi.fn(async (chatId: string) => {
        if (!chatId) throw new Error('DCHAT_INVALID_MEMBERSHIP_QUERY');
        return { accountId, chatId, memberIds: [accountId] };
      }),
    };
    const reader = {
      page: vi.fn(async () => { order.push('read'); return { accountId: '101', chatId: '303', kind, parentId, peerId: '', messages: [], cursor: null, hasMore: false, continuous: false }; }),
      dispose: vi.fn(),
    };
    return { identity, reader, order, account: (id: string) => { accountId = id; } };
  }
  it.each([['channel', '', '303', 'group'], ['subchannel', '202', '202', 'topic']])(
    'verifies %s membership using the correct conversation', async (kind, parentId, membershipId, chatKind) => {
      const f = readers(kind, parentId);
      const proof = await verifyDchatSetupReaders(f.identity, f.reader, '303');
      expect(proof).toMatchObject({ accountId: '101', chat: { id: '303', kind: chatKind } });
      expect(f.identity.members).toHaveBeenCalledWith(membershipId);
      expect(f.order).toEqual(['gate', 'read']);
      expect(f.reader.dispose).toHaveBeenCalledOnce();
    });
  it('does not read the local database when the official history gate refuses', async () => {
    const f = readers(); f.identity.assertHistoryAccess.mockRejectedValue(new Error('DCHAT_READ_UNAVAILABLE'));
    await expect(verifyDchatSetupReaders(f.identity, f.reader, '303')).rejects.toThrow('DCHAT_READ_UNAVAILABLE');
    expect(f.reader.page).not.toHaveBeenCalled();
    expect(f.identity.members).not.toHaveBeenCalled();
    expect(f.reader.dispose).toHaveBeenCalledOnce();
  });
  it('refuses an account changed during the official gate before local reads', async () => {
    const f = readers(); f.identity.assertHistoryAccess.mockImplementation(async () => { f.account('999'); });
    await expect(verifyDchatSetupReaders(f.identity, f.reader, '303')).rejects.toThrow('DCHAT_ACCOUNT_CHANGED');
    expect(f.reader.page).not.toHaveBeenCalled();
    expect(f.reader.dispose).toHaveBeenCalledOnce();
  });
});
/** Unit: setup public handlers must not promote renderer identity or enable on save.
 * Existing draft tests cannot exercise local verification/activation. Minimal failures:
 * renderer ownerId injection, identity changed between save/enable, scope changed during
 * native file dialog. Rules: Electron boundary §1, owner storage, IM confirmation.
 * Runtime recorded with the stage evidence. No native process/account/network used. */
function fixture() {
  let owner: string | null = 'owner:1'; let bindings: NativeBinding[] = [];
  let account = '101'; let connected = false;
  const deps = { scope: () => owner, platform: 'darwin', read: () => structuredClone(bindings),
    write: vi.fn(async (binding: NativeBinding, expected: string) => { if (owner !== expected) throw new Error('stale'); bindings = [structuredClone(binding)]; }),
    available: vi.fn(async () => true), choose: vi.fn(async () => '/synthetic/selected'),
    verify: vi.fn(async (_paths: unknown, chatId: string) => ({ accountId: account, chat: { id: chatId, kind: 'group' as const } })),
    detect: vi.fn(async (): Promise<Partial<Record<DchatSetupPath, string>>> => ({})),
    connected: () => connected, reload: vi.fn(async () => { connected = bindings[0]?.enabled === true; }) };
  const setup = createDchatSetupHandlers(deps);
  const select = async () => { for (const field of ['identityExecutable', 'sqlcipherExecutable', 'component', 'databaseRoot'] as const) await setup.pick('bot_a', field); };
  return { setup, deps, select, bindings: () => bindings, account: (id: string) => { account = id; }, owner: (id: string | null) => { owner = id; } };
}
describe('Main-owned D-Chat setup', () => {
  it('saves verified local identity disabled, then explicitly enables and revokes', async () => {
    const f = fixture(); await f.select();
    expect((await f.setup.save({ botId: 'bot_a', chatId: '303', execute: false })).status).toBe('saved');
    expect(f.bindings()[0]?.config).toMatchObject({ accountId: '101', ownerId: '101', executeChatIds: [], replyMode: 'draft', sendMode: 'attributed' });
    expect((await f.setup.enable('bot_a')).status).toBe('connected');
    expect(f.deps.verify).toHaveBeenCalledTimes(2);
    expect((await f.setup.disable('bot_a')).enabled).toBe(false);
  });
  it('refuses renderer identity claims and account replacement before enabling', async () => {
    const f = fixture(); await f.select();
    expect(() => f.setup.save({ botId: 'bot_a', chatId: '303', execute: true, ownerId: 'attacker' } as never)).toThrow('DCHAT_INVALID_SETUP');
    await f.setup.save({ botId: 'bot_a', chatId: '303', execute: true });
    f.account('202'); await expect(f.setup.enable('bot_a')).rejects.toThrow('DCHAT_ACCOUNT_CHANGED');
    expect(f.bindings()[0]?.enabled).toBe(false);
  });
  it('rejects a stale native dialog and an unavailable original teammate', async () => {
    const f = fixture(); f.deps.choose.mockImplementation(async () => { f.owner('other:2'); return '/synthetic/stale'; });
    await expect(f.setup.pick('bot_a', 'component')).rejects.toThrow('DCHAT_ACCOUNT_CHANGED');
    expect((await f.setup.get('bot_a')).selected).toEqual([]);
    f.deps.available.mockResolvedValue(false);
    await expect(f.setup.save({ botId: 'bot_a', chatId: '303', execute: false })).rejects.toThrow();
    expect(f.deps.write).not.toHaveBeenCalled();
  });
  it('shows a saved but unavailable connection without claiming it is enabled', async () => {
    const f = fixture(); await f.select(); await f.setup.save({ botId: 'bot_a', chatId: '303', execute: false });
    f.deps.reload.mockResolvedValue(undefined);
    expect((await f.setup.enable('bot_a')).status).toBe('offline');
  });
});

// Unit: choosing a command chat is explicit and cannot submit a remote owner ID.
it('stores control pairing only after Main local-account verification and remains disabled', async () => {
  const f = fixture(); await f.select();
  const view = await f.setup.save({ botId: 'bot_a', chatId: '303', execute: true, control: true });
  expect(f.bindings()[0]?.config).toMatchObject({ ownerId: '101', accountId: '101', controlChatId: '303' });
  expect(view).toMatchObject({ control: true, enabled: false, status: 'saved' });
});

// Unit regression: finding installed paths must not require four native dialogs,
// query an account, activate a connection, or leak a late result across owners.
describe('D-Chat setup automatic local paths', () => {
  const paths = { identityExecutable: '/synthetic/dws-unix.sh', sqlcipherExecutable: '/synthetic/sqlcipher',
    component: '/synthetic/D-Chat', databaseRoot: '/synthetic/CefChat' };
  it('discovers the installed wrapper and resolved Homebrew file, leaving absent tools unselected', async () => {
    const found = await detectDchatLocalPaths({ home: '/synthetic/home', skillRoots: ['/synthetic/skills'] },
      async (candidate, directory) => {
        if (candidate === '/synthetic/skills/xdt-agents/smartwork-cli/smartwork-shared/assets/dws-unix.sh') return '/synthetic/real/dws-unix.sh';
        if (candidate === '/opt/homebrew/bin/sqlcipher') return '/synthetic/Cellar/sqlcipher';
        if (directory && candidate.endsWith('/CefChat')) return candidate;
        return null;
      });
    expect(found).toEqual({ identityExecutable: '/synthetic/real/dws-unix.sh', sqlcipherExecutable: '/synthetic/Cellar/sqlcipher',
      databaseRoot: '/synthetic/home/Library/Application Support/com.dichat.desktop/D-Chat/CefChat' });
  });
  it('makes fresh setup saveable without four dialogs and keeps detection read-only', async () => {
    const f = fixture(); f.deps.detect.mockResolvedValue(paths);
    const view = await f.setup.get('bot_a');
    expect(view.selected).toHaveLength(4);
    expect(view).toMatchObject({ accountId: null, enabled: false, status: 'unconfigured' });
    expect(f.deps.verify).not.toHaveBeenCalled();
    expect(f.deps.write).not.toHaveBeenCalled();
    await f.setup.save({ botId: 'bot_a', chatId: '303', execute: false });
    expect(f.bindings()[0]).toMatchObject({ ...paths, enabled: false });
  });
  it('preserves manual selections and leaves missing tools available for manual selection', async () => {
    const f = fixture(); f.deps.detect.mockResolvedValue({ component: paths.component });
    await f.setup.pick('bot_a', 'component');
    expect((await f.setup.get('bot_a')).selected).toEqual(['component']);
    f.deps.detect.mockResolvedValue(paths); await f.setup.get('bot_a');
    await f.setup.save({ botId: 'bot_a', chatId: '303', execute: false });
    expect(f.bindings()[0]?.component).toBe('/synthetic/selected');
  });
  it('rejects detection finishing after an account switch without leaking its selection', async () => {
    const f = fixture(); f.deps.detect.mockImplementation(async () => { f.owner('other:2'); return paths; });
    await expect(f.setup.get('bot_a')).rejects.toThrow('DCHAT_ACCOUNT_CHANGED');
    f.deps.detect.mockResolvedValue({});
    expect((await f.setup.get('bot_a')).selected).toEqual([]);
    expect(f.deps.write).not.toHaveBeenCalled();
  });
});
