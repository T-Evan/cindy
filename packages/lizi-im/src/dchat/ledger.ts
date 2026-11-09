/** Durable, content-free D-Chat receipts. Hosts own private, atomic storage. */
import { createHash } from 'node:crypto';

export interface DchatDestination {
  accountId: string; connectionId: string; botId: string; chatId: string; topicId: string;
}
export type DchatInputState = 'reserved' | 'queued' | 'accepted' | 'done' | 'aborted' | 'error' | 'unknown';
export interface DchatReceipt {
  requestKey: string; messageId: string; destination: DchatDestination;
  generation: string; state: DchatInputState;
  /** Stable host configuration lease; absent legacy receipts cannot claim a new lease. */
  authorizationKey?: string;
  execution?: { sessionId: string; clientId: string; instanceId?: string; turnGeneration?: number };
  nativeTerminal?: 'done' | 'error' | 'aborted';
  recovery?: { status: 'interrupted' | 'reserved' | 'running'; sourceClientId?: string };
  outputs: Record<string, { state: 'sending' | 'sent' | 'unknown'; messageId?: string }>;
}
export interface DchatLedgerStorage {
  read(): unknown;
  /** Must return only after an atomic, private durable write. Never merge across owners. */
  write(value: { version: 1; receipts: DchatReceipt[] }): void;
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a: DchatDestination, b: DchatDestination): boolean =>
  a.accountId === b.accountId && a.connectionId === b.connectionId && a.botId === b.botId
  && a.chatId === b.chatId && a.topicId === b.topicId;
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}
function validReceipt(value: unknown): value is DchatReceipt {
  if (!value || typeof value !== 'object') return false;
  const r = value as DchatReceipt;
  return (r.authorizationKey === undefined || validId(r.authorizationKey)) && validId(r.requestKey) && validId(r.messageId) && validId(r.generation)
    && ['reserved', 'queued', 'accepted', 'done', 'aborted', 'error', 'unknown'].includes(r.state)
    && !!r.destination && ['accountId', 'connectionId', 'botId', 'chatId'].every(k => validId(r.destination[k as keyof DchatDestination]))
    && typeof r.destination.topicId === 'string' && r.destination.topicId.length <= 2048
    && (r.execution === undefined || (!!r.execution && validId(r.execution.sessionId) && validId(r.execution.clientId)))
    && (r.recovery === undefined || (!!r.recovery && ['interrupted', 'reserved', 'running'].includes(r.recovery.status) && (r.recovery.sourceClientId === undefined || validId(r.recovery.sourceClientId))))
    && (r.nativeTerminal === undefined || ['done', 'error', 'aborted'].includes(r.nativeTerminal))
    && (r.execution?.instanceId === undefined || (validId(r.execution.instanceId) && Number.isSafeInteger(r.execution.turnGeneration) && r.execution.turnGeneration! > 0))
    && !!r.outputs && typeof r.outputs === 'object' && !Array.isArray(r.outputs)
    && Object.entries(r.outputs).every(([k, o]) => /^[a-f0-9]{64}$/.test(k) && !!o && ['sending', 'sent', 'unknown'].includes(o.state)
      && (o.messageId === undefined || validId(o.messageId)));
}

