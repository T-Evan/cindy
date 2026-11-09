import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getMaker } from '../../maker-host';
import { createDchatExecutionObserver } from './executionObserver';
import { eq } from 'drizzle-orm';
import { DchatCliReader, DchatMacNative, DchatSqlcipherReader, DchatNativeInlet, parseDchatConfig, type DchatConfig } from '@cindy/im';
import { getDbClient } from '../../localDb/client/current';
import { botProfiles } from '../../localDb/schema';
import { createOverrideSettingsFile } from '../../maker-host/override-settings-file';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending } from '../../appSessionState';
import { createLogger } from '../../logger';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { captureImAccountGeneration, isImAccountGenerationCurrent } from '../accountBoundary';
import { createBotDchatIM } from '../host';
import type { ImOrchestratorConfig } from '../shared/types';
import type { ImOrchestrator } from '../shared/orchestrator';
import { wireDchatOrchestrator } from './adapter';
import { DCHAT_GROUP_WINDOW } from './groupContext';
import { DchatPrivateJson } from './privateJson';

export interface NativeBinding { revision?: string; enabled: boolean; config: DchatConfig; identityExecutable: string; sqlcipherExecutable: string; component: string; databaseRoot: string; socketPath: string }
const log = createLogger('im:dchat-native');
function scope(): string | null {
  return !isAppSessionBoundaryPending() && getActiveAppSession().dataOwnerId ? activeOwnerScopeKey() + ":" + getActiveAppSession().generation : null;
}
/** Advanced local Main-owned configuration; drafts never implicitly enable a reader or send.
 * It contains paths/IDs and explicit per-chat choices, never credentials or message bodies. */
function normalize(raw: unknown): { bindings: NativeBinding[] } {
  const data = raw as { bindings?: unknown };
  if (!data || !Array.isArray(data.bindings) || data.bindings.length > 20) throw new Error('DCHAT_NATIVE_CONFIG_INVALID');
  const bindings = data.bindings.map((input: unknown) => {
    const value = input as NativeBinding;
    if (!value || typeof value.enabled !== 'boolean') throw new Error('DCHAT_NATIVE_CONFIG_INVALID');
    if (value.revision !== undefined && (typeof value.revision !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.revision))) throw new Error('DCHAT_NATIVE_CONFIG_INVALID');
    const paths = [value.identityExecutable, value.sqlcipherExecutable, value.component, value.databaseRoot, value.socketPath];
    if (paths.some(p => typeof p !== 'string' || !path.isAbsolute(p) || p.length > 4096 || p.includes('\0'))) throw new Error('DCHAT_NATIVE_CONFIG_INVALID');
    return { ...(value.revision ? { revision: value.revision } : {}), enabled: value.enabled, config: parseDchatConfig(value.config), identityExecutable: value.identityExecutable,
      sqlcipherExecutable: value.sqlcipherExecutable, component: value.component, databaseRoot: value.databaseRoot, socketPath: value.socketPath };
  });
  if (new Set(bindings.map(b => b.config.connectionId)).size !== bindings.length) throw new Error('DCHAT_DUPLICATE_CONNECTION');
  return { bindings };
}
const settings = createOverrideSettingsFile({
  filePath: () => ownerScopedImUserDataPath('dchat', 'native-bindings.json'), defaults: { bindings: [] as NativeBinding[] }, normalize,
  scopeKey: () => scope() ?? 'unavailable', maxBytes: 256_000, preserveUnreadableFile: true,
  logLoadedValue: false, logReadErrorDetails: false, log, label: 'D-Chat native bindings',
});
const fingerprint = (value: NativeBinding): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const running: Array<{ inlet: DchatNativeInlet; orchestrator: ImOrchestrator; observer: ReturnType<typeof createDchatExecutionObserver> }> = [];
let generation = 0;
let runtimeConfig: ImOrchestratorConfig | null = null;
export function readDchatNativeBindings(): NativeBinding[] {
  settings.invalidateIfChanged(); return settings.read().bindings;
}
export async function writeDchatNativeBinding(binding: NativeBinding, expectedScope: string): Promise<void> {
  await settings.updateAtomic(current => {
    if (scope() !== expectedScope) throw new Error('DCHAT_ACCOUNT_CHANGED');
    const bindings = current.value.bindings.filter(b => b.config.botId !== binding.config.botId);
    // Every explicit configuration write revokes earlier inputs, including disable/re-enable.
    return normalize({ bindings: [...bindings, { ...binding, revision: randomUUID() }] });
  });
}
export function dchatNativeStatus(connectionId: string): boolean {
  return running.some(item => item.orchestrator.adapter.getBotContextId?.() === connectionId
    && item.orchestrator.adapter.im.getStatus().kind === 'connected');
}
export async function reloadDchatNativeConnections(): Promise<void> {
  if (!runtimeConfig) throw new Error('DCHAT_RUNTIME_NOT_READY');
  await startDchatNativeConnections(runtimeConfig);
}

