import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Owner/profile-scoped atomic metadata store. One host runtime owns each file;
 * Electron's existing single-instance/profile gate owns process exclusivity.
 * Corruption, symlinks and account changes fail closed instead of clearing receipts. */
export class DchatPrivateJson {
  constructor(private readonly filename: string, private readonly current: () => boolean) {}
  read(): unknown {
    if (!this.current()) throw new Error('DCHAT_ACCOUNT_CHANGED');
    let stat: fs.Stats;
    try { stat = fs.lstatSync(this.filename); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;
    }
    if (!stat.isFile() || stat.size > 8_000_000 || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('DCHAT_PRIVATE_STORE_INVALID');
    const value: unknown = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
    if (!this.current()) throw new Error('DCHAT_ACCOUNT_CHANGED');
    return value;
  }
  write(value: unknown): void {
    if (!this.current()) throw new Error('DCHAT_ACCOUNT_CHANGED');
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 8_000_000) throw new Error('DCHAT_PRIVATE_STORE_FULL');
    const directory = path.dirname(this.filename);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('DCHAT_PRIVATE_STORE_INVALID');
    // Validate the previous file without overwriting an unreadable receipt history.
    this.read();
    const temporary = path.join(directory, '.' + randomUUID() + '.tmp');
    let handle: number | undefined;
    try {
      handle = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(handle, text, 'utf8'); fs.fsyncSync(handle); fs.closeSync(handle); handle = undefined;
      if (!this.current()) throw new Error('DCHAT_ACCOUNT_CHANGED');
      fs.renameSync(temporary, this.filename);
      const parent = fs.openSync(directory, 'r');
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}
