import { describe, expect, it, vi } from 'vitest';
import { DchatIM, type IMHost } from '@cindy/im';
import type { AgentEvent } from '@cindy/maker-core';
import { createDchatExecutionObserver } from '../executionObserver';

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
    generation: (value: number) => { generation = value; }, execute: (value: boolean) => { execute = value; }, renew: () => { authorizationKey = 'lease-two'; }, failSend: () => { failSend = true; } };
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
