import { spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DchatInbound } from './transport.js';

export interface DchatReadPage {
  accountId: string; chatId: string; peerId: string; kind: string; parentId: string;
  messages: Array<DchatInbound & { sequence: string; previousId: string }>;
  cursor: string | null; hasMore: boolean; continuous: boolean;
}
export interface DchatCipherOptions {
  executable: string; databaseRoot: string; component: string;
  /** Must come from a fresh authenticated native identity, not the binding form. */
  identity(): Promise<{ accountId: string }>;
  platform?: string;
}
const id = (v: unknown): v is string => typeof v === 'string' && /^\d{1,128}$/.test(v);
const quote = (v: string): string => "'" + v.replace(/'/g, "''") + "'";
const failure = (): Error => new Error('DCHAT_LOCAL_READ_UNAVAILABLE');
function parse(text: string): unknown {
  return JSON.parse(text, (key, v: unknown) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype'
      || (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v))) throw failure();
    return v;
  });
}
/** Reads only Mach-O __cstring sections; never executes or modifies the D-Chat component.
 * Candidates have no authority until the account-bound SQLCipher schema probe succeeds.
 * Generic file-format implementation, not copied from a third-party bridge. */
export function dchatKeyCandidates(bytes: Buffer): string[] {
  const bounds = (offset: number, size: number) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > bytes.length) throw failure();
  };
  bounds(0, 8);
  let base = 0, end = bytes.length;
  const magic = bytes.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = bytes.readUInt32BE(4), stride = magic === 0xcafebabf ? 32 : 20;
    if (count < 1 || count > 32) throw failure();
    bounds(8, count * stride);
    let selected = false;
    for (let i = 0; i < count; i++) {
      const at = 8 + i * stride, cpu = bytes.readUInt32BE(at);
      if (![0x0100000c, 0x01000007].includes(cpu)) continue;
      base = stride === 32 ? Number(bytes.readBigUInt64BE(at + 8)) : bytes.readUInt32BE(at + 8);
      const size = stride === 32 ? Number(bytes.readBigUInt64BE(at + 16)) : bytes.readUInt32BE(at + 12);
      bounds(base, size); end = base + size; selected = true; break;
    }
    if (!selected) throw failure();
  }
  bounds(base, 32);
  if (bytes.readUInt32LE(base) !== 0xfeedfacf || ![0x0100000c, 0x01000007].includes(bytes.readUInt32LE(base + 4))) throw failure();
  const commands = bytes.readUInt32LE(base + 16), commandEnd = base + 32 + bytes.readUInt32LE(base + 20);
  if (commands > 4096 || commandEnd > end) throw failure();
  const candidates = new Set<string>();
  let at = base + 32;
  for (let i = 0; i < commands; i++) {
    bounds(at, 8);
    const kind = bytes.readUInt32LE(at), size = bytes.readUInt32LE(at + 4);
    if (size < 8 || at + size > commandEnd) throw failure();
    if (kind === 0x19) {
      if (size < 72) throw failure();
      const sections = bytes.readUInt32LE(at + 64);
      if (72 + sections * 80 > size) throw failure();
      for (let j = 0; j < sections; j++) {
        const section = at + 72 + j * 80;
        if (bytes.subarray(section, section + 16).toString().split('\0')[0] !== '__cstring') continue;
        const start = base + bytes.readUInt32LE(section + 48), length = Number(bytes.readBigUInt64LE(section + 40));
        bounds(start, length);
        if (length > 8 * 1024 * 1024 || start + length > end) throw failure();
        let first = start;
        for (let p = start; p < start + length; p++) {
          if (bytes[p] !== 0) continue;
          if (p - first === 28) {
            const value = bytes.subarray(first, p).toString('latin1');
            if (/^[\x20-\x7e]{28}$/.test(value)) candidates.add(value);
            if (candidates.size > 32) throw new Error('DCHAT_KEY_PROBE_BUDGET');
          }
          first = p + 1;
        }
      }
    }
    at += size;
  }
  if (!candidates.size) throw failure();
  return [...candidates];
}
/** Bounded SQLCipher process. The passphrase travels only on stdin; stderr is discarded
 * because SQL errors may echo it. Read-only open and query_only both remain mandatory. */
