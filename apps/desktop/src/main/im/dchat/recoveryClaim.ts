import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DchatPrivateJson } from './privateJson';
import type { DchatIM } from '@cindy/im';

type Receipt = ReturnType<DchatIM['executionInputs']>[number];
export interface DchatRecoveryClaim {
  version: 1; token: string; owner: string; source: Receipt;
  clientId: string; state: 'claimed' | 'observing' | 'confirmed' | 'cancelled';
  execution?: { sessionId: string; clientId: string; instanceId: string; turnGeneration: number };
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Permanent per-input consume record. wx provides cross-process exclusion. A
 * partial write is deliberately consumed/unreadable, never reclaimed by age/PID.
 * The client index is durable before enqueue, fencing restored queue snapshots. */
export class DchatRecoveryClaims {
  constructor(private readonly directory: string, private readonly current: () => boolean) {}
  private file(key: string) { return path.join(this.directory, hash(key) + '.json'); }
  private exclusive(filename: string, value: unknown): void {
    if (!this.current()) throw new Error('DCHAT_ACCOUNT_CHANGED');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('DCHAT_PRIVATE_STORE_INVALID');
    let fd: number;
    try { fd = fs.openSync(filename, 'wx', 0o600); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('DCHAT_RECOVERY_CONSUMED'); throw error;
    }
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const parent = fs.openSync(this.directory, 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    if (!this.current()) throw new Error('DCHAT_ACCOUNT_CHANGED');
  }
  claim(source: Receipt, clientId: string, owner: string): DchatRecoveryClaim {
    if (!source.execution?.instanceId || !source.execution.turnGeneration || !clientId || clientId === source.execution.clientId) throw new Error('DCHAT_RECOVERY_SOURCE_UNVERIFIED');
    const value: DchatRecoveryClaim = { version: 1, token: randomUUID(), owner, source: structuredClone(source), clientId, state: 'claimed' };
    this.exclusive(this.file(source.requestKey), value);
    this.exclusive(this.file('client:' + clientId), { version: 1, requestKey: source.requestKey, clientId, token: value.token });
    return value;
  }
  forClient(clientId: string): DchatRecoveryClaim | null {
    const index = new DchatPrivateJson(this.file('client:' + clientId), this.current).read() as { version?: number; requestKey?: string; clientId?: string; token?: string } | null;
    if (!index) return null;
    if (index.version !== 1 || index.clientId !== clientId || typeof index.requestKey !== 'string') throw new Error('DCHAT_RECOVERY_STORE_INVALID');
    const value = new DchatPrivateJson(this.file(index.requestKey), this.current).read() as DchatRecoveryClaim | null;
    if (!value || value.version !== 1 || value.token !== index.token || value.clientId !== clientId || value.source?.requestKey !== index.requestKey) throw new Error('DCHAT_RECOVERY_STORE_INVALID');
    return value;
  }
  update(claim: DchatRecoveryClaim, state: DchatRecoveryClaim['state'], execution?: DchatRecoveryClaim['execution']): void {
    const current = this.forClient(claim.clientId);
    if (!current || current.token !== claim.token || current.state === 'cancelled' || current.state === 'confirmed') throw new Error('DCHAT_RECOVERY_CONSUMED');
    new DchatPrivateJson(this.file(claim.source.requestKey), this.current).write({ ...current, state, ...(execution ? { execution } : {}) });
  }
}

/** Retained receipts outlive connection settings, so replacing a binding cannot
 * erase the dispatch fence for an already queued continuation. */
export function dchatRecoveryConnectionIds(directory: string, current: () => boolean): string[] {
  if (!current()) throw new Error('DCHAT_ACCOUNT_CHANGED');
  let entries: fs.Dirent[];
  try {
    const root = fs.lstatSync(directory);
    if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o077)) throw new Error('DCHAT_PRIVATE_STORE_INVALID');
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const ids = entries.map(entry => {
    if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,256}$/.test(entry.name)) throw new Error('DCHAT_PRIVATE_STORE_INVALID');
    const stat = fs.lstatSync(path.join(directory, entry.name));
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('DCHAT_PRIVATE_STORE_INVALID');
    return entry.name;
  });
  if (!current()) throw new Error('DCHAT_ACCOUNT_CHANGED');
  return ids;
}
