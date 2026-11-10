import { dialog, ipcMain } from 'electron';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DchatCliReader, DchatSqlcipherReader } from '@cindy/im';
import { createDchatSetupHandlers, verifyDchatSetupReaders } from './connectionSetup';
import { detectDchatLocalPaths } from './localPaths';
import { getCodexHome } from '../../maker-host/codex-home-path';
import { readDchatNativeBindings, writeDchatNativeBinding, dchatNativeStatus, dchatInterruptedCount, reloadDchatNativeConnections } from './nativeRuntime';
import type { DchatSetupPath } from '../../../shared/dchatConnection';
import { eq } from 'drizzle-orm';
import { getActiveAppSession, activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../appSessionState';
import { getDbClient } from '../../localDb/client/current';
import { botProfiles } from '../../localDb/schema';
import { createOverrideSettingsFile } from '../../maker-host/override-settings-file';
import { createLogger } from '../../logger';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer';
import { throwIpcError } from '../../utils/ipcValidate';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { createDchatConnectionDraftHandlers, parseDchatConnectionDraft } from './connectionDraft';
import type { DchatConnectionDraft } from '../../../shared/dchatConnection';

function currentScope(): string | null {
  const session = getActiveAppSession();
  return session.dataOwnerId && !isAppSessionBoundaryPending()
    ? `${activeOwnerScopeKey()}:${session.generation}` : null;
}
const store = createOverrideSettingsFile<{ bindings: Record<string, DchatConnectionDraft> }>({
  filePath: () => ownerScopedImUserDataPath('dchat', 'connection-drafts.json'),
  defaults: { bindings: {} },
  normalize: raw => {
    const value = (raw as { bindings?: unknown })?.bindings;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 100) throw new Error('DCHAT_INVALID_DRAFT_STORE');
    const bindings: Record<string, DchatConnectionDraft> = {};
    for (const [id, entry] of Object.entries(value)) {
      const draft = parseDchatConnectionDraft(entry);
      if (draft.botId !== id) throw new Error('DCHAT_INVALID_DRAFT_STORE');
      bindings[id] = draft;
    }
    return { bindings };
  },
  scopeKey: () => currentScope() ?? 'unavailable',
  maxBytes: 256_000, preserveUnreadableFile: true,
  logLoadedValue: false, logReadErrorDetails: false,
  log: createLogger('im:dchat-drafts'), label: 'D-Chat connection drafts',
});
const handlers = createDchatConnectionDraftHandlers({
  scope: currentScope, platform: process.platform,
  read: () => { store.invalidateIfChanged(); return store.read().bindings; },
  write: async (botId, draft, expected) => {
    await store.updateAtomic(current => {
      if (currentScope() !== expected) throw new Error('DCHAT_ACCOUNT_CHANGED');
      const bindings = { ...current.value.bindings };
      if (draft) bindings[botId] = draft; else delete bindings[botId];
      if (Object.keys(bindings).length > 100) throw new Error('DCHAT_TOO_MANY_BINDINGS');
      return { bindings };
    });
  },
  bindingAvailable: async botId => {
    const [row] = await getDbClient().drizzle.select({ status: botProfiles.status })
      .from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
    return row?.status === 'active';
  },
});
const setup = createDchatSetupHandlers({
  scope: currentScope, platform: process.platform,
  read: readDchatNativeBindings, write: writeDchatNativeBinding,
  connected: dchatNativeStatus, interruptedCount: dchatInterruptedCount, reload: reloadDchatNativeConnections,
  detect: () => detectDchatLocalPaths({ home: os.homedir(), skillRoots: [
    path.join(getCodexHome(), 'skills'), path.join(os.homedir(), '.agents/skills'),
    path.join(os.homedir(), '.claude/skills'),
  ] }),
  available: async botId => {
    const [row] = await getDbClient().drizzle.select({ status: botProfiles.status })
      .from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
    return row?.status === 'active';
  },
  choose: async field => {
    const result = await dialog.showOpenDialog({ properties: field === 'databaseRoot' ? ['openDirectory'] : ['openFile'] });
    return result.canceled || !result.filePaths[0] ? null : await realpath(result.filePaths[0]);
  },
  verify: async (paths, chatId) => {
    const identity = new DchatCliReader(paths.identityExecutable);
    const reader = new DchatSqlcipherReader({ executable: paths.sqlcipherExecutable,
      databaseRoot: paths.databaseRoot, component: paths.component, identity: () => identity.identity() });
    return verifyDchatSetupReaders(identity, reader, chatId);
  },
});
let registered = false;
/** No native inlet is registered until local account, membership and pagination have been verified. */
export function registerDchatConnectionDraftIpc(): void {
  if (registered) return; registered = true;
  for (const action of ['get', 'pick', 'save', 'enable', 'disable'] as const) {
    ipcMain.handle('dchatSetup:' + action, async (event, value: unknown, field: unknown) => {
      assertTrustedAppRendererEvent(event);
      try {
        if (action === 'save') return await setup.save(value as Parameters<typeof setup.save>[0]);
        if (typeof value !== 'string') throw new Error('DCHAT_INVALID_BOT');
        if (action === 'pick') return await setup.pick(value, field as DchatSetupPath);
        return await setup[action](value);
      } catch (error) {
        const code = error instanceof Error && /^DCHAT_[A-Z_]+$/.test(error.message) ? error.message : 'DCHAT_SETUP_UNAVAILABLE';
        throwIpcError('PRECONDITION_FAILED', code);
      }
    });
  }
  for (const action of ['get', 'save', 'remove'] as const) {
    ipcMain.handle(`dchatConnection:${action}`, async (event, value: unknown) => {
      assertTrustedAppRendererEvent(event);
      try {
        if (action === 'save') return await handlers.save(value);
        if (typeof value !== 'string') throw new Error('DCHAT_INVALID_BOT');
        return action === 'get' ? handlers.get(value) : await handlers.remove(value);
      } catch { throwIpcError('PRECONDITION_FAILED', 'DCHAT_CONNECTION_DRAFT_UNAVAILABLE'); }
    });
  }
}
