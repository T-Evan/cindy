import { createHash, randomUUID } from 'node:crypto';
import type { DchatChat } from '@cindy/im';
import type { DchatSetupPath, DchatSetupView } from '../../../shared/dchatConnection';
import type { NativeBinding } from './nativeRuntime';

const fields: DchatSetupPath[] = ['identityExecutable', 'sqlcipherExecutable', 'component', 'databaseRoot'];
const validBot = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
type Paths = Pick<NativeBinding, DchatSetupPath>;
export interface DchatSetupDeps {
  scope(): string | null; platform: string;
  read(): NativeBinding[];
  write(binding: NativeBinding, scope: string): Promise<void>;
  available(botId: string): Promise<boolean>;
  choose(field: DchatSetupPath): Promise<string | null>;
  verify(paths: Paths, chatId: string): Promise<{ accountId: string; chat: DchatChat }>;
  connected(connectionId: string): boolean;
  reload(): Promise<void>;
}
/** Only Main-selected paths and fresh local identity can produce a native binding.
 * Renderer supplies a target, never an account/owner/permission claim. All operations
 * capture ingress scope; stale dialogs and queued saves cannot write to another owner. */
export function createDchatSetupHandlers(deps: DchatSetupDeps) {
  const selected = new Map<string, Partial<Paths>>();
  let pending: Promise<unknown> = Promise.resolve();
  const scope = () => { const value = deps.scope(); if (!value) throw new Error('DCHAT_ACCOUNT_UNAVAILABLE'); return value; };
  const assert = (expected: string) => { if (deps.scope() !== expected) throw new Error('DCHAT_ACCOUNT_CHANGED'); };
  const binding = (botId: string) => deps.read().find(b => b.config.botId === botId);
  const key = (botId: string) => JSON.stringify([scope(), botId]);
  function view(botId: string): DchatSetupView {
    scope(); if (!validBot(botId)) throw new Error('DCHAT_INVALID_BOT');
    const b = binding(botId), paths = { ...b, ...selected.get(key(botId)) };
    return { platformSupported: deps.platform === 'darwin', selected: fields.filter(field => !!paths[field]),
      accountId: b?.config.accountId ?? null, chatId: b?.config.chats[0]?.id ?? null,
      execute: !!b?.config.executeChatIds?.length, enabled: b?.enabled === true,
      status: !b ? 'unconfigured' : !b.enabled ? 'saved' : deps.connected(b.config.connectionId) ? 'connected' : 'offline' };
  }
  function mutate<T>(botId: string, work: (expected: string) => Promise<T>): Promise<T> {
    if (!validBot(botId)) throw new Error('DCHAT_INVALID_BOT');
    const expected = scope();
    const result = pending.catch(() => {}).then(async () => { assert(expected); return work(expected); });
    pending = result; return result;
  }
  async function verify(botId: string, paths: Paths, chatId: string, expected: string) {
    if (deps.platform !== 'darwin') throw new Error('DCHAT_PLATFORM_UNSUPPORTED');
    if (!/^\d{1,128}$/.test(chatId) || fields.some(field => !paths[field])) throw new Error('DCHAT_SETUP_INCOMPLETE');
    if (!await deps.available(botId)) throw new Error('DCHAT_BOT_UNAVAILABLE');
    assert(expected);
    const proof = await deps.verify(paths, chatId); assert(expected);
    if (!/^\d{1,128}$/.test(proof.accountId) || proof.chat.id !== chatId) throw new Error('DCHAT_IDENTITY_UNAVAILABLE');
    if (!await deps.available(botId)) throw new Error('DCHAT_BOT_UNAVAILABLE');
    assert(expected); return proof;
  }
  return {
    get: view,
    pick(botId: string, field: DchatSetupPath) { return mutate(botId, async expected => {
      if (!fields.includes(field) || deps.platform !== 'darwin') throw new Error('DCHAT_PLATFORM_UNSUPPORTED');
      const chosen = await deps.choose(field); assert(expected);
      if (chosen) selected.set(key(botId), { ...selected.get(key(botId)), [field]: chosen });
      return view(botId);
    }); },
    save(input: { botId: string; chatId: string; execute: boolean }) {
      if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['botId', 'chatId', 'execute'].includes(k)) || typeof input.execute !== 'boolean') throw new Error('DCHAT_INVALID_SETUP');
      return mutate(input.botId, async expected => {
        const previous = binding(input.botId);
        const paths = { ...previous, ...selected.get(key(input.botId)) } as Paths;
        const proof = await verify(input.botId, paths, input.chatId, expected);
        const connectionId = previous?.config.connectionId ?? 'dchat-' + createHash('sha256').update(randomUUID()).digest('hex').slice(0, 32);
        await deps.write({ ...paths, enabled: false, socketPath: '/tmp/dc-workspace-server.prod.socket',
          config: { connectionId, botId: input.botId, accountId: proof.accountId, ownerId: proof.accountId,
            chats: [proof.chat], executeChatIds: input.execute ? [proof.chat.id] : [], replyMode: 'draft', sendMode: 'attributed' } }, expected);
        assert(expected); selected.delete(key(input.botId)); await deps.reload(); assert(expected); return view(input.botId);
      });
    },
    enable(botId: string) { return mutate(botId, async expected => {
      const previous = binding(botId); if (!previous) throw new Error('DCHAT_SETUP_INCOMPLETE');
      const proof = await verify(botId, previous, previous.config.chats[0]!.id, expected);
      if (proof.accountId !== previous.config.accountId || JSON.stringify(proof.chat) !== JSON.stringify(previous.config.chats[0])) throw new Error('DCHAT_ACCOUNT_CHANGED');
      await deps.write({ ...previous, enabled: true }, expected); assert(expected);
      await deps.reload(); assert(expected); return view(botId);
    }); },
    disable(botId: string) { return mutate(botId, async expected => {
      const previous = binding(botId);
      if (previous) { await deps.write({ ...previous, enabled: false }, expected); assert(expected); await deps.reload(); assert(expected); }
      return view(botId);
    }); },
  };
}
