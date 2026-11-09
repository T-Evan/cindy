import { describe, expect, it, vi } from 'vitest';
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