export async function queryDchatReadonly(options: {
  executable: string; database: string; key: string; sql: string; signal?: AbortSignal; timeoutMs?: number;
}): Promise<unknown> {
  if (options.signal?.aborted) throw failure();
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable, ['-readonly', '-batch', '-init', '/dev/null', options.database], {
      stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    });
    let bytes = 0, settled = false;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (error) { child.kill('SIGKILL'); reject(error); } else resolve(value);
    };
    const abort = (): void => finish(failure());
    const timer = setTimeout(abort, options.timeoutMs ?? 3000);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.on('error', abort); child.stdin.on('error', abort);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length; if (bytes > 4_000_000) return abort(); chunks.push(chunk);
    });
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) return abort();
      try { finish(undefined, parse(Buffer.concat(chunks).toString('utf8'))); } catch { abort(); }
    });
    if (options.signal?.aborted) return abort();
    child.stdin.end('.bail on\n.echo off\n.timeout 1000\n.output /dev/null\nPRAGMA key=' + quote(options.key)
      + ';\nPRAGMA query_only=ON;\n.output stdout\n' + options.sql + '\n');
  });
}
const fields: Record<string, string[]> = {
  messages: ['key', 'vchannel_id', 'vchannel_seq', 'prev_msg_key', 'uid', 'robot_id', 'text', 'content', 'created_ts'],
  vchannels: ['id', 'type', 'target_id', 'is_left', 'is_dissolve', 'is_kickout'],
  sub_channels: ['id', 'vchannel_id', 'primary_vchannel_id'], users: ['id', 'name'],
};
const schemaSql = 'SELECT json_object(' + Object.entries(fields).map(([table]) => quote(table)
  + ",json((SELECT json_group_array(name) FROM pragma_table_info(" + quote(table) + ')))').join(',') + ');';
function schemaValid(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  return Object.entries(fields).every(([table, names]) => {
    const list = (raw as Record<string, unknown>)[table];
    return Array.isArray(list) && names.every(name => list.includes(name));
  });
}
/** Production macOS SQLCipher reader. No database copying, WAL checkpoint, writable open,
 * persistent keys, SQL supplied by Renderer, or fallback to another cached account. */
