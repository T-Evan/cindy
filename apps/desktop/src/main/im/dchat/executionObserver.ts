import type { InputRecoveryIdentity, InputRecoveryListener } from '../../maker-ipc/inputRecoverySignal';
import { isImSubagentEvent } from '../shared/agentEventScope';
import type { AgentEvent } from '@cindy/maker-core';
import { isTerminalAgentErrorEvent } from '@cindy/maker-core';
import { isProductTurnDoneEvent } from '@cindy/maker-shared/turn-continuation';
import type { DchatIM } from '@cindy/im';

type Receipt = ReturnType<DchatIM['executionInputs']>[number];
interface ObservedSession {
  id: string; instanceId: string; getTurnGeneration(): number;
  onEvent(callback: (event: AgentEvent) => void): () => void;
}
/** Observes existing native execution only. No Session.send/create/resume and no
 * companion history/reply calls. A replacement instance or generation remains
 * uncertain until the host supplies an exact native ownership receipt. */
export function createDchatExecutionObserver(deps: {
  im: DchatIM; current(): boolean;
  session(id: string): ObservedSession | undefined;
  onSession(callback: (session: ObservedSession) => void): () => void;
  onError(): void;
}) {
  const subscriptions = new Map<string, () => void>();
  let stopped = false;
  const current = () => !stopped && deps.current();
  function observe(receipt: Receipt): void {
    const e = receipt.execution;
    if (!current() || !e?.instanceId || !e.turnGeneration || receipt.nativeTerminal || subscriptions.has(receipt.requestKey)) return;
    const session = deps.session(e.sessionId);
    if (!session || session.instanceId !== e.instanceId || session.getTurnGeneration() !== e.turnGeneration) return;
    const release = session.onEvent(event => {
      if (!current() || isImSubagentEvent(event) || event.turnScope === 'background' || event.agentMeta?.botPrivateReply === true
        || (event.agentMeta?.replyToClientId !== undefined && event.agentMeta.replyToClientId !== e.clientId)
        || event.sessionInstanceId !== e.instanceId || event.sessionTurnGeneration !== e.turnGeneration) return;
      if (!isProductTurnDoneEvent(event) && !isTerminalAgentErrorEvent(event)) return;
      const data = event.data as { status?: unknown; is_error?: unknown; silentStop?: unknown } | null;
      // A silent-stop SDK boundary may be followed by a host-owned continuation.
      // Without its accepted execution receipt it is not a completed product input.
      if (data?.silentStop === true) return;
      const status = data?.status;
      const terminal = isTerminalAgentErrorEvent(event) || status === 'failed' || data?.is_error === true
        ? 'error' : status === 'cancelled' || status === 'interrupted' ? 'aborted' : 'done';
      try {
        deps.im.recordNativeTerminal(receipt.requestKey, { sessionId: e.sessionId, clientId: e.clientId,
          instanceId: e.instanceId!, turnGeneration: e.turnGeneration! }, terminal);
        // Live inputs use native per-turn output. Only restarted uncertain inputs
        // can claim the content-free recovery notification.
        if (receipt.state === 'unknown') void deps.im.recoverTerminalNotifications().catch(deps.onError);
      } catch { deps.onError(); }
      subscriptions.get(receipt.requestKey)?.(); subscriptions.delete(receipt.requestKey);
    });
    subscriptions.set(receipt.requestKey, release);
  }
  const releaseMaker = deps.onSession(session => {
    if (current()) for (const receipt of deps.im.executionInputs()) if (receipt.execution?.sessionId === session.id) observe(receipt);
  });
  return {
    observe,
    async takeover(sourceClientId: string, execution: { sessionId: string; clientId: string; instanceId: string; turnGeneration: number }): Promise<void> {
      if (!current()) throw new Error('DCHAT_RECOVERY_UNVERIFIED');
      const previous = deps.im.recoveryForInput(execution.sessionId, sourceClientId);
      const session = deps.session(execution.sessionId);
      if (!previous || !session || session.instanceId !== execution.instanceId || session.getTurnGeneration() !== execution.turnGeneration) throw new Error('DCHAT_RECOVERY_UNVERIFIED');
      const receipt = await deps.im.adoptExecution(sourceClientId, execution);
      if (!current()) throw new Error('DCHAT_RECOVERY_UNVERIFIED');
      subscriptions.get(receipt.requestKey)?.(); subscriptions.delete(receipt.requestKey);
      observe(receipt);
    },
    async restore(): Promise<void> {
      if (!current()) return;
      await deps.im.recoverTerminalNotifications();
      if (current()) for (const receipt of deps.im.executionInputs()) {
        const live = deps.session(receipt.execution!.sessionId);
        if (!receipt.nativeTerminal && (!live || live.instanceId !== receipt.execution!.instanceId || live.getTurnGeneration() !== receipt.execution!.turnGeneration)) deps.im.interruptRecovery(receipt.requestKey);
        else if (!receipt.nativeTerminal && receipt.recovery?.status === 'interrupted' && !receipt.recovery.sourceClientId) deps.im.reattachExecution(receipt.requestKey, receipt.execution!);
        observe(receipt);
      }
    },
    stop(): void { stopped = true; releaseMaker(); for (const release of subscriptions.values()) release(); subscriptions.clear(); },
  };
}

