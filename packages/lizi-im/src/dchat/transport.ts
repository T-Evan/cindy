import { randomUUID } from 'node:crypto';
import { DchatLedger, type DchatDestination, type DchatReceipt, type DchatLedgerStorage } from './ledger.js';
import { parseDchatConfig, type DchatChat, type DchatConfig } from './config.js';

export interface DchatInbound {
  messageId: string; accountId: string; chatId: string; senderId: string;
  automationSource?: string;
  text: string; sentAt?: number; senderName: string; sentBySelf: boolean; invoked: boolean;
}
/** Native platform adapter owns read-only database access and local IPC. No agent runtime here. */
export interface DchatNative {
  identity(): Promise<{ accountId: string }>;
  capabilities(): Promise<string[]>;
  members?(chatId: string): Promise<{ accountId: string; chatId: string; memberIds: string[] }>;
  send(input: { accountId: string; chatId: string; text: string; requestId: string; mode?: 'attributed' | 'clean-v2' }, options?: { isCurrent(): boolean }): Promise<{ messageId: string }>;
}
export interface DchatDispatch {
  receipt: DchatReceipt; chat: DchatChat; inbound: DchatInbound; requesterIsOwner: boolean;
  isCurrent(): boolean;
}
export interface DchatTransportDeps {
  native: DchatNative; storage: DchatLedgerStorage;
  authorizationKey?: string;
  requireLiveMembership?: boolean;
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
  async receive(input: DchatInbound, contextOnly = false): Promise<'ignored' | 'context' | 'duplicate' | 'dispatched'> {
    const generation = this.generation;
    if (!this.enabled || input.accountId !== this.config.accountId || !valid(input.messageId) || !valid(input.senderId)
      || typeof input.text !== 'string' || input.text.length > 100_000 || typeof input.senderName !== 'string'
      || typeof input.sentBySelf !== 'boolean' || typeof input.invoked !== 'boolean') return 'ignored';
    const chat = this.config.chats.find(c => c.id === input.chatId);
    if (!chat || ((input.senderId !== input.accountId) && (chat.kind === 'owner-dm' || chat.kind === 'guest-dm') && chat.peerId !== input.senderId)) return 'ignored';
    if (!await this.live(generation)) throw new Error('DCHAT_BINDING_UNAVAILABLE');
    await this.deps.context?.(input);
    const own = input.senderId === this.config.accountId;
    const prefix = '/cindy ' + this.config.botId + ' ';
    const control = own && this.config.ownerId === this.config.accountId && chat.id === this.config.controlChatId
      && !input.automationSource && !input.text.trimEnd().endsWith('— Cindy') && input.text.startsWith(prefix) && input.text.slice(prefix.length).trim().length > 0;
    // The authenticated account must deliberately address this exact bot in its
    // Main-selected control chat. Stock automation/ordinary own messages cannot loop.
    if ((input.sentBySelf || own) && !control) return 'ignored';
    if (contextOnly || !this.config.executeChatIds?.includes(chat.id) || ((chat.kind === 'group' || chat.kind === 'topic') && !input.invoked && !control)) {
      return 'context';
    }
    await this.verifyMembership(chat, input.senderId, generation);
    const destination: DchatDestination = { accountId: this.config.accountId, connectionId: this.config.connectionId,
      botId: this.config.botId, chatId: chat.id, topicId: chat.kind === 'topic' ? chat.id : '' };
    const receipt = this.ledger.reserve(input.messageId, destination, generation, this.deps.authorizationKey);
    if (!receipt) return 'duplicate';
    // A received body is never evidence of owner authority.
    try {
      if (!await this.live(generation)) throw new Error('DCHAT_BINDING_UNAVAILABLE');
      await this.deps.dispatch({ receipt, chat, inbound: control ? { ...input, text: input.text.slice(prefix.length).trim(), invoked: true } : input, requesterIsOwner: control,
        isCurrent: () => this.enabled && this.generation === generation && this.deps.current?.() !== false });
      return 'dispatched';
    } catch (error) {
      const row = this.ledger.read(receipt.requestKey);
      if (row && (row.state === 'reserved' || row.state === 'accepted')) this.ledger.transition(receipt.requestKey, generation, 'unknown');
      throw error;
    }
  }
  private async verifyMembership(chat: DchatChat, senderId: string, generation: string): Promise<void> {
    if (!this.deps.requireLiveMembership || !['group', 'topic'].includes(chat.kind)) return;
    const target = chat.parentId ?? chat.id;
    const members = await this.deps.native.members?.(target);
    if (!members || members.accountId !== this.config.accountId || members.chatId !== target
      || !members.memberIds.includes(this.config.accountId) || !members.memberIds.includes(senderId)) throw new Error('DCHAT_MEMBERSHIP_UNAVAILABLE');
    if (!await this.live(generation)) throw new Error('DCHAT_BINDING_UNAVAILABLE');
  }
  async canDispatch(value: DchatDispatch): Promise<boolean> {
    await this.verifyMembership(value.chat, value.inbound.senderId, value.receipt.generation);
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
  /** Resume only content-free terminal notifications that were durably observed.
   * Never polls companion history/reply or replays an input. An attempted output,
   * including a successful final, permanently excludes the fallback notification. */
  async recoverTerminalNotifications(): Promise<void> {
    const generation = this.generation;
    for (const candidate of this.ledger.executionInputs()) {
      if (!await this.live(generation)) throw new Error('DCHAT_BINDING_UNAVAILABLE');
      if (candidate.authorizationKey !== this.deps.authorizationKey) continue;
      const d = candidate.destination;
      if (d.accountId !== this.config.accountId || d.connectionId !== this.config.connectionId || d.botId !== this.config.botId
        || !this.config.executeChatIds?.includes(d.chatId)
        || !this.config.chats.some(c => c.id === d.chatId && (c.kind === 'topic' ? c.id : '') === d.topicId)) continue;
      await this.verifyMembership(this.config.chats.find(c => c.id === d.chatId)!, this.config.accountId, generation);
      const row = this.ledger.claimTerminalNotification(candidate.requestKey); if (!row) continue;
      if (this.config.replyMode !== 'automatic') { this.ledger.transition(row.requestKey, row.generation, row.nativeTerminal!); continue; }
      if (!(await this.deps.native.capabilities()).includes(this.config.sendMode === 'clean-v2' ? 'dchat_im_clean_send_v2' : 'content')) throw new Error('DCHAT_SEND_UNAVAILABLE');
      if (!await this.live(generation)) throw new Error('DCHAT_BINDING_UNAVAILABLE');
      const text = row.nativeTerminal === 'done' ? 'Cindy 任务已完成，请在 Cindy 查看结果。' : row.nativeTerminal === 'aborted' ? 'Cindy 任务已停止，请在 Cindy 查看详情。' : 'Cindy 任务未完成，请在 Cindy 查看详情。';
      await this.ledger.deliver(row.requestKey, row.generation, row.destination, 'terminal', () => this.deps.native.send({
        accountId: d.accountId, chatId: d.chatId, text, requestId: randomUUID(), mode: this.config.sendMode },
        { isCurrent: () => this.enabled && this.generation === generation && this.deps.current?.() !== false }),
        () => this.enabled && this.generation === generation && this.deps.current?.() !== false);
      this.ledger.transition(row.requestKey, row.generation, row.nativeTerminal!);
    }
  }
  async final(requestKey: string, generation: string, outputId: string, text: string): Promise<void> {
    const row = this.ledger.read(requestKey);
    if (!row || row.generation !== generation || row.state !== 'accepted' || !await this.live(generation)) throw new Error('DCHAT_STALE_OUTPUT');
    if (!text.trim() || text.trim() === 'NO_REPLY') return;
    const chat = this.config.chats.find(c => c.id === row.destination.chatId);
    if (!chat) throw new Error('DCHAT_STALE_OUTPUT');
    await this.verifyMembership(chat, this.config.accountId, generation);
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
