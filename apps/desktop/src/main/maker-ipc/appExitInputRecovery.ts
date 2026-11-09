import type { SendOptions, MainOwnedSendContext } from '@cindy/maker-core';
import { CONTINUE_AFTER_APP_EXIT_PROMPT } from '../../shared/interruptedTurn';

export const APP_EXIT_RECOVERY_POLICY = Symbol('app-exit-recovery-policy');
export interface AppExitRecoveryPolicy { context: MainOwnedSendContext; turnPermissionPolicy?: SendOptions['turnPermissionPolicy'] }
export interface AppExitRecoverySource { requestKey: string; sessionId: string; clientId: string }
export interface AppExitRecoveryHost {
  sources(sessionId: string): AppExitRecoverySource[];
  claim(source: AppExitRecoverySource, clientId: string, guard: () => void): Promise<void>;
  policy(sessionId: string, clientId: string): AppExitRecoveryPolicy | undefined;
}
const hosts = new Set<AppExitRecoveryHost>();
export function onAppExitInputRecovery(host: AppExitRecoveryHost): () => void { hosts.add(host); return () => { hosts.delete(host); }; }
/** The real Continue entry uses persisted native receipts, never transcript text,
 * session recency, or a caller-supplied owner. Multiple original inputs are ambiguous. */
export async function claimAppExitInputRecovery(sessionId: string, clientId: string, prompt: string, guard: () => void = () => {}): Promise<boolean> {
  if (prompt !== CONTINUE_AFTER_APP_EXIT_PROMPT) return false;
  const sources = [...hosts].flatMap(host => host.sources(sessionId).map(source => ({ host, source })));
  if (!sources.length) return false;
  if (sources.length !== 1) throw new Error('DCHAT_RECOVERY_AMBIGUOUS');
  guard(); await sources[0]!.host.claim(sources[0]!.source, clientId, guard); return true;
}
/** Called for every coordinator dispatch, including restored queued inputs. A
 * durable claim without its current process owner must reject before provider send. */
export function appExitInputRecoveryPolicy(sessionId: string, clientId: string): AppExitRecoveryPolicy | undefined {
  const policies = [...hosts].map(host => host.policy(sessionId, clientId)).filter((p): p is AppExitRecoveryPolicy => !!p);
  if (policies.length > 1) throw new Error('DCHAT_RECOVERY_AMBIGUOUS');
  return policies[0];
}
export function assertAppExitRecoveryUsesQueue(sessionId: string, prompt: unknown): void {
  if (prompt === CONTINUE_AFTER_APP_EXIT_PROMPT && [...hosts].some(host => host.sources(sessionId).length)) throw new Error('DCHAT_RECOVERY_QUEUE_REQUIRED');
}
