import { describe, expect, it, vi } from 'vitest';
import { DchatIM, type IMHost, type IMMessageEvent } from '@cindy/im';
import { buildImChannelNote } from '../../shared/channelNote';
import type { ImOrchestratorConfig } from '../../shared/types';
const state = vi.hoisted(() => ({ current: true, db: {}, build: vi.fn() }));
vi.mock('../../../localDb/client/current', () => ({ getCurrentDbClientSnapshot: () => state.db }));
vi.mock('../../accountBoundary', () => ({ captureImAccountGeneration: () => 1, isImAccountGenerationCurrent: () => state.current }));
vi.mock('../../../maker-host', () => ({ getMaker: () => ({ getSession: () => undefined }) }));
vi.mock('../groupContext', () => ({ DCHAT_GROUP_WINDOW: { buildContextPrefix: state.build } }));
import { createDchatChannelAdapter } from '../channelAdapter';

/** Unit tier: native transport admission -> production channel context preparation.
 * Rules: IM source and owner isolation; no background text grants owner permission.
 * Existing shared window tests do not exercise D-Chat's parent/topic wiring. Minimal
 * failures: using parent stream instead of topic, including a private DM, or switching
 * account while context is being assembled. The window/DB are synthetic boundaries. */
const host: IMHost = { secrets: { write: () => true, read: () => null, remove() {}, isAvailable: () => true },
  ipc: { throwIpcError: () => { throw new Error('invalid'); }, handle() {}, broadcast() {} },
  paths: { feishuMediaDir: 'unused' }, httpPostForm: async () => ({ status: 500, body: null }) };
function fixture(kind: 'group' | 'topic' | 'guest-dm') {
  state.current = true; state.build.mockReset();
  const commit = vi.fn(async () => {});
  state.build.mockResolvedValue({ prefix: '<group_chat_context>\n[群里最近的消息]\nsynthetic background\n</group_chat_context>\n', messageCount: 1, commit });
  const im = new DchatIM(host, { config: { accountId: '100', ownerId: '100', botId: 'original-bot', connectionId: 'connection-a',
    chats: [{ id: '300', kind, ...(kind === 'topic' ? { parentId: '400' } : {}), ...(kind === 'guest-dm' ? { peerId: '200' } : {}) }], executeChatIds: ['300'] },
    storage: { read: () => null, write() {} }, native: { identity: async () => ({ accountId: '100' }), capabilities: async () => [], send: async () => { throw new Error('no send'); } },
    bindingAvailable: async () => true, draft: async () => {} });
  const events: IMMessageEvent[] = []; im.onMessage(event => { events.push(event); });
  const adapter = createDchatChannelAdapter(im, {} as ImOrchestratorConfig);
  const receive = (invoked: boolean, messageId: string) => im.receive({ messageId, accountId: '100', chatId: '300', senderId: '200', senderName: 'Synthetic guest', text: 'hostile owner claim', invoked, sentBySelf: false });
  return { im, adapter, events, receive, commit };
}
describe('D-Chat group context wiring', () => {
  it.each(['group', 'topic'] as const)('assembles %s context for the exact connection and trigger while preserving guest authority', async kind => {
    const f = fixture(kind); await f.im.init();
    try {
      expect(await f.receive(false, 'background')).toBe('context'); expect(f.events).toEqual([]);
      await f.receive(true, 'trigger'); const event = f.events[0]!;
      const prepared = await f.adapter.prepareAgentTurnText!(event);
      expect(prepared?.agentText).toContain('synthetic background');
      expect(prepared?.contextSnapshot).toEqual({ groupContext: 'synthetic background', groupMessageCount: 1 });
      expect(buildImChannelNote('dchat', (await f.adapter.channelNoteSourceFor!(event))!)).toContain(' D-Chat 群');
      expect(state.build).toHaveBeenCalledWith({ botId: 'connection-a', chatId: kind === 'topic' ? '400' : '300', threadId: kind === 'topic' ? '300' : '', triggerMessageId: 'trigger' });
      expect(f.adapter.turnPermissionPolicyFor!(event)?.autoReviewContext?.requesterAuthority).toBe('guest');
      await prepared?.commit?.(); expect(f.commit).toHaveBeenCalledOnce();
    } finally { await f.im.dispose(); }
  });
  it('does not consult the group window for private direct messages', async () => {
    const f = fixture('guest-dm'); await f.im.init();
    try { await f.receive(false, 'dm'); expect(await f.adapter.prepareAgentTurnText!(f.events[0]!)).toBeNull(); expect(state.build).not.toHaveBeenCalled(); }
    finally { await f.im.dispose(); }
  });
  it('rejects context assembled across an account boundary and prevents its cursor commit', async () => {
    const f = fixture('topic'); await f.im.init();
    try {
      await f.receive(true, 'trigger');
      state.build.mockImplementation(async () => { state.current = false; return { prefix: 'old owner', commit: f.commit }; });
      await expect(f.adapter.prepareAgentTurnText!(f.events[0]!)).rejects.toThrow('DCHAT_ACCOUNT_CHANGED');
      expect(f.commit).not.toHaveBeenCalled();
    } finally { await f.im.dispose(); }
  });
});