export async function stopDchatNativeConnections(): Promise<void> {
  generation++;
  const previous = running.splice(0);
  await Promise.all(previous.map(async item => {
    item.observer.stop();
    await item.inlet.stop();
    try { await item.orchestrator.disposeAllSessions(); } finally { item.orchestrator.unregister(); }
  }));
  await DCHAT_GROUP_WINDOW.resetCursors({ clearPersisted: false });
}
/** Called only inside the existing authenticated localDb-ready IM lifecycle. Linux
 * keeps the macOS transport offline; it never guesses paths or opens a macOS DB. */
export async function startDchatNativeConnections(config: ImOrchestratorConfig): Promise<void> {
  runtimeConfig = config;
  await stopDchatNativeConnections();
  if (process.platform !== 'darwin' || !scope()) return;
  const owner = scope(), epoch = captureImAccountGeneration(), started = generation;
  let bindings: NativeBinding[];
  try { settings.invalidateIfChanged(); bindings = settings.read().bindings; } catch { log.warn('D-Chat native configuration unreadable; connections remain offline'); return; }
  for (const binding of bindings.filter(b => b.enabled)) {
    const expected = fingerprint(binding);
    const current = (): boolean => {
      if (started !== generation || epoch === null || !isImAccountGenerationCurrent(epoch) || scope() !== owner) return false;
      try {
        settings.invalidateIfChanged();
        return settings.read().bindings.some(b => b.enabled && b.config.connectionId === binding.config.connectionId && fingerprint(b) === expected);
      } catch { return false; }
    };
    if (!current()) break;
    const identity = new DchatCliReader(binding.identityExecutable);
    const reader = new DchatSqlcipherReader({ executable: binding.sqlcipherExecutable, component: binding.component,
      databaseRoot: binding.databaseRoot, identity: () => identity.identity() });
    const native = new DchatMacNative(reader, binding.socketPath);
    const directory = ownerScopedImUserDataPath('dchat', 'native-runtime', binding.config.connectionId);
    const im = createBotDchatIM({ config: binding.config, native, current, authorizationKey: expected,
      executionBound: receipt => observer.observe(receipt),
      storage: new DchatPrivateJson(path.join(directory, 'receipts.json'), current),
      bindingAvailable: async botId => {
        if (!current()) return false;
        const [row] = await getDbClient().drizzle.select({ status: botProfiles.status }).from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
        return current() && row?.status === 'active';
      },
      context: async input => {
        if (!current()) throw new Error('DCHAT_ACCOUNT_CHANGED');
        const chat = binding.config.chats.find(c => c.id === input.chatId);
        if (!chat || !['group', 'topic'].includes(chat.kind)) return;
        await DCHAT_GROUP_WINDOW.record({ botId: binding.config.connectionId,
          chatId: chat.parentId ?? chat.id, threadId: chat.kind === 'topic' ? chat.id : '',
          messageId: input.messageId, text: input.text,
          author: { name: input.senderName }, sentAt: input.sentAt ?? Date.now() });
        if (!current()) throw new Error('DCHAT_ACCOUNT_CHANGED');
      },
      // The shared runner already stores the assistant result in its real Cindy
      // task. Draft mode retains it there and does not create another message copy.
      draft: async () => { if (!current()) throw new Error('DCHAT_ACCOUNT_CHANGED'); },
    });
    const observer = createDchatExecutionObserver({ im, current, session: id => getMaker().getSession(id),
      onSession: callback => getMaker().on(event => { if (event.type === 'session:created') callback(event.session); }),
      onError: () => log.warn('D-Chat execution observation unavailable; no replay'),
    });
    const orchestrator = wireDchatOrchestrator(im, config, { instanceKey: 'dchat#' + binding.config.connectionId, companionBotId: binding.config.botId });
    const inlet = new DchatNativeInlet(binding.config, { reader, im, storage: new DchatPrivateJson(path.join(directory, 'cursors.json'), current), current,
      onError: () => { log.warn('D-Chat native inlet stopped; inspect connection in Cindy'); } });
    running.push({ inlet, orchestrator, observer });
    try {
      await im.init();
      if (im.getStatus().kind !== 'connected' || !current()) throw new Error('DCHAT_CONNECTION_UNAVAILABLE');
      await observer.restore();
      await inlet.start(); log.info('D-Chat native inlet started');
    } catch {
      observer.stop(); await inlet.stop(); await orchestrator.disposeAllSessions(); orchestrator.unregister();
      const index = running.findIndex(item => item.inlet === inlet); if (index >= 0) running.splice(index, 1);
      log.warn('D-Chat native connection unavailable; no fallback execution');
    }
  }
}
