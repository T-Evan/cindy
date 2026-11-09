/** Main-only signals from actual coordinator recovery, never renderer/body fields.
 * Reservation precedes provider events; confirmation follows accepted dispatch. */
export interface InputRecoveryIdentity { sessionId: string; clientId: string; instanceId: string; turnGeneration: number }
export interface InputRecoveryListener {
  continuation?(source: Omit<InputRecoveryIdentity, 'clientId'>, clientId: string): void;
  owns(sessionId: string, sourceClientId: string): boolean;
  intent(sessionId: string, sourceClientId: string, clientId: string): void;
  reserve(identity: InputRecoveryIdentity): Promise<void>;
  confirm(identity: InputRecoveryIdentity): Promise<void>;
  cancel(sessionId: string, clientId?: string): void;
}
const listeners = new Set<InputRecoveryListener>();
export function onInputRecovery(listener: InputRecoveryListener): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function inputRecoveryRequiresContinuation(sessionId: string, sourceClientId: string): boolean {
  return [...listeners].some(listener => listener.owns(sessionId, sourceClientId));
}
export function noteInputRecoveryIntent(sessionId: string, sourceClientId: string, clientId: string): void {
  for (const listener of listeners) if (listener.owns(sessionId, sourceClientId)) listener.intent(sessionId, sourceClientId, clientId);
}
export async function reserveInputRecovery(identity: InputRecoveryIdentity): Promise<void> {
  for (const listener of listeners) await listener.reserve(identity);
}
export async function confirmInputRecovery(identity: InputRecoveryIdentity): Promise<void> {
  for (const listener of listeners) await listener.confirm(identity);
}
export function cancelInputRecovery(sessionId: string, clientId?: string): void {
  for (const listener of listeners) listener.cancel(sessionId, clientId);
}

/** Host actually chose to continue this exact native generation, before reserving the next. */
export function noteHostInputContinuation(source: Omit<InputRecoveryIdentity, 'clientId'>, clientId: string): void {
  for (const listener of listeners) listener.continuation?.(source, clientId);
}
