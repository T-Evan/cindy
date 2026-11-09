/** Integration tier: real private receipt file and separate Node processes.
 * Combines durable native terminal receipts with production notification recovery.
 * Native sends are synthetic; no real D-Chat account, socket or companion is used.
 * Run: pnpm exec tsx scripts/verify-dchat-recovery.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DchatPrivateJson } from '../apps/desktop/src/main/im/dchat/privateJson.ts';
import { DchatLedger } from '../packages/lizi-im/src/dchat/ledger.ts';
import { DchatTransport } from '../packages/lizi-im/src/dchat/transport.ts';

const config = { accountId: '100', ownerId: '100', botId: 'synthetic-bot', connectionId: 'synthetic-connection',
  chats: [{ id: '300', kind: 'group' }], executeChatIds: ['300'], replyMode: 'automatic' };
const destination = { accountId: '100', connectionId: config.connectionId, botId: config.botId, chatId: '300', topicId: '' };
const execution = { sessionId: 'synthetic-session', clientId: 'synthetic-client', instanceId: 'synthetic-instance', turnGeneration: 7 };
if (process.argv[2] === '--child') {
  const [file, attempts, behavior] = process.argv.slice(3);
  const transport = new DchatTransport(config, { storage: new DchatPrivateJson(file, () => true),
    bindingAvailable: async () => true, dispatch: async () => { throw new Error('INPUT_REPLAY_FORBIDDEN'); },
    native: { identity: async () => ({ accountId: behavior === 'account-changed' ? '999' : '100' }),
      capabilities: async () => ['content'], send: async input => {
        fs.appendFileSync(attempts, JSON.stringify({ chatId: input.chatId, accountId: input.accountId, text: input.text }) + '\n', { mode: 0o600 });
        if (behavior === 'unknown') throw new Error('SYNTHETIC_LOST_ACK');
        return { messageId: 'synthetic-confirmed' };
      } },
  });
  if (behavior === 'takeover' || behavior === 'reservation-crash') {
    const original = transport.ledger.executionInputs()[0];
    const replacement = { sessionId: execution.sessionId, clientId: 'replacement-client', instanceId: 'replacement-instance', turnGeneration: 2 };
    assert.throws(() => transport.ledger.adoptExecution(original.requestKey, 'unrelated', replacement), /DCHAT_RECOVERY_UNVERIFIED/);
    transport.ledger.adoptExecution(original.requestKey, execution.clientId, replacement);
    assert.throws(() => transport.ledger.recordNativeTerminal(original.requestKey, execution, 'done'), /DCHAT_STALE_EXECUTION/);
    transport.ledger.recordNativeTerminal(original.requestKey, replacement, 'done');
    await transport.recoverTerminalNotifications();
    assert.equal(fs.existsSync(attempts), false);
    if (behavior === 'reservation-crash') process.exit(0);
    transport.ledger.confirmRecovery(original.requestKey, replacement);
  }
  if (behavior === 'unknown') await assert.rejects(transport.recoverTerminalNotifications(), /DCHAT_SEND_OUTCOME_UNKNOWN/);
  else if (behavior === 'account-changed') await assert.rejects(transport.recoverTerminalNotifications(), /DCHAT_BINDING_UNAVAILABLE/);
  else await transport.recoverTerminalNotifications();
} else {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-dchat-recovery-'));
  try {
    const make = (name, terminal) => {
      const file = path.join(temporary, name + '.json');
      const ledger = new DchatLedger(new DchatPrivateJson(file, () => true));
      const row = ledger.reserve(name, destination, 'synthetic-generation');
      ledger.bindExecution(row.requestKey, row.generation, execution.sessionId, execution.clientId, execution);
      ledger.transition(row.requestKey, row.generation, 'accepted');
      if (terminal) ledger.recordNativeTerminal(row.requestKey, execution, terminal);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      return file;
    };
    const run = (file, attempts, behavior = 'success') => {
      const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--child', file, attempts, behavior],
        { encoding: 'utf8', timeout: 20000 });
      assert.equal(result.status, 0, result.stderr || String(result.error));
    };
    const lines = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const success = make('confirmed-terminal', 'done'), sent = path.join(temporary, 'sent.jsonl');
    run(success, sent); run(success, sent);
    assert.equal(lines(sent).length, 1); assert.equal(lines(sent)[0].chatId, '300');
    assert.equal(lines(sent)[0].accountId, '100'); assert.match(lines(sent)[0].text, /Cindy/);
    const unknown = make('unknown-output', 'done'), unknownSends = path.join(temporary, 'unknown.jsonl');
    run(unknown, unknownSends, 'unknown'); run(unknown, unknownSends);
    assert.equal(lines(unknownSends).length, 1);
    const active = make('unconfirmed-active'), activeSends = path.join(temporary, 'active.jsonl');
    run(active, activeSends); assert.equal(lines(activeSends).length, 0);
    const changed = make('account-replaced', 'error'), changedSends = path.join(temporary, 'changed.jsonl');
    run(changed, changedSends, 'account-changed'); assert.equal(lines(changedSends).length, 0);
    const adopted = make('exact-adoption'), adoptedSends = path.join(temporary, 'adopted.jsonl');
    run(adopted, adoptedSends, 'takeover'); run(adopted, adoptedSends);
    assert.equal(lines(adoptedSends).length, 1);
    const unconfirmed = make('unconfirmed-adoption'), unconfirmedSends = path.join(temporary, 'unconfirmed-adoption.jsonl');
    run(unconfirmed, unconfirmedSends, 'reservation-crash'); run(unconfirmed, unconfirmedSends);
    assert.equal(lines(unconfirmedSends).length, 0);
    console.log(JSON.stringify({ status: 'passed', tier: 'integration', childProcesses: 10,
      checks: ['private receipts 0600', 'confirmed native terminal notified to original chat once across process restarts',
        'exact source/client/instance/generation adoption notifies once only after accepted confirmation',
        'crash before recovery acceptance remains interrupted without notification', 'unknown send never retried', 'active unconfirmed execution not replayed or guessed complete', 'account replacement blocks notification'],
      realDchatData: false, realCompanionExecution: false, activeExecutionResumptionVerified: false }));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
