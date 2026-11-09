import { BaseIM } from '../BaseIM.js';
import type { ImFinalOutput, TextChannelIM } from '../channelIM.js';
import type { IMHost, IMMessageEvent, IMStatus, SendFileResult } from '../types.js';
import { DchatTransport, type DchatDispatch, type DchatInbound, type DchatNative } from './transport.js';
import { parseDchatConfig, type DchatConfig } from './config.js';
import type { DchatLedgerStorage } from './ledger.js';
export { parseDchatConfig } from './config.js';
export type { DchatConfig, DchatChat } from './config.js';
export type { DchatInbound, DchatNative } from './transport.js';
export type { DchatLedgerStorage } from './ledger.js';

export interface DchatIMOptions {
  config: DchatConfig; native: DchatNative; storage: DchatLedgerStorage;
  current?(): boolean;
  bindingAvailable(botId: string): Promise<boolean>;
  draft(input: { requestKey: string; chatId: string; text: string }): Promise<void>;
}
/** Desktop transport facade for the existing IM orchestrator. No polling until a native reader is installed. */
export class DchatIM extends BaseIM implements TextChannelIM {
  private status: IMStatus = { kind: 'idle' };
  private readonly messages = new Set<(event: IMMessageEvent) => void>();
  private readonly statuses = new Set<(status: IMStatus) => void>();
  private readonly queued = new Map<string, DchatDispatch[]>();
  private readonly active = new Map<string, DchatDispatch>();
  private readonly byMessage = new Map<string, DchatDispatch>();
  private transport: DchatTransport | null = null;
  private account: unknown | null = null;
  private generation = 0;
  constructor(host: IMHost, private readonly options: DchatIMOptions) {
    super('dchat', host);
    this.options = { ...options, config: parseDchatConfig(options.config) };
  }
  get botContextId(): string { return this.options.config.connectionId; }
  getStatus(): IMStatus { return this.status; }
  onStatusChange(callback: (status: IMStatus) => void): () => void { this.statuses.add(callback); return () => this.statuses.delete(callback); }
  onMessage(callback: (event: IMMessageEvent) => void): () => void { this.messages.add(callback); return () => this.messages.delete(callback); }
  registerIpc(): void { /* Host owns trusted connection configuration. */ }
  private setStatus(status: IMStatus): void { this.status = status; for (const callback of this.statuses) callback(status); }
  private current(generation: number): boolean {
    return this.generation === generation && (!this.host.accountScope || (this.account !== null && this.host.accountScope.isCurrent(this.account)));
  }
  async init(): Promise<void> {
    await this.dispose(); const generation = ++this.generation;
    this.account = this.host.accountScope?.capture() ?? null; this.setStatus({ kind: 'connecting' });
    try {
      const identity = await this.options.native.identity();
      if (!this.current(generation) || identity.accountId !== this.options.config.accountId || !await this.options.bindingAvailable(this.options.config.botId)) throw new Error('unavailable');
      if (!this.current(generation)) return;
      this.transport = new DchatTransport(this.options.config, { ...this.options, dispatch: value => this.dispatch(value),
        current: () => this.current(generation) && this.options.current?.() !== false,
        bindingAvailable: async botId => this.current(generation) && await this.options.bindingAvailable(botId) && this.current(generation),
        draft: input => this.options.draft({ requestKey: input.requestKey, chatId: input.destination.chatId, text: input.text }) });
      this.setStatus({ kind: 'connected', appId: this.botContextId });
    } catch { if (this.current(generation)) this.setStatus({ kind: 'error', reason: 'DCHAT_CONNECTION_UNAVAILABLE' }); }
  }
  async dispose(): Promise<void> {
    this.generation++; this.transport?.disable(); this.transport = null; this.active.clear(); this.byMessage.clear(); this.queued.clear();
    this.setStatus({ kind: 'idle' });
  }
  async receive(input: DchatInbound): Promise<string> {
    if (!this.transport || !this.current(this.generation)) throw new Error('DCHAT_CONNECTION_UNAVAILABLE');
    return this.transport.receive(input);
  }
  private async dispatch(value: DchatDispatch): Promise<void> {
    if (!value.isCurrent() || !this.current(this.generation) || !this.messages.size) throw new Error('DCHAT_RUNNER_UNAVAILABLE');
    if (!await this.transport?.canDispatch(value) || !value.isCurrent() || !this.current(this.generation)) throw new Error('DCHAT_STALE_INPUT');
    const lane = this.laneId(value.chat.id);
    const control = value.requesterIsOwner && value.inbound.text.trim() === '/stop';
    // Queue only inputs that have never crossed the shared runner. Durable state
    // holds IDs, not bodies; restart reloads the exact message through the reader.
    if (this.active.has(lane) && !control) {
      const queue = this.queued.get(lane) ?? [];
      if (queue.length >= 100) throw new Error('DCHAT_QUEUE_FULL');
      this.transport!.ledger.transition(value.receipt.requestKey, value.receipt.generation, 'queued');
      queue.push(value); this.queued.set(lane, queue); return;
    }
    if (!control) { this.active.set(lane, value); this.byMessage.set(value.receipt.requestKey, value); }
    else {
      // Trusted owner stop goes straight to the existing shared command handler;
      // it cannot take the running input's destination or become an output anchor.
      const queue = this.queued.get(lane) ?? []; this.queued.delete(lane);
      for (const pending of queue) this.transport?.ledger.transition(pending.receipt.requestKey, pending.receipt.generation, 'aborted');
      this.transport?.finish(value.receipt.requestKey, value.receipt.generation, 'done');
    }
    const event: IMMessageEvent = { channelName: 'dchat', senderId: lane, chatId: value.chat.id, contextId: this.botContextId,
      messageId: value.receipt.requestKey, text: value.inbound.text, attachments: [], unsupported: [],
      invoked: value.inbound.invoked, speaker: { id: value.inbound.senderId, name: value.inbound.senderName, isOwner: value.requesterIsOwner },
      delivery: { awaitPersistence: () => {}, accept: () => this.rejectWithoutExecution(value), defer: () => { /* interrupted admission stays uncertain; no replay */ } } };
    for (const callback of this.messages) callback(event);
  }
  private rejectWithoutExecution(value: DchatDispatch): void {
    if (['reserved', 'queued'].includes(this.transport?.ledger.read(value.receipt.requestKey)?.state ?? '')) {
      this.transport?.finish(value.receipt.requestKey, value.receipt.generation, 'done');
      this.release(this.laneId(value.chat.id), value.receipt.requestKey);
    }
  }
  private accept(value: DchatDispatch): void {
    if (['reserved', 'queued'].includes(this.transport?.ledger.read(value.receipt.requestKey)?.state ?? '')) this.transport?.acknowledge(value.receipt.requestKey, value.receipt.generation);
  }
  acknowledgeIncoming(messageId: string, sessionId?: string, clientId?: string): void {
    const value = this.byMessage.get(messageId);
    if (value) {
      if (sessionId && clientId) this.transport!.ledger.bindExecution(value.receipt.requestKey, value.receipt.generation, sessionId, clientId);
      this.accept(value);
    }
  }
  queuedInputs() { return this.transport?.ledger.queued() ?? []; }
  private release(lane: string, messageId: string): void {
    this.active.delete(lane); this.byMessage.delete(messageId);
    const queue = this.queued.get(lane); const next = queue?.shift();
    if (!queue?.length) this.queued.delete(lane);
    if (next && next.isCurrent()) {
      void this.dispatch(next).catch(() => {
        const row = this.transport?.ledger.read(next.receipt.requestKey);
        if (row && ['reserved', 'queued'].includes(row.state)) this.transport?.ledger.transition(row.requestKey, row.generation, 'unknown');
        this.release(lane, next.receipt.requestKey);
      });
    }
  }
  laneId(chatId: string): string { return Buffer.from(JSON.stringify([this.botContextId, chatId])).toString('base64url'); }
  chatForLane(lane: string) { return this.options.config.chats.find(chat => this.laneId(chat.id) === lane); }
  async commitFinal(output: ImFinalOutput): Promise<void> {
    const value = this.active.get(output.userId);
    if (!value || output.inputMessageId !== value.receipt.requestKey || !this.transport || !this.current(this.generation)) throw new Error('DCHAT_STALE_OUTPUT');
    try {
      await this.transport.final(value.receipt.requestKey, value.receipt.generation, 'terminal', output.text);
      this.transport?.finish(value.receipt.requestKey, value.receipt.generation, output.terminal);
    } finally { this.release(output.userId, value.receipt.requestKey); }
  }
  // Arbitrary side-channel text is deliberately unavailable: all model output
  // must have a durable input and destination. Approvals stay in Cindy.
  async sendText(_userId: string, _text: string): Promise<{ messageId: string }> { void _userId; void _text; throw new Error('DCHAT_USE_BOUND_FINAL_OUTPUT'); }
  async sendMarkdownText(userId: string, text: string): Promise<{ messageId: string }> { return this.sendText(userId, text); }
  async sendFile(_userId: string, _absPath: string, _displayName?: string): Promise<SendFileResult> { void _userId; void _absPath; void _displayName; return { ok: false, reason: 'SEND_FAIL' }; }
}
