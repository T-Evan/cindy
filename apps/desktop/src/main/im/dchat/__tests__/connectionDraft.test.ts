import { describe, expect, it, vi } from 'vitest';
import { createDchatConnectionDraftHandlers, parseDchatConnectionDraft } from '../connectionDraft';
import type { DchatConnectionDraft } from '../../../../shared/dchatConnection';

/** Test value — unit tier.
 * Production entry: trusted IPC handler bodies; observable result: inactive, owner-scoped drafts.
 * Rules: credentials-and-local-storage owner isolation; IM permissions never derive from entered IDs.
 * Gap: transport tests do not cover configuration writes while owner/bot identity changes.
 * Minimal failures: account replacement during profile lookup, inactive bot, extra execution field.
 * Timing: recorded in docs/dchat-native-status.md after the targeted run.
 */
const input: DchatConnectionDraft = { botId: 'bot_test', accountId: '101', ownerId: '202', chatId: '303' };
function fixture() {
  let owner: string | null = 'owner-a:1';
  const records: Record<string, DchatConnectionDraft> = {};
  const bindingAvailable = vi.fn(async () => true);
  const write = vi.fn(async (botId: string, draft: DchatConnectionDraft | null, scope: string) => {
    if (scope !== owner) throw new Error('changed');
    if (draft) records[botId] = structuredClone(draft); else delete records[botId];
  });
  const deps = { scope: () => owner, read: () => structuredClone(records), write, bindingAvailable, platform: 'linux' };
  return { deps, bindingAvailable, write, records, switchOwner: (value: string | null) => { owner = value; } };
}
describe('D-Chat inactive connection drafts', () => {
  it('persists and restores a draft without claiming a connection on Linux', async () => {
    const f = fixture(); const handlers = createDchatConnectionDraftHandlers(f.deps);
    expect(await handlers.save(input)).toEqual({ draft: input, availability: 'platform-unsupported' });
    const restarted = createDchatConnectionDraftHandlers(f.deps);
    expect(restarted.get(input.botId).draft).toEqual(input);
    expect(createDchatConnectionDraftHandlers({ ...f.deps, platform: 'darwin' }).get(input.botId).availability).toBe('reader-unavailable');
  });
  it('refuses an unavailable partner but allows removing its stale draft', async () => {
    const f = fixture(); const handlers = createDchatConnectionDraftHandlers(f.deps);
    await handlers.save(input); f.bindingAvailable.mockResolvedValue(false);
    await expect(handlers.save(input)).rejects.toThrow('DCHAT_BOT_UNAVAILABLE');
    expect((await handlers.remove(input.botId)).draft).toBeNull();
  });
  it('refuses execution settings and object prototype keys', () => {
    expect(() => parseDchatConnectionDraft({ ...input, executeChatIds: ['303'] })).toThrow('DCHAT_INVALID_CONNECTION_DRAFT');
    for (const botId of ['__proto__', 'constructor', '../other-owner']) {
      expect(() => parseDchatConnectionDraft({ ...input, botId })).toThrow('DCHAT_INVALID_CONNECTION_DRAFT');
    }
  });
  it('rejects a write if the owner changes during profile lookup', async () => {
    const f = fixture(); f.bindingAvailable.mockImplementation(async () => { f.switchOwner('owner-b:2'); return true; });
    await expect(createDchatConnectionDraftHandlers(f.deps).save(input)).rejects.toThrow('DCHAT_ACCOUNT_CHANGED');
    expect(f.write).not.toHaveBeenCalled();
  });
  it('does not carry queued writes across an owner change', async () => {
    const f = fixture(); let release!: (value: boolean) => void;
    f.bindingAvailable.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; }));
    const handlers = createDchatConnectionDraftHandlers(f.deps);
    const first = handlers.save(input); const second = handlers.save({ ...input, botId: 'bot_other' });
    const settled = Promise.allSettled([first, second]);
    await Promise.resolve(); await Promise.resolve();
    f.switchOwner('owner-b:2'); release(true);
    expect((await settled).map(value => value.status)).toEqual(['rejected', 'rejected']);
    expect(f.write).not.toHaveBeenCalled();
  });
  it('refuses signed-out access', () => {
    const f = fixture(); f.switchOwner(null); const handlers = createDchatConnectionDraftHandlers(f.deps);
    expect(() => handlers.get(input.botId)).toThrow('DCHAT_ACCOUNT_UNAVAILABLE');
    expect(() => handlers.save(input)).toThrow('DCHAT_ACCOUNT_UNAVAILABLE');
  });
});