/** Consumes only Main coordinator intent/reservation/accepted-dispatch receipts.
 * A replacement Session alone never creates an intent. Cancellation closes the
 * reserved observer before any later event can claim an outbound notification. */
export function createDchatRecoveryListener(deps: {
  im: DchatIM; observer: ReturnType<typeof createDchatExecutionObserver>; current(): boolean;
}): InputRecoveryListener {
  const intents = new Map<string, { sessionId: string; clientId: string; sourceClientId: string; identity?: InputRecoveryIdentity }>();
  const key = (identity: { sessionId: string; clientId: string }) => JSON.stringify([identity.sessionId, identity.clientId]);
  return {
    continuation: (source, clientId) => {
      const candidates = deps.im.executionInputs().filter(row => row.execution?.sessionId === source.sessionId
        && row.execution.instanceId === source.instanceId && row.execution.turnGeneration === source.turnGeneration
        && !row.nativeTerminal && !Object.keys(row.outputs).length);
      if (!candidates.length) return;
      if (candidates.length !== 1 || !deps.current()) throw new Error('DCHAT_RECOVERY_UNVERIFIED');
      const sourceClientId = candidates[0]!.execution!.clientId;
      intents.set(key({ sessionId: source.sessionId, clientId }), { sessionId: source.sessionId, clientId, sourceClientId });
    },
    owns: (sessionId, clientId) => !!deps.im.recoveryForInput(sessionId, clientId),
    intent: (sessionId, sourceClientId, clientId) => {
      if (!deps.current()) throw new Error('DCHAT_RECOVERY_UNVERIFIED');
      intents.set(key({ sessionId, clientId }), { sessionId, clientId, sourceClientId });
    },
    reserve: async identity => {
      const intent = intents.get(key(identity)); if (!intent) return;
      if (!deps.current()) throw new Error('DCHAT_RECOVERY_UNVERIFIED');
      await deps.observer.takeover(intent.sourceClientId, identity);
      // cancel may win while identity/binding verification awaits.
      if (intents.get(key(identity)) !== intent || !deps.current()) {
        const row = deps.im.recoveryForInput(identity.sessionId, identity.clientId);
        if (row) deps.im.interruptRecovery(row.requestKey);
        throw new Error('DCHAT_RECOVERY_UNVERIFIED');
      }
      intent.identity = identity;
    },
    confirm: async identity => {
      const intent = intents.get(key(identity)); if (!intent) return;
      if (!deps.current() || !intent.identity || intent.identity.instanceId !== identity.instanceId || intent.identity.turnGeneration !== identity.turnGeneration) throw new Error('DCHAT_RECOVERY_UNVERIFIED');
      await deps.im.confirmRecovery(identity); intents.delete(key(identity));
    },
    cancel: (sessionId, clientId) => {
      for (const [k, intent] of intents) {
        if (intent.sessionId !== sessionId || (clientId && clientId !== intent.clientId)) continue;
        if (intent.identity) {
          const row = deps.im.recoveryForInput(sessionId, intent.clientId);
          if (row) deps.im.interruptRecovery(row.requestKey);
        }
        intents.delete(k);
      }
    },
  };
}
