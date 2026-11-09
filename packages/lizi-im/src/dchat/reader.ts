import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

/** D-Chat's installed native CLI is an optional read adapter, never a QChat runtime.
 * Paths are selected by the owner; no download/updater/wrapper is executed here. */
export class DchatCliReader {
  constructor(private readonly executable: string) {}
  private async read(args: string[]): Promise<Record<string, unknown>> {
    if (process.platform !== 'darwin') throw new Error('DCHAT_PLATFORM_UNSUPPORTED');
    if (!path.isAbsolute(this.executable)) throw new Error('DCHAT_READER_INVALID');
    const info = await lstat(this.executable);
    if (!info.isFile() || (info.mode & 0o022) !== 0 || (info.uid !== 0 && info.uid !== process.getuid?.())) throw new Error('DCHAT_READER_INVALID');
    const result = await new Promise<string>((resolve, reject) => {
      // Minimal environment; never forward model/provider authentication to the reader.
      execFile(this.executable, ['--output', 'json', ...args], { timeout: 15_000, maxBuffer: 4_000_000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG } },
      (error, stdout) => { if (error) reject(new Error('DCHAT_READ_FAILED')); else resolve(stdout); });
    });
    let envelope: { ok?: unknown; data?: unknown };
    try { envelope = JSON.parse(result, (key, value: unknown) => {
      if (key === '__proto__' || key === 'constructor' || (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error('invalid');
      return value;
    }) as typeof envelope; } catch { throw new Error('DCHAT_READ_SCHEMA_UNSUPPORTED'); }
    if (envelope.ok !== true || !envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) throw new Error('DCHAT_READ_UNAVAILABLE');
    return envelope.data as Record<string, unknown>;
  }
  async identity(): Promise<{ accountId: string }> {
    const data = await this.read(['user', 'info', '--self']);
    const user = data.user as { id?: unknown } | undefined;
    if (typeof user?.id !== 'string' || !/^\d{1,128}$/.test(user.id)) throw new Error('DCHAT_IDENTITY_UNAVAILABLE');
    return { accountId: user.id };
  }
  /** Backend-only read, bracketed by fresh local identity. No tokens leave the CLI. */
  async members(chatId: string): Promise<{ accountId: string; chatId: string; memberIds: string[] }> {
    if (!/^\d{1,128}$/.test(chatId)) throw new Error('DCHAT_INVALID_MEMBERSHIP_QUERY');
    const before = await this.identity();
    const raw = await this.read(['chat', 'members', '--vid', chatId]);
    const memberIds = decodeDchatMembers(raw, chatId);
    if ((await this.identity()).accountId !== before.accountId) throw new Error('DCHAT_ACCOUNT_CHANGED');
    return { accountId: before.accountId, chatId, memberIds };
  }
  /** Explicit bounded history reads only. Permission errors stay visible; no fallback to another account/source. */
  async page(chatId: string, anchor?: string): Promise<Record<string, unknown>> {
    if (!/^\d{1,128}$/.test(chatId) || (anchor !== undefined && (!anchor || anchor.length > 2048 || Array.from(anchor).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)))) throw new Error('DCHAT_INVALID_HISTORY_QUERY');
    const result = await this.read(anchor ? ['message', 'from-key', 'forward', '--vid', chatId, anchor, '--count', '50']
      : ['message', 'latest', '--vid', chatId, '--count', '50']);
    const pagination = result.pagination as { newer?: { has_more?: unknown; query?: { anchor_key?: unknown } }; older?: unknown } | undefined;
    if (!Array.isArray(result.messages) || result.messages.length > 50 || !pagination?.older || typeof pagination.newer?.has_more !== 'boolean'
      || (pagination.newer.has_more && typeof pagination.newer.query?.anchor_key !== 'string')) throw new Error('DCHAT_HISTORY_INCOMPLETE');
    return result;
  }
}

/** Deliberately strict machine contract. schema chat.members advertises the read,
 * but not its JSON shape/completeness. Unknown installed versions fail closed;
 * a real authorized Mac read must verify this contract before activation. */
export function decodeDchatMembers(raw: Record<string, unknown>, chatId: string): string[] {
  if (raw.vchannel_id !== chatId || raw.has_more !== false || !Array.isArray(raw.members)
    || !Number.isSafeInteger(raw.member_count) || raw.member_count !== raw.members.length || raw.members.length > 10000) throw new Error('DCHAT_MEMBER_SCHEMA_UNVERIFIED');
  const ids = raw.members.map((member: unknown) => {
    const id = (member as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !/^\d{1,128}$/.test(id)) throw new Error('DCHAT_MEMBER_SCHEMA_UNVERIFIED');
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new Error('DCHAT_MEMBER_SCHEMA_UNVERIFIED');
  return ids;
}