/** One instance per connection; storage corruption fails closed, never resets deduplication. */
export class DchatLedger {
  private readonly receipts = new Map<string, DchatReceipt>();
  constructor(private readonly storage: DchatLedgerStorage) {
    const raw = storage.read();
    if (raw !== null && raw !== undefined) {
      if (!raw || typeof raw !== 'object') throw new Error('DCHAT_LEDGER_INVALID');
      const data = raw as { version?: unknown; receipts?: unknown };
      if (data.version !== 1 || !Array.isArray(data.receipts) || !data.receipts.every(validReceipt)) throw new Error('DCHAT_LEDGER_INVALID');
      for (const input of data.receipts) {
        const row = structuredClone(input);
        if (this.receipts.has(row.requestKey)) throw new Error('DCHAT_LEDGER_INVALID');
        // An interrupted dispatch may have executed tools. Never replay it.
        if (row.state === 'reserved' || row.state === 'accepted') row.state = 'unknown';
        if (row.recovery?.status === 'reserved') delete row.nativeTerminal;
        if (row.execution && row.state === 'unknown' && !row.nativeTerminal) row.recovery = { status: 'interrupted', ...(row.recovery?.sourceClientId ? { sourceClientId: row.recovery.sourceClientId } : {}) };
        for (const output of Object.values(row.outputs)) if (output.state === 'sending') output.state = 'unknown';
        this.receipts.set(row.requestKey, row);
      }
      this.flush();
    }
  }
  private flush(): void { this.storage.write({ version: 1, receipts: [...this.receipts.values()].map(row => structuredClone(row)) }); }
  private mutate<T>(work: () => T): T {
    const before = [...this.receipts.entries()].map(([key, row]) => [key, structuredClone(row)] as const);
    try { const result = work(); this.flush(); return result; } catch (error) {
      this.receipts.clear(); for (const [key, row] of before) this.receipts.set(key, row); throw error;
    }
  }
  reserve(messageId: string, destination: DchatDestination, generation: string, authorizationKey?: string): DchatReceipt | null {
    if ((authorizationKey !== undefined && !validId(authorizationKey)) || !validId(messageId) || !validId(generation) || !['accountId', 'connectionId', 'botId', 'chatId'].every(k => validId(destination[k as keyof DchatDestination]))
      || typeof destination.topicId !== 'string' || destination.topicId.length > 2048) throw new Error('DCHAT_INVALID_IDENTITY');
    // botId is intentionally excluded: rebinding must not replay an old input.
    const requestKey = digest([destination.accountId, destination.connectionId, destination.chatId, destination.topicId, messageId]);
    const existing = this.receipts.get(requestKey);
    if (existing) {
      // Only a durably queued, never-dispatched input can be resumed. Bodies are
      // re-read by the native reader and revalidated against the current account.
      if (existing.state !== 'queued' || existing.generation === generation || !same(existing.destination, destination) || existing.execution || existing.authorizationKey !== authorizationKey) return null;
      return this.mutate(() => { existing.generation = generation; existing.state = 'reserved'; return structuredClone(existing); });
    }
    return this.mutate(() => {
      const row: DchatReceipt = { requestKey, messageId, destination: structuredClone(destination), generation, state: 'reserved', ...(authorizationKey !== undefined ? { authorizationKey } : {}), outputs: {} };
      this.receipts.set(requestKey, row); return structuredClone(row);
    });
  }
  read(requestKey: string): DchatReceipt | null { const row = this.receipts.get(requestKey); return row ? structuredClone(row) : null; }
  transition(requestKey: string, generation: string, state: 'queued' | 'accepted' | 'done' | 'aborted' | 'error' | 'unknown'): void {
    this.mutate(() => {
      const row = this.receipts.get(requestKey);
      if (!row || row.generation !== generation || !['reserved', 'queued', 'accepted'].includes(row.state)) throw new Error('DCHAT_STALE_INPUT');
      row.state = state;
    });
  }
  queued(): DchatReceipt[] { return [...this.receipts.values()].filter(r => r.state === 'queued').map(r => structuredClone(r)); }
  bindExecution(requestKey: string, generation: string, sessionId: string, clientId: string, native?: { instanceId: string; turnGeneration: number }): void {
    if (!validId(sessionId) || !validId(clientId) || (native && (!validId(native.instanceId) || !Number.isSafeInteger(native.turnGeneration) || native.turnGeneration <= 0))) throw new Error('DCHAT_INVALID_EXECUTION');
    this.mutate(() => {
      const row = this.receipts.get(requestKey);
      if (!row || row.generation !== generation || !['reserved', 'queued', 'accepted'].includes(row.state)
        || (row.execution && (row.execution.sessionId !== sessionId || row.execution.clientId !== clientId))) throw new Error('DCHAT_STALE_INPUT');
      row.execution = { sessionId, clientId, ...native };
    });
  }
  executionInputs(): DchatReceipt[] {
    return [...this.receipts.values()].filter(r => r.execution?.instanceId && ['accepted', 'unknown'].includes(r.state)).map(r => structuredClone(r));
  }
  reattachExecution(requestKey: string, execution: NonNullable<DchatReceipt['execution']>): void {
    this.mutate(() => {
      const row = this.receipts.get(requestKey);
      if (!row || row.recovery?.status !== 'interrupted' || row.recovery.sourceClientId || !row.execution
        || row.execution.sessionId !== execution.sessionId || row.execution.clientId !== execution.clientId
        || row.execution.instanceId !== execution.instanceId || row.execution.turnGeneration !== execution.turnGeneration) throw new Error('DCHAT_RECOVERY_UNVERIFIED');
      delete row.recovery;
    });
  }
  adoptExecution(requestKey: string, sourceClientId: string, execution: NonNullable<DchatReceipt['execution']>): DchatReceipt {
    return this.mutate(() => {
      const row = this.receipts.get(requestKey);
      if (!row || !['accepted', 'unknown'].includes(row.state) || row.execution?.clientId !== sourceClientId
        || row.execution.sessionId !== execution.sessionId || row.nativeTerminal || Object.keys(row.outputs).length
        || !validId(execution.clientId) || !validId(execution.instanceId) || !Number.isSafeInteger(execution.turnGeneration) || execution.turnGeneration! <= 0
        || sourceClientId === execution.clientId) throw new Error('DCHAT_RECOVERY_UNVERIFIED');
      row.state = 'unknown'; row.execution = { ...execution }; delete row.nativeTerminal;
      row.recovery = { status: 'reserved', sourceClientId };
      return structuredClone(row);
    });
  }
  confirmRecovery(requestKey: string, execution: NonNullable<DchatReceipt['execution']>): void {
    this.mutate(() => {
      const row = this.receipts.get(requestKey);
      if (!row || row.recovery?.status !== 'reserved' || (row.execution?.sessionId !== execution.sessionId || row.execution?.clientId !== execution.clientId || row.execution?.instanceId !== execution.instanceId || row.execution?.turnGeneration !== execution.turnGeneration)) throw new Error('DCHAT_RECOVERY_UNVERIFIED');
      row.recovery.status = 'running';
    });
  }
  interruptRecovery(requestKey: string): void {
    this.mutate(() => { const row = this.receipts.get(requestKey); if (row && (!row.nativeTerminal || row.recovery?.status === 'reserved')) { delete row.nativeTerminal; row.recovery = { status: 'interrupted', ...(row.recovery?.sourceClientId ? { sourceClientId: row.recovery.sourceClientId } : {}) }; } });
  }
  recordNativeTerminal(requestKey: string, execution: { sessionId: string; clientId: string; instanceId: string; turnGeneration: number }, terminal: 'done' | 'error' | 'aborted'): void {
    const row = this.receipts.get(requestKey);
    if (!row || row.recovery?.status === 'interrupted' || !['accepted', 'unknown'].includes(row.state) || !row.execution
      || row.execution.sessionId !== execution.sessionId || row.execution.clientId !== execution.clientId
      || row.execution.instanceId !== execution.instanceId || row.execution.turnGeneration !== execution.turnGeneration) throw new Error('DCHAT_STALE_EXECUTION');
    if (row.nativeTerminal) return;
    this.mutate(() => { row.nativeTerminal = terminal; });
  }
  claimTerminalNotification(requestKey: string): DchatReceipt | null {
    const row = this.receipts.get(requestKey);
    if (!row || (row.recovery?.status === 'reserved' || row.recovery?.status === 'interrupted') || row.state !== 'unknown' || !row.nativeTerminal || !row.execution?.instanceId || Object.keys(row.outputs).length) return null;
    return this.mutate(() => { row.state = 'accepted'; return structuredClone(row); });
  }
  /** Reserve before any send; throwing/timeout is always unknown, never automatically retry. */
  async deliver(requestKey: string, generation: string, destination: DchatDestination, outputId: string,
    send: () => Promise<{ messageId: string }>, isCurrent: () => boolean): Promise<{ messageId: string }> {
    const outputKey = digest(outputId);
    const row = this.receipts.get(requestKey);
    if (!row || row.generation !== generation || !same(row.destination, destination) || row.state !== 'accepted' || !isCurrent()) throw new Error('DCHAT_STALE_OUTPUT');
    if (row.outputs[outputKey] || Object.values(row.outputs).some(o => o.state !== 'sent')) throw new Error('DCHAT_OUTPUT_ALREADY_ATTEMPTED');
    this.mutate(() => { row.outputs[outputKey] = { state: 'sending' }; });
    try {
      // No asynchronous work between this check and transport submission.
      if (!isCurrent()) throw new Error('DCHAT_ACCOUNT_CHANGED');
      const result = await send();
      if (!validId(result.messageId)) throw new Error('DCHAT_SEND_UNCONFIRMED');
      this.mutate(() => { row.outputs[outputKey] = { state: 'sent', messageId: result.messageId }; });
      return result;
    } catch {
      this.mutate(() => { row.outputs[outputKey] = { state: 'unknown' }; });
      throw new Error('DCHAT_SEND_OUTCOME_UNKNOWN');
    }
  }
}
