import { afterEach, describe, expect, it, vi } from 'vitest';
import { DchatNativeInlet } from '../inlet';
import { DchatIM } from '../index';
import type { IMHost, IMMessageEvent } from '../../types';
import type { DchatReadPage } from '../sqlcipher';

/** Native inlet -> real transport facade, unit tier. IM account/source and cursor
 * acceptance contracts. Existing facade tests bypassed polling and restart cursors.
 * Minimal failures: cached first page executing, a missing anchor, and account change
 * while a page is in flight. All native account/body data here is synthetic. */
const host: IMHost = { secrets: { write: () => true, read: () => null, remove: () => {}, isAvailable: () => true },
  ipc: { throwIpcError: () => { throw new Error('invalid'); }, handle: () => {}, broadcast: () => {} },
  paths: { feishuMediaDir: 'unused' }, httpPostForm: async () => ({ status: 500, body: null }) };
const config = { accountId: '100', ownerId: '200', botId: 'bot', connectionId: 'conn', chats: [{ id: '300', kind: 'owner-dm' as const, peerId: '200' }], executeChatIds: ['300'], replyMode: 'automatic' as const };
function fixture() {
  let accountId = '100', current = true, ledger: unknown = null, cursor: unknown = null;
  const events: IMMessageEvent[] = [], sends: unknown[] = [];
  let result: DchatReadPage = { accountId, chatId: '300', kind: 'p2p', peerId: '200', parentId: '',
    messages: [{ accountId, chatId: '300', senderId: '200', senderName: 'Synthetic owner', messageId: 'cached', sequence: '1', previousId: '', text: 'cached input', sentBySelf: false, invoked: false }],
    cursor: 'cached', hasMore: false, continuous: false };
  const im = new DchatIM(host, { config, native: { identity: async () => ({ accountId }), capabilities: async () => ['content'],
    send: async value => { sends.push(value); return { messageId: 'resource:synthetic' }; } },
    storage: { read: () => ledger, write: value => { ledger = structuredClone(value); } }, bindingAvailable: async () => current, draft: async () => {} });
  im.onMessage(event => { events.push(event); });
  const reader = { identity: async () => ({ accountId }), page: vi.fn(async () => result), dispose: vi.fn() };
  const inlet = new DchatNativeInlet(config, { reader, im, current: () => current,
    storage: { read: () => cursor, write: value => { cursor = structuredClone(value); } }, onError: vi.fn() });
  return { im, inlet, reader, events, sends, page(value: Partial<DchatReadPage>) { result = { ...result, ...value }; },
    cursor: () => cursor, account(value: string) { accountId = value; }, current(value: boolean) { current = value; } };
}
afterEach(() => vi.useRealTimers());
describe('D-Chat native polling lifecycle', () => {
  it('baselines cached history, dispatches a continuous new input and keeps the reply at its native destination', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.im.init(); await f.inlet.start();
    expect(f.events).toEqual([]); expect(f.cursor()).toMatchObject({ cursors: { '300': 'cached' } });
    f.page({ continuous: true, cursor: 'new', messages: [{ accountId: '100', chatId: '300', senderId: '200', senderName: 'Synthetic owner', messageId: 'new', sequence: '2', previousId: 'cached', text: 'new input', sentBySelf: false, invoked: false }] });
    await f.inlet.pollOnce(); expect(f.events).toHaveLength(1);
    const event = f.events[0]!; f.im.acknowledgeIncoming(event.messageId, 'canonical-synthetic', 'persisted-synthetic-client');
    await f.im.commitFinal({ userId: event.senderId, inputMessageId: event.messageId, text: 'synthetic result', terminal: 'done' });
    expect(f.sends).toMatchObject([{ chatId: '300', accountId: '100', text: 'synthetic result', mode: 'attributed' }]);
    await f.inlet.stop(); expect(f.im.getStatus().kind).toBe('idle'); expect(f.reader.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves the previous cursor and dispatches nothing when account identity changes during a read', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.im.init(); await f.inlet.start();
    const before = structuredClone(f.cursor()); f.reader.page.mockImplementationOnce(async () => { f.account('999'); return { accountId: '100' } as DchatReadPage; });
    await expect(f.inlet.pollOnce()).rejects.toThrow(); expect(f.events).toEqual([]); expect(f.cursor()).toEqual(before);
    await f.inlet.stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a cache-only page or unverifiable peer instead of swallowing a gap', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.im.init(); await f.inlet.start();
    const before = structuredClone(f.cursor());
    await expect(f.inlet.pollOnce()).rejects.toThrow('DCHAT_HISTORY_GAP');
    f.page({ continuous: true, peerId: '999' }); await expect(f.inlet.pollOnce()).rejects.toThrow('DCHAT_PEER_UNVERIFIED');
    expect(f.cursor()).toEqual(before); expect(f.events).toEqual([]); await f.inlet.stop();
  });
});
