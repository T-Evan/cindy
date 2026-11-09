import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDchatManualRecovery } from '../manualRecovery';
import { DchatRecoveryClaims, dchatRecoveryConnectionIds } from '../recoveryClaim';
import { claimAppExitInputRecovery, appExitInputRecoveryPolicy, onAppExitInputRecovery } from '../../../maker-ipc/appExitInputRecovery';
import { AgentInputCoordinator } from '../../../maker-ipc/agent-input-coordinator';
import { createInputEnqueueHarness } from '../../../maker-ipc/__tests__/inputEnqueueHarness';
import type { AgentInputQueuedMessage } from '../../../../shared/agentInputQueue';
import { CONTINUE_AFTER_APP_EXIT_PROMPT } from '../../../../shared/interruptedTurn';
import { DchatIM, type IMHost } from '@cindy/im';
import type { AgentEvent } from '@cindy/maker-core';
import { createDchatExecutionObserver, createDchatRecoveryListener } from '../executionObserver';

/** Unit tier: native input -> exact Session event -> durable terminal -> restart
 * notification. IM flow requires no input replay and no private history export.
 * Existing ledger tests never attach a native execution observer. Minimal failures:
 * stale generation done, crash after native done but before outbound, unknown send.
 * Uses only synthetic data and injected Session/native transport. */
const host: IMHost = { secrets: { write: () => true, read: () => null, remove() {}, isAvailable: () => true },
  ipc: { throwIpcError: () => { throw new Error('invalid'); }, handle() {}, broadcast() {} },
  paths: { feishuMediaDir: 'unused' }, httpPostForm: async () => ({ status: 500, body: null }) };
