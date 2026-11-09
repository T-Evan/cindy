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
    async restore(): Promise<void> {
      if (!current()) return;
      await deps.im.recoverTerminalNotifications();
      if (current()) for (const receipt of deps.im.executionInputs()) observe(receipt);
    },
    stop(): void { stopped = true; releaseMaker(); for (const release of subscriptions.values()) release(); subscriptions.clear(); },
  };
}
