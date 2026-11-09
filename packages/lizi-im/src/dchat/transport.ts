import { randomUUID } from 'node:crypto';
import { DchatLedger, type DchatDestination, type DchatReceipt, type DchatLedgerStorage } from './ledger.js';
import { parseDchatConfig, type DchatChat, type DchatConfig } from './config.js';

export interface DchatInbound {
  messageId: string; accountId: string; chatId: string; senderId: string;
  text: string; senderName: string; sentBySelf: boolean; invoked: boolean;
}
/** Native platform adapter owns read-only database access and local IPC. No agent runtime here. */
export interface DchatNative {
  identity(): Promise<{ accountId: string }>;
  capabilities(): Promise<string[]>;
  send(input: { accountId: string; chatId: string; text: string; requestId: string; mode?: 'attributed' | 'clean-v2' }, options?: { isCurrent(): boolean }): Promise<{ messageId: string }>;
}
export interface DchatDispatch {
  receipt: DchatReceipt; chat: DchatChat; inbound: DchatInbound; requesterIsOwner: boolean;
  isCurrent(): boolean;
}
export interface DchatTransportDeps {
  native: DchatNative; storage: DchatLedgerStorage;
  current?(): boolean;
  bindingAvailable(botId: string): Promise<boolean>;
  /** Call existing Cindy IM orchestration, never create a replacement agent. */
  dispatch(input: DchatDispatch): Promise<void>;
  context?(input: DchatInbound): Promise<void>;
  draft?(input: { requestKey: string; destination: DchatDestination; text: string }): Promise<void>;
}
const valid = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

/** Lifecycle/receipts only; execution and permissions remain in Cindy's shared runner. */
export class DchatTransport {
  readonly ledger: DchatLedger;
  readonly config: DchatConfig;
  private generation = randomUUID();
  private enabled = true;
  constructor(config: unknown, private readonly deps: DchatTransportDeps) {
    this.config = parseDchatConfig(config); this.ledger = new DchatLedger(deps.storage);
  }
  disable(): void { this.enabled = false; this.generation = randomUUID(); }
  private async live(generation: string): Promise<boolean> {
    if (!this.enabled || this.generation !== generation || this.deps.current?.() === false) return false;
    const identity = await this.deps.native.identity();
    if (!this.enabled || this.generation !== generation || identity.accountId !== this.config.accountId) return false;
    const available = await this.deps.bindingAvailable(this.config.botId);
    return available && this.enabled && this.generation === generation && this.deps.current?.() !== false;
  }
  async receive(input: DchatInbound): Promise<'ignored' | 'context' | 'duplicate' | 'dispatched'> {
    const generation = this.generation;
    if (!this.enabled || input.accountId !== this.config.accountId || !valid(input.messageId) || !valid(input.senderId)
      || typeof input.text !== 'string' || input.text.length > 100_000 || typeof input.senderName !== 'string'
      || typeof input.sentBySelf !== 'boolean' || typeof input.invoked !== 'boolean') return 'ignored';
    // Transport-confirmed self identity and sender identity both guard loops.
    if (input.sentBySelf || input.senderId === input.accountId) return 'ignored';
    const chat = this.config.chats.find(c => c.id === input.chatId);
    if (!chat || ((chat.kind === 'owner-dm' || chat.kind === 'guest-dm') && chat.peerId !== input.senderId)) return 'ignored';
    if (!await this.live(generation)) throw new Error('DCHAT_BINDING_UNAVAILABLE');
    if (!this.config.executeChatIds?.includes(chat.id) || ((chat.kind === 'group' || chat.kind === 'topic') && !input.invoked)) {
      await this.deps.context?.(input); return 'context';
    }
    const destination: DchatDestination = { accountId: this.config.accountId, connectionId: this.config.connectionId,
      botId: this.config.botId, chatId: chat.id, topicId: chat.kind === 'topic' ? chat.id : '' };
    const receipt = this.ledger.reserve(input.messageId, destination, generation);
    if (!receipt) return 'duplicate';
    // A received body is never evidence of owner authority.
    try {
      if (!await this.live(generation)) throw new Error('DCHAT_BINDING_UNAVAILABLE');
      await this.deps.dispatch({ receipt, chat, inbound: input, requesterIsOwner: input.senderId === this.config.ownerId,
        isCurrent: () => this.enabled && this.generation === generation && this.deps.current?.() !== false });
      return 'dispatched';
    } catch (error) {
      const row = this.ledger.read(receipt.requestKey);
      if (row && (row.state === 'reserved' || row.state === 'accepted')) this.ledger.transition(receipt.requestKey, generation, 'unknown');
      throw error;
    }
  }
  async canDispatch(value: DchatDispatch): Promise<boolean> {
    const row = this.ledger.read(value.receipt.requestKey);
    return !!row && ['reserved', 'queued'].includes(row.state) && row.generation === value.receipt.generation
      && await this.live(value.receipt.generation);
  }
  acknowledge(requestKey: string, generation: string): void {
    if (!this.enabled || this.generation !== generation) throw new Error('DCHAT_STALE_INPUT');
    this.ledger.transition(requestKey, generation, 'accepted');
  }
  finish(requestKey: string, generation: string, state: 'done' | 'aborted' | 'error'): void {
    this.ledger.transition(requestKey, generation, state);
  }
  async final(requestKey: string, generation: string, outputId: string, text: string): Promise<void> {
    const row = this.ledger.read(requestKey);
    if (!row || row.generation !== generation || row.state !== 'accepted' || !await this.live(generation)) throw new Error('DCHAT_STALE_OUTPUT');
    if (!text.trim() || text.trim() === 'NO_REPLY') return;
    if (this.config.replyMode !== 'automatic') {
      if (!this.deps.draft) throw new Error('DCHAT_DRAFT_UNAVAILABLE');
      await this.deps.draft({ requestKey, destination: row.destination, text }); return;
    }
    const features = await this.deps.native.capabilities();
    const clean = this.config.sendMode === 'clean-v2';
    if (!features.includes(clean ? 'dchat_im_clean_send_v2' : 'content')) throw new Error(clean ? 'DCHAT_CLEAN_SEND_UNAVAILABLE' : 'DCHAT_ATTRIBUTED_SEND_UNAVAILABLE');
    if (!await this.live(generation)) throw new Error('DCHAT_STALE_OUTPUT');
    // ledger rejects changes to the immutable destination and uncertain sends.
    await this.ledger.deliver(requestKey, generation, row.destination, outputId, () =>
      this.deps.native.send({ accountId: row.destination.accountId, chatId: row.destination.chatId, text, requestId: randomUUID(), mode: this.config.sendMode },
        { isCurrent: () => this.enabled && this.generation === generation && this.deps.current?.() !== false }),
    () => this.enabled && this.generation === generation);
  }
}