function fixture() {
  let stored: unknown = null, accountId = '100', current = true, failSend = false;
  let generation = 1, execute = true, authorizationKey = 'lease-one';
  const listeners = new Set<(event: AgentEvent) => void>();
  const sends: Array<{ chatId: string; text: string }> = [];
  const session = { id: 'lane-session', instanceId: 'native-instance', getTurnGeneration: () => generation,
    onEvent: (callback: (event: AgentEvent) => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; } };
  function make() {
    const im = new DchatIM(host, { config: { accountId: '100', ownerId: '100', botId: 'original-bot', connectionId: 'connection',
      chats: [{ id: '300', kind: 'group' }], executeChatIds: execute ? ['300'] : [], replyMode: 'automatic' },
      storage: { read: () => structuredClone(stored), write: value => { stored = structuredClone(value); } },
      authorizationKey, current: () => current, bindingAvailable: async () => current, draft: async () => {},
      native: { identity: async () => ({ accountId }), capabilities: async () => ['content'], send: async value => {
        sends.push(value); if (failSend) throw new Error('synthetic unknown'); return { messageId: 'resource:synthetic' };
      } }, executionBound: receipt => observer.observe(receipt) });
    const observer = createDchatExecutionObserver({ im, current: () => current, session: () => session,
      onSession: () => () => {}, onError: vi.fn() });
    im.onMessage(event => im.acknowledgeIncoming(event.messageId, session.id, 'input-client', { instanceId: session.instanceId, turnGeneration: generation }));
    return { im, observer, stop: async () => { observer.stop(); await im.dispose(); } };
  }
  const emit = (extra: Partial<AgentEvent> = {}) => {
    const event = { type: 'done', data: {}, sessionInstanceId: session.instanceId, sessionTurnGeneration: generation, ...extra } as AgentEvent;
    for (const callback of [...listeners]) callback(event);
  };
  return { make, emit, sends, stored: () => stored, listeners,
    incoming: { messageId: 'native-input', accountId: '100', chatId: '300', senderId: '200', senderName: 'Synthetic guest', text: 'invoke', sentBySelf: false, invoked: true },
    account: (value: string) => { accountId = value; }, revoke: () => { current = false; },
    instance: (value: string) => { session.instanceId = value; }, generation: (value: number) => { generation = value; }, execute: (value: boolean) => { execute = value; }, renew: () => { authorizationKey = 'lease-two'; }, failSend: () => { failSend = true; } };
}
describe('D-Chat native execution observation', () => {
  it('restores a durably observed terminal to its original chat once after restart without replaying input', async () => {
    const f = fixture(); const first = f.make(); await first.im.init(); await first.im.receive(f.incoming); f.emit();
    expect(f.sends).toEqual([]); await first.stop(); expect(f.listeners.size).toBe(0);
    const restarted = f.make(); await restarted.im.init(); await restarted.observer.restore();
    expect(f.sends).toMatchObject([{ chatId: '300', text: expect.stringContaining('Cindy') }]);
    expect(await restarted.im.receive(f.incoming)).toBe('duplicate'); await restarted.stop();
    const twice = f.make(); await twice.im.init(); await twice.observer.restore(); expect(f.sends).toHaveLength(1); await twice.stop();
  });
  it('does not let private, background or later-generation events settle the earlier input', async () => {
    const f = fixture(); const first = f.make(); await first.im.init(); await first.im.receive(f.incoming);
    f.emit({ data: { silentStop: true } }); f.emit({ turnContinuationId: 1 });
    f.emit({ agentMeta: { botPrivateReply: true } }); f.emit({ turnScope: 'background' });
    f.emit({ agentMeta: { parentUuid: 'child-tool' } }); f.emit({ agentMeta: { replyToClientId: 'later-input' } }); f.emit({ sessionTurnGeneration: 2 });
    await first.stop(); const restarted = f.make(); await restarted.im.init(); await restarted.observer.restore();
    expect(f.sends).toEqual([]); expect(await restarted.im.receive(f.incoming)).toBe('duplicate');
    f.emit(); await vi.waitFor(() => expect(f.sends).toHaveLength(1), { interval: 1 }); await restarted.stop();
  });
  it.each([['failed', '未完成'], ['cancelled', '已停止'], ['interrupted', '已停止']])('preserves native %s terminal classification after restart', async (status, expected) => {
    const f = fixture(); const first = f.make(); await first.im.init(); await first.im.receive(f.incoming); f.emit({ data: { status } }); await first.stop();
    const restarted = f.make(); await restarted.im.init(); await restarted.observer.restore();
    expect(f.sends).toMatchObject([{ chatId: '300', text: expect.stringContaining(expected) }]); await restarted.stop();
  });
  it('never repeats a notification whose native send result is unknown', async () => {
    const f = fixture(); const first = f.make(); await first.im.init(); await first.im.receive(f.incoming); f.emit(); await first.stop();
    f.failSend(); const restarted = f.make(); await restarted.im.init(); await expect(restarted.observer.restore()).rejects.toThrow('DCHAT_SEND_OUTCOME_UNKNOWN'); await restarted.stop();
    const twice = f.make(); await twice.im.init(); await twice.observer.restore(); expect(f.sends).toHaveLength(1); await twice.stop();
  });
  it('does not send an old completion after disable/re-enable replaces its persisted authorization lease', async () => {
    const f = fixture(); const first = f.make(); await first.im.init(); await first.im.receive(f.incoming); f.emit(); await first.stop();
    f.renew(); const restarted = f.make(); await restarted.im.init(); await restarted.observer.restore();
    expect(f.sends).toEqual([]); expect(await restarted.im.receive(f.incoming)).toBe('duplicate'); await restarted.stop();
  });
  it('does not recover a terminal notification after chat execution is revoked', async () => {
    const f = fixture(); const first = f.make(); await first.im.init(); await first.im.receive(f.incoming); f.emit(); await first.stop();
    f.execute(false); const restarted = f.make(); await restarted.im.init(); await restarted.observer.restore();
    expect(f.sends).toEqual([]); await restarted.stop();
  });
  it('keeps an earlier input unknown when its Session instance has been replaced', async () => {
    const f = fixture(); const first = f.make(); await first.im.init(); await first.im.receive(f.incoming); await first.stop();
    f.generation(2); const restarted = f.make(); await restarted.im.init(); await restarted.observer.restore(); f.emit();
    expect(f.sends).toEqual([]); expect(f.listeners.size).toBe(0); await restarted.stop();
  });
  it('does not notify after account replacement or revocation', async () => {
    const f = fixture(); const first = f.make(); await first.im.init(); await first.im.receive(f.incoming); f.emit(); await first.stop();
    const restarted = f.make(); await restarted.im.init(); f.account('999'); await expect(restarted.observer.restore()).rejects.toThrow('DCHAT_BINDING_UNAVAILABLE');
    f.account('100'); f.revoke(); await restarted.observer.restore(); expect(f.sends).toEqual([]); await restarted.stop();
  });
});

