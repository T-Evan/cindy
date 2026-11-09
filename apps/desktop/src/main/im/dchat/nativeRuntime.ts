import path from 'node:path';
import { createHash } from 'node:crypto';
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
import { DchatPrivateJson } from './privateJson';

interface NativeBinding { enabled: boolean; config: DchatConfig; identityExecutable: string; sqlcipherExecutable: string; component: string; databaseRoot: string; socketPath: string }
const log = createLogger('im:dchat-native');
function scope(): string | null {
  return !isAppSessionBoundaryPending() && getActiveAppSession().dataOwnerId ? activeOwnerScopeKey() : null;
}
/** Advanced local Main-owned configuration; drafts never implicitly enable a reader or send.
 * It contains paths/IDs and explicit per-chat choices, never credentials or message bodies. */
function normalize(raw: unknown): { bindings: NativeBinding[] } {
  const data = raw as { bindings?: unknown };
  if (!data || !Array.isArray(data.bindings) || data.bindings.length > 20) throw new Error('DCHAT_NATIVE_CONFIG_INVALID');
  const bindings = data.bindings.map((input: unknown) => {
    const value = input as NativeBinding;
    if (!value || typeof value.enabled !== 'boolean') throw new Error('DCHAT_NATIVE_CONFIG_INVALID');
    const paths = [value.identityExecutable, value.sqlcipherExecutable, value.component, value.databaseRoot, value.socketPath];
    if (paths.some(p => typeof p !== 'string' || !path.isAbsolute(p) || p.length > 4096 || p.includes('\0'))) throw new Error('DCHAT_NATIVE_CONFIG_INVALID');
    return { enabled: value.enabled, config: parseDchatConfig(value.config), identityExecutable: value.identityExecutable,
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
const running: Array<{ inlet: DchatNativeInlet; orchestrator: ImOrchestrator }> = [];
let generation = 0;
export async function stopDchatNativeConnections(): Promise<void> {
  generation++;
  const previous = running.splice(0);
  await Promise.all(previous.map(async item => {
    await item.inlet.stop();
    try { await item.orchestrator.disposeAllSessions(); } finally { item.orchestrator.unregister(); }
  }));
}
/** Called only inside the existing authenticated localDb-ready IM lifecycle. Linux
 * keeps the macOS transport offline; it never guesses paths or opens a macOS DB. */
export async function startDchatNativeConnections(config: ImOrchestratorConfig): Promise<void> {
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
    const im = createBotDchatIM({ config: binding.config, native, current,
      storage: new DchatPrivateJson(path.join(directory, 'receipts.json'), current),
      bindingAvailable: async botId => {
        if (!current()) return false;
        const [row] = await getDbClient().drizzle.select({ status: botProfiles.status }).from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
        return current() && row?.status === 'active';
      },
      // The shared runner already stores the assistant result in its real Cindy
      // task. Draft mode retains it there and does not create another message copy.
      draft: async () => { if (!current()) throw new Error('DCHAT_ACCOUNT_CHANGED'); },
    });
    const orchestrator = wireDchatOrchestrator(im, config, { instanceKey: 'dchat#' + binding.config.connectionId, companionBotId: binding.config.botId });
    const inlet = new DchatNativeInlet(binding.config, { reader, im, storage: new DchatPrivateJson(path.join(directory, 'cursors.json'), current), current,
      onError: () => { log.warn('D-Chat native inlet stopped; inspect connection in Cindy'); } });
    running.push({ inlet, orchestrator });
    try {
      await im.init();
      if (im.getStatus().kind !== 'connected' || !current()) throw new Error('DCHAT_CONNECTION_UNAVAILABLE');
      await inlet.start(); log.info('D-Chat native inlet started');
    } catch {
      await inlet.stop(); await orchestrator.disposeAllSessions(); orchestrator.unregister();
      const index = running.findIndex(item => item.inlet === inlet); if (index >= 0) running.splice(index, 1);
      log.warn('D-Chat native connection unavailable; no fallback execution');
    }
  }
}
