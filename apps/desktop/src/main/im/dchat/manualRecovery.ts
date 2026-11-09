import type { DchatIM } from '@cindy/im';
import type { AppExitRecoveryHost, AppExitRecoveryPolicy } from '../../maker-ipc/appExitInputRecovery';
import type { InputRecoveryIdentity, InputRecoveryListener } from '../../maker-ipc/inputRecoverySignal';
import type { DchatRecoveryClaim, DchatRecoveryClaims } from './recoveryClaim';
import type { createDchatExecutionObserver } from './executionObserver';

type Receipt = ReturnType<DchatIM['executionInputs']>[number];
export interface DchatManualRecoveryDeps {
  owner(): string | null;
  onStopError?(): void;
  sources(sessionId: string): Receipt[];
  store(receipt: Receipt): DchatRecoveryClaims;
  claimed(clientId: string): DchatRecoveryClaim | null;
  verify(receipt: Receipt): Promise<void>;
  supersede(receipt: Receipt): void;
  runtime(receipt: Receipt): { im: DchatIM; observer: ReturnType<typeof createDchatExecutionObserver> };
  busy(sessionId: string): boolean;
  policy(receipt: Receipt, clientId: string): AppExitRecoveryPolicy;
  beginScope(receipt: Receipt, identity: InputRecoveryIdentity): () => void;
}
/** Explicit owner's Continue only. No message replay, automatic recovery, private
 * result extraction or scheduler authority. A consumed claim never becomes reusable. */
export function createDchatManualRecovery(deps: DchatManualRecoveryDeps): { host: AppExitRecoveryHost; listener: InputRecoveryListener; stop(): void } {
  const pending = new Map<string, { claim: DchatRecoveryClaim; store: DchatRecoveryClaims; release?: () => void; identity?: InputRecoveryIdentity }>();
  function active(sessionId: string, clientId: string) {
    const owned = pending.get(clientId);
    if (owned && owned.claim.owner !== deps.owner()) throw new Error('DCHAT_ACCOUNT_CHANGED');
    const durable = deps.claimed(clientId);
    if (!durable) return undefined;
    const item = pending.get(clientId);
    if (!item || durable.token !== item.claim.token || durable.owner !== deps.owner() || durable.source.execution?.sessionId !== sessionId
      || durable.state === 'cancelled') throw new Error('DCHAT_RECOVERY_INTERRUPTED');
    return item;
  }
  function cancel(sessionId: string, clientId?: string) {
    if (!clientId) for (const row of deps.sources(sessionId)) {
      if (!row.nativeTerminal) deps.supersede(row);
    }
    for (const [id, item] of pending) {
      if (item.claim.source.execution?.sessionId !== sessionId || (clientId && id !== clientId)) continue;
      item.release?.();
      if (item.claim.owner !== deps.owner()) { pending.delete(id); continue; }
      try { deps.runtime(item.claim.source).im.interruptRecovery(item.claim.source.requestKey); } finally {
        const store = item.store, durable = store.forClient(id);
        if (durable && durable.state !== 'confirmed' && durable.state !== 'cancelled') store.update(item.claim, 'cancelled');
        pending.delete(id);
      }
    }
  }
  return {
    stop: () => {
      for (const [clientId, item] of pending) {
        try { cancel(item.claim.source.execution!.sessionId, clientId); }
        catch {
          // Revocation can make the transport receipt unwritable. The permanent
          // claim still fences replay; it must not prevent stopping other runtimes.
          item.release?.(); pending.delete(clientId); deps.onStopError?.();
        }
      }
    },
    host: {
      sources: sessionId => deps.sources(sessionId).map(row => ({ requestKey: row.requestKey, sessionId, clientId: row.execution!.clientId })),
      claim: async (source, clientId, guard) => {
        const rows = deps.sources(source.sessionId);
        if (rows.length !== 1 || rows[0]!.requestKey !== source.requestKey || rows[0]!.execution?.clientId !== source.clientId) throw new Error('DCHAT_RECOVERY_AMBIGUOUS');
        const row = rows[0]!, owner = deps.owner();
        if (!owner || !row.principal || !row.authorizationKey || !row.execution?.instanceId || !row.execution.turnGeneration) throw new Error('DCHAT_RECOVERY_SOURCE_UNVERIFIED');
        if (row.recoveryBlocked) throw new Error('DCHAT_RECOVERY_SOURCE_CHANGED');
        if (row.nativeTerminal) throw new Error('DCHAT_RECOVERY_SETTLED');
        if (Object.keys(row.outputs).length) throw new Error('DCHAT_RECOVERY_OUTPUT_ATTEMPTED');
        if (row.recovery?.sourceClientId) throw new Error('DCHAT_RECOVERY_CONSUMED');
        if (row.recovery?.status !== 'interrupted' || deps.busy(source.sessionId)) throw new Error('DCHAT_RECOVERY_BUSY');
        await deps.verify(row);
        if (deps.owner() !== owner || deps.busy(source.sessionId)) throw new Error('DCHAT_ACCOUNT_CHANGED');
        const latest = deps.sources(source.sessionId);
        if (latest.length !== 1 || JSON.stringify(latest[0]) !== JSON.stringify(row)) throw new Error('DCHAT_RECOVERY_SOURCE_CHANGED');
        guard();
        const store = deps.store(row), claim = store.claim(row, clientId, owner);
        pending.set(clientId, { claim, store });
      },
      policy: (sessionId, clientId) => {
        const item = active(sessionId, clientId);
        if (item && deps.claimed(clientId)?.state !== 'claimed') throw new Error('DCHAT_RECOVERY_CONSUMED');
        return item ? deps.policy(item.claim.source, clientId) : undefined;
      },
    },
    listener: {
      // A failed manual continuation must not be cloned by generic automatic
      // retry under a fresh clientId. Silent-stop uses its exact host generation bridge.
      owns: (sessionId, clientId) => deps.claimed(clientId)?.source.execution?.sessionId === sessionId,
      intent: () => { throw new Error('DCHAT_RECOVERY_INTERRUPTED'); }, cancel,
      reserve: async identity => {
        const item = active(identity.sessionId, identity.clientId); if (!item) return;
        const source = item.claim.source;
        try {
          await deps.verify(source);
          if (active(identity.sessionId, identity.clientId) !== item) throw new Error('DCHAT_RECOVERY_INTERRUPTED');
          await deps.runtime(source).observer.takeover(source.execution!.clientId, identity);
          if (active(identity.sessionId, identity.clientId) !== item) throw new Error('DCHAT_RECOVERY_INTERRUPTED');
          item.identity = identity; item.release = deps.beginScope(source, identity);
          item.store.update(item.claim, 'observing', identity);
        } catch (error) { cancel(identity.sessionId, identity.clientId); throw error; }
      },
      confirm: async identity => {
        const item = active(identity.sessionId, identity.clientId); if (!item) return;
        if (!item.identity || JSON.stringify(item.identity) !== JSON.stringify(identity)) throw new Error('DCHAT_RECOVERY_SOURCE_CHANGED');
        await deps.runtime(item.claim.source).im.confirmRecovery(identity);
        if (active(identity.sessionId, identity.clientId) !== item) throw new Error('DCHAT_RECOVERY_INTERRUPTED');
        item.store.update(item.claim, 'confirmed', identity);
      },
    },
  };
}