export class DchatSqlcipherReader {
  private key: { accountId: string; signature: string; value: string } | null = null;
  constructor(private readonly options: DchatCipherOptions,
    private readonly query = queryDchatReadonly) {}
  identity(): Promise<{ accountId: string }> { return this.options.identity(); }
  dispose(): void { this.key = null; }
  private async location(): Promise<{ accountId: string; database: string }> {
    if ((this.options.platform ?? process.platform) !== 'darwin') throw new Error('DCHAT_PLATFORM_UNSUPPORTED');
    const { accountId } = await this.identity();
    if (!id(accountId)) throw failure();
    for (const file of [this.options.executable, this.options.component]) {
      if (!path.isAbsolute(file)) throw failure();
      const stat = await lstat(file);
      if (!stat.isFile() || (stat.mode & 0o022) || (stat.uid !== 0 && stat.uid !== process.getuid?.())) throw failure();
    }
    if (!path.isAbsolute(this.options.databaseRoot)) throw failure();
    const directory = path.join(this.options.databaseRoot, '1_' + accountId + '_db');
    for (const dir of [this.options.databaseRoot, directory]) {
      const stat = await lstat(dir); if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw failure();
    }
    const database = path.join(directory, 'chat39'), stat = await lstat(database);
    if (!stat.isFile() || stat.uid !== process.getuid?.()) throw failure();
    // A read-only WAL connection must not create a missing shared-memory sidecar.
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = await lstat(database + suffix).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;
      });
      if (sidecar && (!sidecar.isFile() || sidecar.uid !== process.getuid?.())) throw failure();
      if (suffix === '-wal' && sidecar && sidecar.size > 0) {
        const shm = await lstat(database + '-shm').catch(() => null);
        if (!shm?.isFile() || shm.uid !== process.getuid?.()) throw failure();
      }
    }
    return { accountId, database };
  }
  private async run(sql: string, signal?: AbortSignal): Promise<{ accountId: string; raw: unknown }> {
    const location = await this.location(), component = await lstat(this.options.component);
    if (component.size > 64 * 1024 * 1024) throw failure();
    const signature = [component.dev, component.ino, component.size, component.mtimeMs].join(':');
    if (!this.key || this.key.signature !== signature || this.key.accountId !== location.accountId) {
      this.key = null;
      const buffer = await readFile(this.options.component);
      let candidates: string[];
      try { candidates = dchatKeyCandidates(buffer); } finally { buffer.fill(0); }
      const deadline = Date.now() + 10_000;
      for (const value of candidates) {
        if (signal?.aborted || Date.now() >= deadline) throw failure();
        try {
          const raw = await this.query({ executable: this.options.executable, database: location.database,
            key: value, sql: schemaSql, signal, timeoutMs: Math.min(2000, deadline - Date.now()) });
          if (schemaValid(raw)) { this.key = { accountId: location.accountId, signature, value }; break; }
        } catch { if (signal?.aborted) throw failure(); }
      }
      if (!this.key) throw failure();
    }
    const raw = await this.query({ executable: this.options.executable, database: location.database, key: this.key.value, sql, signal });
    if ((await this.identity()).accountId !== location.accountId || signal?.aborted) { this.dispose(); throw new Error('DCHAT_ACCOUNT_CHANGED'); }
    return { accountId: location.accountId, raw };
  }
  async page(chatId: string, anchor?: string, signal?: AbortSignal, includeAnchor = false): Promise<DchatReadPage> {
    if (!id(chatId) || (anchor !== undefined && (!anchor || anchor.length > 2048 || Array.from(anchor).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)))) throw failure();
    const chat = quote(chatId), key = anchor === undefined ? null : quote(anchor);
    const columns = "'messageId',key,'sequence',vchannel_seq,'previousId',prev_msg_key,'senderId',uid,'robotId',robot_id,'text',text,'content',content,'timestamp',CAST(created_ts AS TEXT),'senderKnown',EXISTS(SELECT 1 FROM users WHERE users.id=cached.uid),'senderName',(SELECT name FROM users WHERE users.id=cached.uid)";
    const records = (where: string, order: string, limit: number) => 'json((SELECT json_group_array(json_object(' + columns
      + ')) FROM (SELECT * FROM messages WHERE vchannel_id=' + chat + where + ' ORDER BY created_ts ' + order
      + ',CAST(vchannel_seq AS INTEGER) ' + order + ',key LIMIT ' + limit + ') AS cached))';
    const sql = "BEGIN DEFERRED; SELECT json_object('chat',json((SELECT json_group_array(json_object('id',id,'kind',type,'peerId',target_id,'left',is_left,'dissolved',is_dissolve,'kicked',is_kickout)) FROM vchannels WHERE id="
      + chat + ")), 'parent',json((SELECT json_group_array(s.primary_vchannel_id) FROM sub_channels s JOIN vchannels p ON p.id=s.primary_vchannel_id AND p.type IN ('channel','extchannel') AND p.is_left=0 AND p.is_dissolve=0 AND p.is_kickout=0 WHERE s.vchannel_id=" + chat
      + ")), 'anchor'," + (key ? records(' AND key=' + key, 'ASC', 1) : "json('[]')")
      + ", 'messages'," + records(key ? ' AND CAST(vchannel_seq AS INTEGER) > (SELECT CAST(vchannel_seq AS INTEGER) FROM messages WHERE vchannel_id=' + chat + ' AND key=' + key + ')' : '', key ? 'ASC' : 'DESC', 51) + '); COMMIT;';
    const { accountId, raw } = await this.run(sql, signal);
    if (includeAnchor) {
      const payload = raw as { anchor?: unknown; messages?: unknown };
      return decodeDchatPage({ ...(raw as object), messages: payload.anchor, anchor: [] }, accountId, chatId);
    }
    return decodeDchatPage(raw, accountId, chatId, anchor);
  }
}
/** Validate every row before exposing a page. A cached window is never continuity proof. */
export function decodeDchatPage(raw: unknown, accountId: string, chatId: string, anchor?: string): DchatReadPage {
  const value = raw as { chat?: Array<Record<string, unknown>>; parent?: unknown[]; anchor?: Array<Record<string, unknown>>; messages?: Array<Record<string, unknown>> };
  if (!value || !Array.isArray(value.chat) || value.chat.length !== 1 || !Array.isArray(value.parent)
    || !Array.isArray(value.anchor) || !Array.isArray(value.messages) || value.messages.length > 51) throw failure();
  const chat = value.chat[0]!;
  if (chat.id !== chatId || !['left', 'dissolved', 'kicked'].every(k => chat[k] === 0 || chat[k] === false)
    || !['p2p', 'extp2p', 'channel', 'extchannel', 'subchannel'].includes(String(chat.kind))) throw new Error('DCHAT_MEMBERSHIP_UNAVAILABLE');
  if (anchor && (value.anchor.length !== 1 || value.anchor[0]?.messageId !== anchor)) throw new Error('DCHAT_HISTORY_GAP');
  const sequence = (v: unknown): string => {
    if (typeof v !== 'string' || !/^\d+(?:\.0+)?$/.test(v)) throw failure();
    return BigInt(v.replace(/\.0+$/, '')).toString();
  };
  const rows = [...value.messages];
  if (!anchor) rows.reverse();
  const hasMore = rows.length > 50;
  if (hasMore) { if (anchor) rows.pop(); else rows.shift(); }
  const seen = new Set<string>();
  let previous = anchor ? value.anchor[0]! : null;
  const messages = rows.map(row => {
    if (typeof row.messageId !== 'string' || !row.messageId || row.messageId.length > 2048 || seen.has(row.messageId)
      || !/^([0-9]+)$/.test(String(row.timestamp))
      || typeof row.text !== 'string' || row.text.length > 100_000 || typeof row.previousId !== 'string') throw failure();
    seen.add(row.messageId);
    const seq = sequence(row.sequence);
    if (previous && (BigInt(seq) !== BigInt(sequence(previous.sequence)) + 1n || row.previousId !== previous.messageId
      || !/^\d+$/.test(String(row.timestamp)) || BigInt(String(row.timestamp)) < BigInt(String(previous.timestamp)))) throw new Error('DCHAT_HISTORY_GAP');
    previous = row;
    const content = typeof row.content === 'string' && row.content ? parse(row.content) as Record<string, unknown> : {};
    if (!content || typeof content !== 'object' || Array.isArray(content)) throw failure();
    const author = content.author as { id?: unknown; type?: unknown } | undefined;
    if (!id(row.senderId) || row.senderKnown !== 1 || (row.robotId !== '' && row.robotId !== null && row.robotId !== undefined)
      || (author && (author.id !== row.senderId || author.type !== 'user'))) return null;
    const mentions = Array.isArray(content.mentions) ? content.mentions : [];
    const invoked = mentions.some((mention: unknown) => {
      const m = mention as { uid?: unknown; user_type?: unknown } | null;
      return m?.uid === accountId && m.user_type === 'User';
    });
    return { accountId, chatId, messageId: row.messageId, senderId: row.senderId, senderName: typeof row.senderName === 'string' ? row.senderName.slice(0, 256) : row.senderId,
      text: row.text, sequence: seq, previousId: row.previousId, sentBySelf: row.senderId === accountId, invoked };
  });
  const parentId = value.parent.length === 1 && id(value.parent[0]) ? value.parent[0] : '';
  if (chat.kind === 'subchannel' && !parentId) throw new Error('DCHAT_MEMBERSHIP_UNAVAILABLE');
  return { accountId, chatId, peerId: id(chat.peerId) ? chat.peerId : '', kind: String(chat.kind), parentId,
    messages: messages.filter((m): m is NonNullable<typeof m> => m !== null), cursor: typeof rows.at(-1)?.messageId === 'string' ? rows.at(-1)!.messageId as string : anchor ?? null, hasMore, continuous: anchor !== undefined };
}
