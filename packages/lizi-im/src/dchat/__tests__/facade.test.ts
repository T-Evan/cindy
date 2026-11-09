import { describe, expect, it, vi } from 'vitest';
import { DchatIM } from '../index';
import type { IMHost, IMMessageEvent } from '../../types';
import type { DchatConfig } from '../config';

/** Public TextChannelIM facade, unit tier. Protects native IM handoff, persisted
 * acceptance and terminal output association; existing transports lack D-Chat
 * correlation. Minimal failures: terminal before persistence, two overlapping
 * inputs in one lane, and disabled connection receiving a late terminal. */
const host: IMHost = { secrets: { write: () => true, read: () => null, remove: () => {}, isAvailable: () => true },
  ipc: { throwIpcError: () => { throw new Error('invalid'); }, handle: () => {}, broadcast: () => {} },
  paths: { feishuMediaDir: 'unused' }, httpPostForm: async () => ({ status: 500, body: null }) };
const config: DchatConfig = { accountId: 'self', ownerId: 'owner', connectionId: 'conn', botId: 'bot',
  chats: [{ id: 'dm', kind: 'owner-dm', peerId: 'owner' }], executeChatIds: ['dm'], replyMode: 'automatic' };
function fixture(overrides: Partial<DchatConfig> = {}) {
  let data: unknown = null; const sends: unknown[] = []; const events: IMMessageEvent[] = [];
  const im = new DchatIM(host, { config: { ...config, ...overrides }, storage: { read: () => data, write: value => { data = structuredClone(value); } },
    native: { identity: async () => ({ accountId: 'self' }), capabilities: async () => ['content', 'dchat_im_clean_send_v2'],
      send: async value => { sends.push(value); return { messageId: 'sent' }; } }, bindingAvailable: async () => true, draft: async () => {} });
  im.onMessage(event => { events.push(event); });
  const receive = (messageId = 'input', chatId = 'dm') => im.receive({ messageId, accountId: 'self', chatId, senderId: 'owner',
    senderName: 'Synthetic owner', text: 'synthetic', sentBySelf: false, invoked: true });
  return { im, receive, sends, events };
}
describe('DchatIM native orchestrator facade', () => {
  it('emits trusted speaker metadata, acknowledges persistence and returns final output to its lane', async () => {
    const f = fixture(); await f.im.init(); await f.receive();
    const event = f.events[0]!; expect(event.speaker).toMatchObject({ id: 'owner', isOwner: true });
    expect(event.chatId).toBe('dm'); f.im.acknowledgeIncoming(event.messageId);
    await f.im.commitFinal({ userId: event.senderId, inputMessageId: event.messageId, text: 'synthetic result', terminal: 'done' });
    expect(f.sends).toMatchObject([{ chatId: 'dm', text: 'synthetic result' }]); await f.im.dispose();
  });
  it('rejects final output before persisted input acknowledgment', async () => {
    const f = fixture(); await f.im.init(); await f.receive();
    await expect(f.im.commitFinal({ userId: f.events[0]!.senderId, inputMessageId: f.events[0]!.messageId, text: 'unaccepted', terminal: 'done' })).rejects.toThrow('DCHAT_STALE_OUTPUT');
    expect(f.sends).toEqual([]); await f.im.dispose();
  });
  it('does not replace an active lane with a second input', async () => {
    const f = fixture(); await f.im.init(); await f.receive();
    await expect(f.receive('second')).resolves.toBe('dispatched');
    expect(f.im.queuedInputs()).toHaveLength(1);
    expect(f.events).toHaveLength(1); const first = f.events[0]!; f.im.acknowledgeIncoming(first.messageId);
    await f.im.commitFinal({ userId: first.senderId, inputMessageId: first.messageId, text: 'first result', terminal: 'done' });
    expect(f.sends).toHaveLength(1);
    await vi.waitFor(() => expect(f.events).toHaveLength(2), { interval: 1 }); const second = f.events[1]!; expect(second.messageId).not.toBe(first.messageId);
    f.im.acknowledgeIncoming(second.messageId, 'synthetic-session', 'synthetic-client');
    await f.im.commitFinal({ userId: second.senderId, inputMessageId: second.messageId, text: 'second result', terminal: 'done' });
    expect(f.sends).toMatchObject([{ text: 'first result' }, { text: 'second result' }]); await f.im.dispose();
  });
  it('reloads only never-dispatched queued IDs after restart and refuses uncertain active input replay', async () => {
    const f = fixture(); await f.im.init(); await f.receive('active');
    f.im.acknowledgeIncoming(f.events[0]!.messageId, 'synthetic-session', 'synthetic-active');
    await f.receive('queued'); await f.im.init();
    expect(f.im.queuedInputs().map(r => r.messageId)).toEqual(['queued']);
    expect(await f.receive('active')).toBe('duplicate');
    expect(await f.receive('queued')).toBe('dispatched');
    expect(f.events).toHaveLength(2); expect(f.sends).toEqual([]); await f.im.dispose();
  });
  it('delivers a verified owner stop while busy without replacing the running output anchor', async () => {
    const f = fixture(); await f.im.init(); await f.receive('active'); await f.receive('queued');
    const active = f.events[0]!; f.im.acknowledgeIncoming(active.messageId);
    await f.im.receive({ messageId: 'stop', accountId: 'self', chatId: 'dm', senderId: 'owner', senderName: 'Synthetic owner', text: '/stop', sentBySelf: false, invoked: true });
    expect(f.events.map(e => e.text)).toEqual(['synthetic', '/stop']); expect(f.im.queuedInputs()).toEqual([]);
    await f.im.commitFinal({ userId: active.senderId, inputMessageId: active.messageId, text: '', terminal: 'aborted' });
    expect(f.sends).toEqual([]); await f.im.dispose();
  });
  it('does not confuse persistence acknowledgments when two chats reuse a native message id', async () => {
    const f = fixture({ chats: [...config.chats, { id: 'group', kind: 'group' }], executeChatIds: ['dm', 'group'] });
    await f.im.init(); await f.receive('same'); await f.receive('same', 'group');
    const [dm, group] = f.events;
    expect(dm!.messageId).not.toBe(group!.messageId);
    f.im.acknowledgeIncoming(dm!.messageId);
    await f.im.commitFinal({ userId: dm!.senderId, inputMessageId: dm!.messageId, text: 'private result', terminal: 'done' });
    expect(f.sends).toMatchObject([{ chatId: 'dm', text: 'private result' }]);
    f.im.acknowledgeIncoming(group!.messageId);
    await f.im.commitFinal({ userId: group!.senderId, inputMessageId: group!.messageId, text: 'group result', terminal: 'done' });
    expect(f.sends).toMatchObject([{ chatId: 'dm' }, { chatId: 'group', text: 'group result' }]);
    await f.im.dispose();
  });
  it('keeps simultaneous partner connections and reversed terminal outputs separate', async () => {
    const a = fixture(); const b = fixture({ connectionId: 'conn-b', botId: 'bot-b' });
    await Promise.all([a.im.init(), b.im.init()]);
    await Promise.all([a.receive(), b.receive()]);
    for (const f of [a, b]) f.im.acknowledgeIncoming(f.events[0]!.messageId);
    await b.im.commitFinal({ userId: b.events[0]!.senderId, inputMessageId: b.events[0]!.messageId, text: 'B result', terminal: 'done' });
    await a.im.commitFinal({ userId: a.events[0]!.senderId, inputMessageId: a.events[0]!.messageId, text: 'A result', terminal: 'done' });
    expect(a.sends).toMatchObject([{ text: 'A result' }]); expect(b.sends).toMatchObject([{ text: 'B result' }]);
    await Promise.all([a.im.dispose(), b.im.dispose()]);
  });
  it('rejects a late terminal from a previous input while the next input occupies the same lane', async () => {
    const f = fixture(); await f.im.init(); await f.receive('old');
    const old = f.events[0]!; f.im.acknowledgeIncoming(old.messageId);
    await f.im.commitFinal({ userId: old.senderId, inputMessageId: old.messageId, text: 'first', terminal: 'done' });
    await f.receive('next'); const next = f.events[1]!; f.im.acknowledgeIncoming(next.messageId);
    await expect(f.im.commitFinal({ userId: old.senderId, inputMessageId: old.messageId, text: 'late', terminal: 'done' })).rejects.toThrow('DCHAT_STALE_OUTPUT');
    await f.im.commitFinal({ userId: next.senderId, inputMessageId: next.messageId, text: 'second', terminal: 'done' });
    expect(f.sends).toMatchObject([{ text: 'first' }, { text: 'second' }]); await f.im.dispose();
  });
  it('rejects arbitrary sends and late output after dispose', async () => {
    const f = fixture(); await f.im.init(); await f.receive(); const event = f.events[0]!; f.im.acknowledgeIncoming(event.messageId);
    await expect(f.im.sendText(event.senderId, 'side channel')).rejects.toThrow('DCHAT_USE_BOUND_FINAL_OUTPUT');
    await f.im.dispose(); await expect(f.im.commitFinal({ userId: event.senderId, inputMessageId: event.messageId, text: 'late', terminal: 'done' })).rejects.toThrow('DCHAT_STALE_OUTPUT');
    expect(f.sends).toEqual([]);
  });
});