// Unit regression: a native recovery intent must bind a replacement instance only
// to its exact original clientId, and never notify before accepted vendor dispatch.
it('adopts an exact native recovery across instances and confirms synchronous terminal only after dispatch', async () => {
  const f = fixture(); const first = f.make(); await first.im.init(); await first.im.receive(f.incoming); await first.stop();
  f.instance('replacement'); f.generation(3);
  const next = f.make(); await next.im.init(); await next.observer.restore();
  expect(next.im.executionInputs()[0]?.recovery?.status).toBe('interrupted');
  const execution = { sessionId: 'lane-session', clientId: 'continued-client', instanceId: 'replacement', turnGeneration: 3 };
  await expect(next.observer.takeover('unrelated', execution)).rejects.toThrow('DCHAT_RECOVERY_UNVERIFIED');
  await next.observer.takeover('input-client', execution);
  f.emit({ sessionInstanceId: 'native-instance', sessionTurnGeneration: 1 });
  expect(next.im.executionInputs()[0]?.nativeTerminal).toBeUndefined();
  f.emit({ agentMeta: { replyToClientId: 'continued-client' } });
  expect(f.sends).toEqual([]);
  await next.im.confirmRecovery(execution);
  expect(f.sends).toHaveLength(1); await next.stop();
  const again = f.make(); await again.im.init(); await again.observer.restore(); expect(f.sends).toHaveLength(1); await again.stop();
});

// Unit: the production host bridge, not a body or Session-id match, must reserve
// and confirm exact recovery. Concurrent cancellation and account replacement
// must keep the original receipt interrupted, without outbound or input replay.
it.each(['cancel', 'account', 'next-input'] as const)('blocks recovered notifications after %s', async action => {
  const f = fixture(); const first = f.make(); await first.im.init(); await first.im.receive(f.incoming); await first.stop();
  f.instance('new-instance'); f.generation(4);
  const next = f.make(); await next.im.init(); await next.observer.restore();
  const bridge = createDchatRecoveryListener({ im: next.im, observer: next.observer, current: () => true });
  const execution = { sessionId: 'lane-session', clientId: 'continued', instanceId: 'new-instance', turnGeneration: 4 };
  bridge.intent(execution.sessionId, 'input-client', execution.clientId); await bridge.reserve(execution);
  if (action === 'account') f.account('999');
  else bridge.cancel(execution.sessionId);
  f.emit({ agentMeta: { replyToClientId: action === 'next-input' ? 'later-input' : execution.clientId } });
  if (action === 'account') await expect(bridge.confirm(execution)).rejects.toThrow();
  else await bridge.confirm(execution);
  expect(f.sends).toEqual([]); await next.stop();
});
it('restores an unconfirmed recovery reservation as interrupted and never guesses its synchronous terminal accepted', async () => {
  const f = fixture(); const first = f.make(); await first.im.init(); await first.im.receive(f.incoming); await first.stop();
  f.instance('replacement'); f.generation(3);
  const next = f.make(); await next.im.init(); await next.observer.restore();
  await next.observer.takeover('input-client', { sessionId: 'lane-session', clientId: 'continued', instanceId: 'replacement', turnGeneration: 3 });
  f.emit(); await next.stop();
  f.instance('after-crash'); f.generation(1);
  const restored = f.make(); await restored.im.init(); await restored.observer.restore();
  expect(restored.im.executionInputs()[0]).toMatchObject({ recovery: { status: 'interrupted' } });
  expect(restored.im.executionInputs()[0]?.nativeTerminal).toBeUndefined();
  expect(f.sends).toEqual([]); await restored.stop();
});

