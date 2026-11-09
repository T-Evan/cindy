export interface DchatChat { id: string; kind: 'owner-dm' | 'guest-dm' | 'group' | 'topic'; peerId?: string; parentId?: string; }
export interface DchatConfig {
  accountId: string; ownerId: string; botId: string; connectionId: string;
  chats: DchatChat[];
  /** Execution requires a separately confirmed exact chat allowlist; default is context only. */
  executeChatIds?: string[];
  replyMode?: 'draft' | 'automatic';
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
export function parseDchatConfig(raw: unknown): DchatConfig {
  if (!raw || typeof raw !== 'object') throw new Error('DCHAT_INVALID_CONFIG');
  const r = raw as DchatConfig;
  if (![r.accountId, r.ownerId, r.botId, r.connectionId].every(id) || !Array.isArray(r.chats) || !r.chats.length || r.chats.length > 100
    || new Set(r.chats.map(c => c?.id)).size !== r.chats.length
    || r.chats.some(c => !c || !id(c.id) || !['owner-dm', 'guest-dm', 'group', 'topic'].includes(c.kind)
      || ((c.kind === 'owner-dm' || c.kind === 'guest-dm') && !id(c.peerId)) || (c.kind === 'owner-dm' && c.peerId !== r.ownerId)
      || (c.kind === 'guest-dm' && c.peerId === r.ownerId) || (c.kind === 'topic' && !id(c.parentId)))
    || (r.replyMode !== undefined && !['draft', 'automatic'].includes(r.replyMode))
    || (r.executeChatIds !== undefined && (!Array.isArray(r.executeChatIds) || r.executeChatIds.some(chat => !r.chats.some(c => c.id === chat))))) {
    throw new Error('DCHAT_INVALID_CONFIG');
  }
  return { accountId: r.accountId, ownerId: r.ownerId, botId: r.botId, connectionId: r.connectionId,
    chats: r.chats.map(c => ({ id: c.id, kind: c.kind, ...(c.peerId ? { peerId: c.peerId } : {}), ...(c.parentId ? { parentId: c.parentId } : {}) })),
    executeChatIds: [...new Set(r.executeChatIds ?? [])], replyMode: r.replyMode ?? 'draft' };
}
