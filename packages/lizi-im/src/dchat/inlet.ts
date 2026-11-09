import type { DchatIM } from './index.js';
import { parseDchatConfig, type DchatConfig, type DchatChat } from './config.js';
import type { DchatReadPage } from './sqlcipher.js';

export interface DchatCursorStorage {
  read(): unknown;
  write(value: { version: 1; accountId: string; cursors: Record<string, string> }): void;
}
export interface DchatPageReader {
  identity(): Promise<{ accountId: string }>;
  page(chatId: string, anchor?: string, signal?: AbortSignal, includeAnchor?: boolean): Promise<DchatReadPage>;
  dispose(): void;
}
/** Native inlet: bounded non-overlapping reads, separate history baselining and execution,
 * account checks at both boundaries, and content-free durable cursors. No historical
 * execution on initial enable, no fallback across gaps or to another account. */
export class DchatNativeInlet {
  private stopped = true;
  private readonly config: DchatConfig;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> | null = null;
  private cursors: Record<string, string> = Object.create(null) as Record<string, string>;
  constructor(config: unknown, private readonly deps: {
    reader: DchatPageReader; im: DchatIM; storage: DchatCursorStorage;
    current(): boolean; onError(code: string): void;
  }) { this.config = parseDchatConfig(config); }
  private current(): boolean { return !this.stopped && this.deps.current(); }
  private async verify(): Promise<void> {
    if (!this.current() || (await this.deps.reader.identity()).accountId !== this.config.accountId || !this.current()) throw new Error('DCHAT_ACCOUNT_CHANGED');
  }
  private proof(chat: DchatChat, page: DchatReadPage): void {
    if (page.accountId !== this.config.accountId || page.chatId !== chat.id) throw new Error('DCHAT_ACCOUNT_CHANGED');
    if ((chat.kind === 'owner-dm' || chat.kind === 'guest-dm') && (!['p2p', 'extp2p'].includes(page.kind) || page.peerId !== chat.peerId)) throw new Error('DCHAT_PEER_UNVERIFIED');
    if (chat.kind === 'group' && !['channel', 'extchannel'].includes(page.kind)) throw new Error('DCHAT_MEMBERSHIP_UNAVAILABLE');
    if (chat.kind === 'topic' && (page.kind !== 'subchannel' || page.parentId !== chat.parentId)) throw new Error('DCHAT_MEMBERSHIP_UNAVAILABLE');
  }
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false; this.abort = new AbortController();
    try {
      await this.verify();
      const raw = this.deps.storage.read() as { version?: unknown; accountId?: unknown; cursors?: unknown } | null;
      if (raw !== null && raw !== undefined) {
        if (raw.version !== 1 || raw.accountId !== this.config.accountId || !raw.cursors || typeof raw.cursors !== 'object' || Array.isArray(raw.cursors)) throw new Error('DCHAT_CURSOR_INVALID');
        for (const [chat, cursor] of Object.entries(raw.cursors)) {
          if (!this.config.chats.some(c => c.id === chat)) continue;
          if (typeof cursor !== 'string' || !cursor || cursor.length > 2048 || Array.from(cursor).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error('DCHAT_CURSOR_INVALID');
          this.cursors[chat] = cursor;
        }
      }
      // Only queued records that never entered Session.send are eligible to reload.
      for (const receipt of this.deps.im.queuedInputs()) {
        const chat = this.config.chats.find(c => c.id === receipt.destination.chatId);
        if (!chat || receipt.destination.botId !== this.config.botId || receipt.destination.accountId !== this.config.accountId) throw new Error('DCHAT_STALE_INPUT');
        const page = await this.deps.reader.page(chat.id, receipt.messageId, this.abort.signal, true);
        this.proof(chat, page); await this.verify();
        const message = page.messages.find(m => m.messageId === receipt.messageId);
        if (!message) throw new Error('DCHAT_HISTORY_GAP');
        await this.deps.im.receive(message);
      }
      const first = this.pollOnce(); this.pending = first;
      try { await first; } finally { if (this.pending === first) this.pending = null; }
      this.schedule();
    } catch (error) { await this.stop(); throw error; }
  }
  private schedule(): void {
    if (!this.current()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pending = this.pollOnce().then(() => this.schedule()).catch(() => {
        // Do not log SQL, bodies, IDs, keys or raw child errors.
        this.deps.onError('DCHAT_NATIVE_INLET_STOPPED'); void this.stop();
      }).finally(() => { this.pending = null; });
    }, 2000);
  }
  async pollOnce(): Promise<void> {
    await this.verify();
    for (const chat of this.config.chats) {
      const cursor = this.cursors[chat.id];
      const page = await this.deps.reader.page(chat.id, cursor, this.abort?.signal);
      this.proof(chat, page); await this.verify();
      if (cursor) {
        if (!page.continuous) throw new Error('DCHAT_HISTORY_GAP');
        for (const message of page.messages) {
          await this.verify(); await this.deps.im.receive(message);
        }
      }
      if (!cursor) {
        // Baseline history feeds the shared context window, never the executor.
        for (const message of page.messages) { await this.verify(); await this.deps.im.recordContext(message); }
      }
      // A first cached page establishes a baseline, never an automatic trigger.
      await this.verify();
      if (!this.current()) throw new Error('DCHAT_ACCOUNT_CHANGED');
      if (page.cursor) {
        this.cursors[chat.id] = page.cursor;
        this.deps.storage.write({ version: 1, accountId: this.config.accountId, cursors: { ...this.cursors } });
      }
    }
  }
  /** Synchronous ingress closure before awaiting any account-scoped work. */
  async stop(): Promise<void> {
    this.stopped = true; this.abort?.abort(); this.abort = null;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    const pending = this.pending;
    this.deps.reader.dispose(); await this.deps.im.dispose();
    // Account teardown waits for this inlet's context/DB work to drain before
    // the host replaces the owner DB. The timer error path does not await stop.
    await pending?.catch(() => {});
  }
}