// Unit: the actual silent-stop host action proves old instance/generation before
// selecting the new client. A same-Session-id later generation proves nothing.
it('adopts only the exact native generation selected by the host continuation action', async () => {
  const f = fixture(); const first = f.make(); await first.im.init(); await first.im.receive(f.incoming);
  f.emit({ data: { silentStop: true } });
  const bridge = createDchatRecoveryListener({ im: first.im, observer: first.observer, current: () => true });
  bridge.continuation!({ sessionId: 'lane-session', instanceId: 'wrong', turnGeneration: 1 }, 'unrelated');
  f.generation(2);
  await bridge.reserve({ sessionId: 'lane-session', clientId: 'unrelated', instanceId: 'native-instance', turnGeneration: 2 });
  expect(first.im.executionInputs()[0]?.execution?.clientId).toBe('input-client');
  bridge.continuation!({ sessionId: 'lane-session', instanceId: 'native-instance', turnGeneration: 1 }, 'host-continuation');
  const execution = { sessionId: 'lane-session', clientId: 'host-continuation', instanceId: 'native-instance', turnGeneration: 2 };
  await bridge.reserve(execution); f.emit({ agentMeta: { replyToClientId: 'host-continuation' } });
  expect(f.sends).toEqual([]); await bridge.confirm(execution);
  expect(f.sends).toHaveLength(1); await first.stop();
});

/** Integration tier: production Continue gate, facade/observer and private claim files.
 * Previously takeover tests injected identities; they could not reject a second
 * Continue or a restored queued continuation. No real account/provider is used. */
describe('ordinary IM manual app-exit recovery entry', () => {
  async function setup() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-dchat-manual-'));
    const f = fixture(), first = f.make(); await first.im.init(); await first.im.receive(f.incoming); await first.stop();
    f.instance('restored-instance'); f.generation(2);
    const runtime = f.make(); await runtime.im.init(); await runtime.observer.restore();
    const store = new DchatRecoveryClaims(path.join(directory, 'claims'), () => true);
    let busy = false;
    const deps = { owner: () => 'synthetic-owner', sources: (sid: string) => runtime.im.executionInputs().filter(r => r.execution?.sessionId === sid),
      store: () => store, claimed: (id: string) => store.forClient(id),
      verify: async (row: ReturnType<typeof runtime.im.executionInputs>[number]) => { await runtime.im.verifyRecoverySource(row.requestKey, row.execution!.clientId); },
      supersede: (row: ReturnType<typeof runtime.im.executionInputs>[number]) => runtime.im.supersedeRecovery(row.requestKey), runtime: () => runtime, busy: () => busy,
      policy: (row: ReturnType<typeof runtime.im.executionInputs>[number]) => ({ context: { origin: { kind: 'im' as const, channel: 'dchat' as const, taskId: row.requestKey } } }),
      beginScope: () => () => {},
    };
    const manual = createDchatManualRecovery(deps), release = onAppExitInputRecovery(manual.host);
    return { f, runtime, store, manual, deps, busy: () => { busy = true; },
      finish: async () => { release(); await runtime.stop(); fs.rmSync(directory, { recursive: true, force: true }); } };
  }
  it('claims the durable original through Continue and observes before confirming provider dispatch', async () => {
    const t = await setup();
    try {
      expect(await claimAppExitInputRecovery('lane-session', 'manual-client', CONTINUE_AFTER_APP_EXIT_PROMPT)).toBe(true);
      expect(appExitInputRecoveryPolicy('lane-session', 'manual-client')?.context.origin).toMatchObject({ channel: 'dchat' });
      const identity = { sessionId: 'lane-session', clientId: 'manual-client', instanceId: 'restored-instance', turnGeneration: 2 };
      await t.manual.listener.reserve(identity); t.f.emit(); expect(t.f.sends).toEqual([]);
      await t.manual.listener.confirm(identity); expect(t.f.sends).toHaveLength(1); expect(t.f.sends[0]!.chatId).toBe('300');
      expect(t.store.forClient('manual-client')).toMatchObject({ state: 'confirmed', source: { execution: { clientId: 'input-client', instanceId: 'native-instance', turnGeneration: 1 } } });
      t.f.generation(3); t.f.emit(); await t.runtime.im.recoverTerminalNotifications(); expect(t.f.sends).toHaveLength(1);
    } finally { await t.finish(); }
  });
  it('rejects concurrent consumption, restored queued claims and later input after reservation', async () => {
    const t = await setup();
    try {
      const claims = await Promise.allSettled(['one', 'two'].map(id => claimAppExitInputRecovery('lane-session', id, CONTINUE_AFTER_APP_EXIT_PROMPT)));
      expect(claims.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const id = t.store.forClient('one') ? 'one' : 'two';
      const restarted = createDchatManualRecovery(t.deps);
      expect(() => restarted.host.policy('lane-session', id)).toThrow('DCHAT_RECOVERY_INTERRUPTED');
      const identity = { sessionId: 'lane-session', clientId: id, instanceId: 'restored-instance', turnGeneration: 2 };
      await t.manual.listener.reserve(identity); t.manual.listener.cancel('lane-session');
      t.f.emit(); await expect(t.manual.listener.confirm(identity)).rejects.toThrow('DCHAT_RECOVERY_INTERRUPTED');
      expect(t.f.sends).toEqual([]); expect(t.store.forClient(id)?.state).toBe('cancelled');
    } finally { await t.finish(); }
  });
  it('stops all manual recovery scopes even when a revoked transport cannot persist cancellation', async () => {
    const t = await setup();
    try {
      await claimAppExitInputRecovery('lane-session', 'cleanup-client', CONTINUE_AFTER_APP_EXIT_PROMPT);
      await t.manual.listener.reserve({ sessionId: 'lane-session', clientId: 'cleanup-client', instanceId: 'restored-instance', turnGeneration: 2 });
      t.deps.runtime = () => { throw new Error('DCHAT_RECOVERY_REVOKED'); };
      expect(() => t.manual.stop()).not.toThrow();
      expect(t.store.forClient('cleanup-client')?.state).toBe('cancelled');
      const restarted = createDchatManualRecovery(t.deps);
      expect(() => restarted.host.policy('lane-session', 'cleanup-client')).toThrow('DCHAT_RECOVERY_INTERRUPTED');
    } finally { await t.finish(); }
  });
  it.each(['account', 'busy', 'settled', 'output', 'ambiguous'] as const)('rejects %s without dispatch or new claim', async kind => {
    const t = await setup();
    try {
      if (kind === 'account') t.f.account('999');
      if (kind === 'busy') t.busy();
      const originalSources = t.deps.sources;
      if (kind === 'settled' || kind === 'output' || kind === 'ambiguous') t.deps.sources = sid => {
        const rows = originalSources(sid);
        if (kind === 'settled') rows[0]!.nativeTerminal = 'done';
        if (kind === 'output') rows[0]!.outputs['a'.repeat(64)] = { state: 'unknown' };
        return kind === 'ambiguous' ? [...rows, { ...rows[0]!, requestKey: 'another-source' }] : rows;
      };
      await expect(claimAppExitInputRecovery('lane-session', 'rejected', CONTINUE_AFTER_APP_EXIT_PROMPT)).rejects.toThrow(/DCHAT_/);
      expect(t.store.forClient('rejected')).toBeNull(); expect(t.f.sends).toEqual([]);
    } finally { await t.finish(); }
  });
});

