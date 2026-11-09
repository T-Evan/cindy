import type { DchatConnectionDraft, DchatConnectionView } from '../../../shared/dchatConnection';

export interface DchatConnectionDraftDeps {
  /** Null while signed out or crossing an account boundary. Includes owner generation. */
  scope(): string | null;
  read(): Record<string, DchatConnectionDraft>;
  write(botId: string, draft: DchatConnectionDraft | null, scope: string): Promise<void>;
  bindingAvailable(botId: string): Promise<boolean>;
  platform: string;
}
const botIdValid = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
const nativeIdValid = (id: unknown): id is string => typeof id === 'string' && /^\d{1,128}$/.test(id);

/** Host-owned drafts only: neither a manually entered ID nor a saved record authorizes dispatch. */
export function parseDchatConnectionDraft(value: unknown): DchatConnectionDraft {
  const r = value as DchatConnectionDraft | null;
  if (!r || typeof r !== 'object' || !botIdValid(r.botId)
    || ![r.accountId, r.ownerId, r.chatId].every(nativeIdValid)
    || Object.keys(r).some(key => !['botId', 'accountId', 'ownerId', 'chatId'].includes(key))) {
    throw new Error('DCHAT_INVALID_CONNECTION_DRAFT');
  }
  return { botId: r.botId, accountId: r.accountId, ownerId: r.ownerId, chatId: r.chatId };
}

export function createDchatConnectionDraftHandlers(deps: DchatConnectionDraftDeps) {
  let pending: Promise<unknown> = Promise.resolve();
  const scope = () => { const key = deps.scope(); if (!key) throw new Error('DCHAT_ACCOUNT_UNAVAILABLE'); return key; };
  const assertCurrent = (expected: string) => { if (deps.scope() !== expected) throw new Error('DCHAT_ACCOUNT_CHANGED'); };
  const view = (botId: string): DchatConnectionView => {
    if (!botIdValid(botId)) throw new Error('DCHAT_INVALID_BOT');
    return { draft: deps.read()[botId] ?? null,
      availability: deps.platform === 'darwin' ? 'reader-unavailable' : 'platform-unsupported' };
  };
  // Serialize mutation before the first await; each request retains its ingress owner.
  function mutate(botId: string, draft: DchatConnectionDraft | null) {
    const expected = scope();
    const operation = pending.catch(() => {}).then(async () => {
      assertCurrent(expected);
      if (draft && !await deps.bindingAvailable(botId)) throw new Error('DCHAT_BOT_UNAVAILABLE');
      assertCurrent(expected);
      await deps.write(botId, draft, expected);
      assertCurrent(expected);
      return view(botId);
    });
    pending = operation; return operation;
  }
  return {
    get(botId: string): DchatConnectionView { scope(); return view(botId); },
    save(value: unknown) { const draft = parseDchatConnectionDraft(value); return mutate(draft.botId, draft); },
    remove(botId: string) {
      if (!botIdValid(botId)) throw new Error('DCHAT_INVALID_BOT');
      return mutate(botId, null);
    },
  };
}
