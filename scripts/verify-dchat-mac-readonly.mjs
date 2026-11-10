/** Explicit authorized macOS read-only acceptance, outside default unit tests.
 * Build with desktop's existing esbuild; the standalone ESM needs only Node >=22.12
 * and the selected CLI / SQLCipher. No transport or agent runtime is imported. */
import { DchatCliReader } from '../packages/lizi-im/src/dchat/reader.ts';
import { DchatSqlcipherReader } from '../packages/lizi-im/src/dchat/sqlcipher.ts';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

const [cliPath, cipherPath, component, databaseRoot, chatId] = process.argv.slice(2);
if (process.platform !== 'darwin' || ![cliPath, cipherPath, component, databaseRoot].every(v => v && path.isAbsolute(v)) || !/^\d{1,128}$/.test(chatId ?? '')) {
  process.stderr.write('Usage (macOS): node verify-reader.mjs <readonly CLI> <SQLCipher> <D-Chat component> <database root> <chat ID>\n'); process.exit(64);
}
const report = { platform: process.platform, architecture: process.arch, node: process.version, noSend: true, noDatabaseCopy: true };
let reader;
async function fingerprint(file) {
  const info = await lstat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (!info) return null;
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { size: info.size, digest: hash.digest('hex') };
}
try {
  const cli = new DchatCliReader(cliPath);
  // Official CLI enforces its message gate. Never fall back to SQLCipher after denial.
  await cli.assertHistoryAccess(chatId);
  report.messageGatePassed = true;
  const members = await cli.members(chatId);
  report.members = { count: members.memberIds.length, selfPresent: members.memberIds.includes(members.accountId), freshIdentity: true };
  if (!report.members.selfPresent) throw new Error('DCHAT_SELF_NOT_MEMBER');
  const db = path.join(databaseRoot, '1_' + members.accountId + '_db', 'chat39');
  const before = await Promise.all(['', '-wal'].map(s => fingerprint(db + s)));
  reader = new DchatSqlcipherReader({ executable: await realpath(cipherPath), component, databaseRoot, identity: () => cli.identity() });
  const page = await reader.page(chatId);
  report.baseline = { count: page.messages.length, kind: page.kind, hasMore: page.hasMore, continuous: page.continuous, accountMatches: page.accountId === members.accountId };
  if (page.cursor) {
    const next = await reader.page(chatId, page.cursor);
    report.latestAnchor = { count: next.messages.length, continuous: next.continuous, hasMore: next.hasMore };
    const exact = await reader.page(chatId, page.cursor, undefined, true);
    report.exactAnchor = { count: exact.messages.length };
    if (page.messages.length > 1) {
      try {
        const old = await reader.page(chatId, page.messages[0].messageId);
        report.cachedWindow = { continuous: old.continuous, count: old.messages.length };
      } catch (error) {
        if (error.message !== 'DCHAT_HISTORY_GAP') throw error;
        report.cachedWindow = { rejected: 'DCHAT_HISTORY_GAP' };
      }
    }
  }
  const after = await Promise.all(['', '-wal'].map(s => fingerprint(db + s)));
  // Compare in memory; no user DB/WAL digest or account identifier is exported.
  report.databaseBytesUnchanged = JSON.stringify(before[0]) === JSON.stringify(after[0]);
  report.walBytesUnchanged = JSON.stringify(before[1]) === JSON.stringify(after[1]);
  report.liveObservationStable = report.databaseBytesUnchanged && report.walBytesUnchanged;
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = /^DCHAT_[A-Z_]+$/.test(error.message) ? error.message : 'DCHAT_MAC_ACCEPTANCE_FAILED';
  process.exitCode = 1;
} finally {
  reader?.dispose();
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