// Production INPUT_ENQUEUE handler + real coordinator + native observer/facade.
// Only provider/native transport and database host services are synthetic.
it('runs the app-exit IPC through coordinator reservation/dispatch and keeps the next input separate', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-dchat-ipc-'));
  const f = fixture(), first = f.make(); await first.im.init(); await first.im.receive(f.incoming); await first.stop();
  f.instance('restored-instance'); f.generation(2);
  const runtime = f.make(); await runtime.im.init(); await runtime.observer.restore();
  const store = new DchatRecoveryClaims(path.join(directory, 'claims'), () => true);
  const manual = createDchatManualRecovery({ owner: () => 'owner',
    sources: sid => runtime.im.executionInputs().filter(r => r.execution?.sessionId === sid), store: () => store, claimed: id => store.forClient(id),
    verify: row => runtime.im.verifyRecoverySource(row.requestKey, row.execution!.clientId), supersede: row => runtime.im.supersedeRecovery(row.requestKey), runtime: () => runtime, busy: () => false,
    policy: row => ({ context: { origin: { kind: 'im', channel: 'dchat', taskId: row.requestKey } } }), beginScope: () => () => {},
  });
  const release = onAppExitInputRecovery(manual.host);
  let running = false; const provider: string[] = [];
  const identity = (id: string) => ({ sessionId: 'lane-session', clientId: id, instanceId: 'restored-instance', turnGeneration: 2 });
  const coordinator = new AgentInputCoordinator({
    sendToAgent: async (sid, message, _create, opts) => {
      appExitInputRecoveryPolicy(sid, opts.persistUserMessage?.clientId ?? '');
      opts.onVendorTurnReserved?.(2); await opts.persistUserMessage?.onPersisted?.();
      provider.push(typeof message === 'string' ? message : String(message.content)); running = true; return { kind: 'session-dispatch', source: 'synthetic-provider', dispatched: true };
    },
    beforeDispatchUserTurn: (_sid, item) => manual.listener.reserve(identity(item.clientId)),
    onDispatchedUserTurn: (_sid, item) => manual.listener.confirm(identity(item.clientId)),
    onUndispatchedUserTurn: (sid, item) => manual.listener.cancel(sid, item.clientId),
    onUserEnqueue: sid => manual.listener.cancel(sid),
    steerToAgent: async () => {}, abortSession: async () => { running = false; }, isTurnRunning: () => running,
    hasPendingInteraction: () => false, getAgentKind: () => 'claude-code', getSdkSessionId: async () => 'synthetic-sdk', emitProjection: () => {},
  });
  const queued = (clientId: string, text: string): AgentInputQueuedMessage => ({ clientId, text, persistedContent: text,
    model: 'synthetic-model', effort: 'medium', permissionMode: 'default', workingDir: directory,
    chatMessage: { clientId, role: 'user', content: text, isStreaming: false, createdAt: '2026-11-10T00:00:00.000Z' },
    createOpts: { agentKind: 'claude-code', workingDir: directory, model: 'synthetic-model', effort: 'medium', permissionMode: 'default', userPrompt: '', makerMemoryEnabled: true, displayReasoning: 'summarized' },
  });
  try {
    const ipc = createInputEnqueueHarness(coordinator, { remote: false });
    await ipc.enqueue({}, 'lane-session', queued('ipc-continue', CONTINUE_AFTER_APP_EXIT_PROMPT));
    await vi.waitFor(() => expect(store.forClient('ipc-continue')?.state).toBe('confirmed'), { interval: 1 });
    expect(provider).toEqual([CONTINUE_AFTER_APP_EXIT_PROMPT]);
    f.emit(); await vi.waitFor(() => expect(f.sends).toHaveLength(1), { interval: 1 });
    running = false; coordinator.onTurnEvent('lane-session', 'done');
    f.generation(3);
    await ipc.enqueue({}, 'lane-session', queued('next-input', 'Independent next input'));
    await vi.waitFor(() => expect(provider).toHaveLength(2), { interval: 1 });
    f.emit(); await runtime.im.recoverTerminalNotifications(); expect(f.sends).toHaveLength(1);
  } finally { release(); manual.stop(); await coordinator.stop('lane-session'); await runtime.stop(); fs.rmSync(directory, { recursive: true, force: true }); }
});

// Integration tier: removing a connection setting must not erase its durable
// continuation fence. Previous coverage only kept the connection in settings.
it('discovers a consumed continuation after its connection configuration was replaced', async () => {
  const t = await (async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-dchat-retained-'));
    const f = fixture(), first = f.make(); await first.im.init(); await first.im.receive(f.incoming); await first.stop();
    return { directory, f };
  })();
  try {
    const connection = path.join(t.directory, 'retired-connection'); fs.mkdirSync(connection, { mode: 0o700 });
    const store = new DchatRecoveryClaims(path.join(connection, 'manual-claims'), () => true);
    const runtime = t.f.make(); await runtime.im.init(); await runtime.observer.restore();
    const row = runtime.im.executionInputs()[0]!; store.claim(row, 'old-queued-continue', 'owner');
    const ids = dchatRecoveryConnectionIds(t.directory, () => true);
    expect(ids).toEqual(['retired-connection']);
    const manual = createDchatManualRecovery({ owner: () => 'owner', sources: () => [],
      store: () => store, claimed: id => ids.map(connectionId => new DchatRecoveryClaims(path.join(t.directory, connectionId, 'manual-claims'), () => true).forClient(id)).find(Boolean) ?? null,
      verify: async () => { throw new Error('DCHAT_RECOVERY_REVOKED'); }, supersede: () => {}, runtime: () => runtime,
      busy: () => false, policy: () => { throw new Error('unreachable'); }, beginScope: () => () => {},
    });
    expect(() => manual.host.policy('lane-session', 'old-queued-continue')).toThrow('DCHAT_RECOVERY_INTERRUPTED');
    expect(() => dchatRecoveryConnectionIds(t.directory, () => false)).toThrow('DCHAT_ACCOUNT_CHANGED');
    await runtime.stop();
  } finally { fs.rmSync(t.directory, { recursive: true, force: true }); }
});
