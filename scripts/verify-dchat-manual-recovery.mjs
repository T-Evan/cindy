/** Integration: separate application-like Node processes, real private files,
 * production Continue entry and native facade/observer. Provider and D-Chat send
 * are synthetic; this does not validate a real model or Mac transport.
 * Run with pnpm exec tsx scripts/verify-dchat-manual-recovery.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { DchatIM } from '../packages/lizi-im/src/dchat/index.ts';
import { DchatLedger } from '../packages/lizi-im/src/dchat/ledger.ts';
import { DchatPrivateJson } from '../apps/desktop/src/main/im/dchat/privateJson.ts';
import { DchatRecoveryClaims } from '../apps/desktop/src/main/im/dchat/recoveryClaim.ts';
import { createDchatManualRecovery } from '../apps/desktop/src/main/im/dchat/manualRecovery.ts';
// Match the application's raw Markdown asset import for this Node-only harness.
const require = createRequire(import.meta.url);
const Module = require('node:module'), originalLoad = Module._load;
if (process.argv[4] === 'ipc') {
  // tsx/esbuild's CommonJS import.meta object lacks Vite's build-time env.
  // Empty build constants keep all real server endpoints unconfigured here.
  const compile = Module.prototype._compile;
  Module.prototype._compile = function(code, filename) { return compile.call(this, code.replace(/\bdefine_import_meta_default\.env\b/g, '({})'), filename); };
}
Module._load = function(specifier, parent, isMain) {
  if (typeof specifier === 'string' && specifier.endsWith('?raw')) return fs.readFileSync(
    require.resolve(specifier.slice(0, -4), { paths: [path.dirname(parent.filename)] }), 'utf8');
  if (process.argv[4] === 'ipc') {
    if (specifier === 'electron') return originalLoad.call(this, require.resolve('../apps/desktop/src/test/vitest/electron-stub.ts'), parent, isMain);
    // Leaf database host services are synthetic, as in the in-process IPC test.
    // The Continue handler, coordinator and durable recovery logic remain real.
    if (/localDb\/ipc\/messages(?:\.js)?$/.test(specifier)) return { createMessage: async () => ({ id: 'synthetic-message' }) };
    if (/localDb\/ipc\/sessions(?:\.js)?$/.test(specifier)) return { touchUserSendInDb: async () => {} };
  }
  return originalLoad.call(this, specifier, parent, isMain);
};
const { createDchatExecutionObserver } = await import('../apps/desktop/src/main/im/dchat/executionObserver.ts');
const { claimAppExitInputRecovery, appExitInputRecoveryPolicy, onAppExitInputRecovery } = require('../apps/desktop/src/main/maker-ipc/appExitInputRecovery.ts');
const { onInputRecovery, reserveInputRecovery, confirmInputRecovery, cancelInputRecovery } = require('../apps/desktop/src/main/maker-ipc/inputRecoverySignal.ts');
import { CONTINUE_AFTER_APP_EXIT_PROMPT } from '../apps/desktop/src/shared/interruptedTurn.ts';

const config = { accountId: '100', ownerId: '100', botId: 'synthetic-bot', connectionId: 'synthetic-connection',
  chats: [{ id: '300', kind: 'group' }], executeChatIds: ['300'], replyMode: 'automatic' };
const destination = { accountId: '100', connectionId: config.connectionId, botId: config.botId, chatId: '300', topicId: '' };
const old = { sessionId: 'synthetic-session', clientId: 'original-client', instanceId: 'original-instance', turnGeneration: 7 };
const host = { secrets: { write: () => true, read: () => null, remove() {}, isAvailable: () => true },
  ipc: { throwIpcError: () => { throw new Error('invalid'); }, handle() {}, broadcast() {} },
  paths: { feishuMediaDir: 'unused' }, httpPostForm: async () => ({ status: 500, body: null }) };
if (process.argv[2] === '--child') {
  const [directory, action, client = 'manual-client'] = process.argv.slice(3);
  const file = path.join(directory, 'receipts.json'), sent = path.join(directory, 'sends.jsonl'), providers = path.join(directory, 'providers.jsonl');
  const storage = new DchatPrivateJson(file, () => true);
  if (action === 'seed') {
    const ledger = new DchatLedger(storage), row = ledger.reserve('original-message', destination, 'original-runtime', 'revision-one');
    ledger.bindExecution(row.requestKey, row.generation, old.sessionId, old.clientId, old, { senderId: '200', isOwner: false });
    ledger.transition(row.requestKey, row.generation, 'accepted'); process.exit(0);
  }
  let revoked = false, account = '100';
  const listeners = new Set();
  const session = { id: old.sessionId, instanceId: 'new-process-instance', generation: 1,
    getTurnGeneration() { return this.generation; }, onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const im = new DchatIM(host, { config, storage, current: () => !revoked, authorizationKey: 'revision-one',
    bindingAvailable: async () => !revoked, draft: async () => {},
    native: { identity: async () => ({ accountId: account }), capabilities: async () => ['content'], send: async value => {
      fs.appendFileSync(sent, JSON.stringify({ chatId: value.chatId, text: value.text }) + '\n', { mode: 0o600 });
      if (action === 'unknown') throw new Error('SYNTHETIC_ACK_LOST');
      return { messageId: 'synthetic-sent' };
    } } });
  const observer = createDchatExecutionObserver({ im, current: () => !revoked, session: () => session, onSession: () => () => {}, onError: () => {} });
  await im.init(); await observer.restore();
  const store = new DchatRecoveryClaims(path.join(directory, 'claims'), () => !revoked);
  const deps = { owner: () => revoked ? null : 'synthetic-owner', sources: id => im.executionInputs().filter(r => r.execution?.sessionId === id),
    store: () => store, claimed: id => store.forClient(id), verify: row => im.verifyRecoverySource(row.requestKey, row.execution.clientId),
    supersede: row => im.supersedeRecovery(row.requestKey), runtime: () => ({ im, observer }), busy: () => false,
    policy: row => ({ context: { origin: { kind: 'im', channel: 'dchat', taskId: row.requestKey } } }), beginScope: () => () => {} };
  const manual = createDchatManualRecovery(deps), releaseHost = onAppExitInputRecovery(manual.host), releaseListener = onInputRecovery(manual.listener);
  const emit = status => {
    const event = { type: 'done', data: { status }, sessionInstanceId: session.instanceId, sessionTurnGeneration: session.generation };
    for (const fn of [...listeners]) fn(event);
  };
  try {
    if (action === 'ipc') {
      const { configureUserDataDir } = await import('../apps/desktop/src/main/userDataPath.ts');
      configureUserDataDir(path.join(directory, 'isolated-host-profile'));
      const { AgentInputCoordinator } = await import('../apps/desktop/src/main/maker-ipc/agent-input-coordinator.ts');
      const { createInputEnqueueHarness } = await import('../apps/desktop/src/main/maker-ipc/__tests__/inputEnqueueHarness.ts');
      // Execute the actual INPUT_ENQUEUE handler and real coordinator. The
      // synthetic provider reserves the native generation through the same
      // onVendorTurnReserved callback as Session.send, before emitting events.
      let running = false, dispatched = 0;
      const identity = item => ({ sessionId: session.id, clientId: item.clientId, instanceId: session.instanceId, turnGeneration: session.generation });
      const coordinator = new AgentInputCoordinator({
        sendToAgent: async (sid, message, _create, opts) => {
          appExitInputRecoveryPolicy(sid, opts.persistUserMessage?.clientId ?? '');
          session.generation++; opts.onVendorTurnReserved?.(session.generation);
          await opts.persistUserMessage?.onPersisted?.();
          fs.appendFileSync(providers, JSON.stringify({ clientId: opts.persistUserMessage?.clientId, text: message.content }) + '\n', { mode: 0o600 });
          running = true; return { kind: 'session-dispatch', source: 'synthetic-provider', dispatched: true };
        },
        beforeDispatchUserTurn: (_sid, item) => reserveInputRecovery(identity(item)),
        onDispatchedUserTurn: async (_sid, item) => { await confirmInputRecovery(identity(item)); dispatched++; },
        onUndispatchedUserTurn: (sid, item) => cancelInputRecovery(sid, item.clientId),
        onUserEnqueue: sid => cancelInputRecovery(sid),
        steerToAgent: async () => {}, abortSession: async () => { running = false; }, isTurnRunning: () => running,
        hasPendingInteraction: () => false, getAgentKind: () => 'claude-code', getSdkSessionId: async () => 'synthetic-sdk', emitProjection: () => {},
      });
      const queued = (id, text) => ({ clientId: id, text, persistedContent: text, model: 'synthetic-model', effort: 'medium', permissionMode: 'default', workingDir: directory,
        chatMessage: { clientId: id, role: 'user', content: text, isStreaming: false, createdAt: '2026-11-10T00:00:00.000Z' },
        createOpts: { agentKind: 'claude-code', workingDir: directory, model: 'synthetic-model', effort: 'medium', permissionMode: 'default', userPrompt: '', makerMemoryEnabled: true, displayReasoning: 'summarized' } });
      const until = async predicate => {
        const deadline = Date.now() + 5000;
        while (!predicate()) { assert.ok(Date.now() < deadline, 'coordinator dispatch timed out'); await new Promise(resolve => setImmediate(resolve)); }
      };
      try {
        const ipc = createInputEnqueueHarness(coordinator, { remote: false });
        await ipc.enqueue({}, session.id, queued(client, CONTINUE_AFTER_APP_EXIT_PROMPT));
        await until(() => dispatched === 1);
        assert.equal(store.forClient(client).state, 'confirmed');
        emit('done'); await until(() => fs.existsSync(sent));
        running = false; coordinator.onTurnEvent(session.id, 'done');
        await ipc.enqueue({}, session.id, queued('later-client', 'Independent later input'));
        await until(() => dispatched === 2);
        emit('done'); await im.recoverTerminalNotifications();
        assert.equal(fs.readFileSync(sent, 'utf8').trim().split('\n').length, 1);
      } finally { await coordinator.stop(session.id); }
    }
    else if (action === 'restore') { assert.equal(fs.existsSync(providers) ? fs.readFileSync(providers, 'utf8').trim().split('\n').length : 0, 1); }
    else if (action === 'restored-queue') assert.throws(() => appExitInputRecoveryPolicy(old.sessionId, client), /DCHAT_RECOVERY_INTERRUPTED/);
    else if (action === 'blocked') await assert.rejects(claimAppExitInputRecovery(old.sessionId, client, CONTINUE_AFTER_APP_EXIT_PROMPT), /DCHAT_RECOVERY_(CONSUMED|SETTLED|OUTPUT_ATTEMPTED)/);
    else {
      if (action === 'account') account = '999';
      if (action === 'account') await assert.rejects(claimAppExitInputRecovery(old.sessionId, client, CONTINUE_AFTER_APP_EXIT_PROMPT), /DCHAT_RECOVERY_REVOKED/);
      else {
        try { await claimAppExitInputRecovery(old.sessionId, client, CONTINUE_AFTER_APP_EXIT_PROMPT); }
        catch (error) { if (action === 'race' && /DCHAT_RECOVERY_CONSUMED/.test(String(error))) process.exit(48); throw error; }
        if (action === 'claimed-crash' || action === 'race') process.exit(0);
        const identity = { sessionId: session.id, clientId: client, instanceId: session.instanceId, turnGeneration: session.generation };
        assert.equal(appExitInputRecoveryPolicy(old.sessionId, client).context.origin.channel, 'dchat');
        // Same host lifecycle used by register.ts, triggered by a native send,
        // rather than loading replacement execution identities from fixture data.
        async function providerSend() {
          await reserveInputRecovery(identity);
          if (action === 'observing-crash') process.exit(0);
          if (action === 'cancel') { cancelInputRecovery(old.sessionId, client); emit('done'); return; }
          if (action === 'revoke') { revoked = true; await assert.rejects(confirmInputRecovery(identity), /DCHAT_ACCOUNT_CHANGED|DCHAT_/); return; }
          fs.appendFileSync(providers, JSON.stringify({ clientId: client, text: CONTINUE_AFTER_APP_EXIT_PROMPT }) + '\n', { mode: 0o600 });
          if (action === 'dispatch-crash') { emit('done'); process.exit(0); }
          if (action === 'confirmed-crash') { await confirmInputRecovery(identity); process.exit(0); }
          emit(action === 'failed' ? 'failed' : 'done');
          assert.equal(fs.existsSync(sent), false, 'sync terminal before host confirmation must be buffered');
          if (action === 'unknown') await confirmInputRecovery(identity).catch(error => assert.match(String(error), /DCHAT_SEND_OUTCOME_UNKNOWN/));
          else await confirmInputRecovery(identity);
          session.generation++; emit('done'); await im.recoverTerminalNotifications();
        }
        await providerSend();
        if (action === 'unknown') {
          await im.recoverTerminalNotifications();
          const rows = JSON.parse(fs.readFileSync(file, 'utf8')).receipts;
          assert.equal(Object.values(rows[0].outputs)[0].state, 'unknown');
        }
      }
    }
  } finally { releaseListener(); releaseHost(); observer.stop(); await im.dispose(); }
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-dchat-manual-process-'));
  let children = 0;
  const args = (directory, action, client) => ['--import', 'tsx', fileURLToPath(import.meta.url), '--child', directory, action, ...(client ? [client] : [])];
  const run = (directory, action, client) => {
    children++; const result = spawnSync(process.execPath, args(directory, action, client), { encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  };
  const lines = (directory, filename) => { const file = path.join(directory, filename); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; };
  try {
    for (const scenario of ['success', 'failed', 'unknown', 'claimed-crash', 'observing-crash', 'dispatch-crash', 'confirmed-crash', 'cancel', 'revoke', 'account']) {
      const dir = path.join(root, scenario); fs.mkdirSync(dir, { mode: 0o700 }); run(dir, 'seed'); run(dir, scenario);
      if (['claimed-crash', 'observing-crash', 'dispatch-crash', 'confirmed-crash'].includes(scenario)) { run(dir, 'restored-queue'); run(dir, 'blocked', 'another-client'); }
      if (['success', 'failed', 'unknown'].includes(scenario)) { run(dir, 'restore'); run(dir, 'restore'); }
      const attempts = lines(dir, 'sends.jsonl');
      assert.equal(attempts.length, ['success', 'failed', 'unknown'].includes(scenario) ? 1 : 0, scenario);
      if (attempts.length) { assert.equal(attempts[0].chatId, '300'); assert.match(attempts[0].text, /Cindy/); }
      const provider = lines(dir, 'providers.jsonl'); assert.ok(provider.length <= 1);
      for (const input of provider) assert.equal(input.text, CONTINUE_AFTER_APP_EXIT_PROMPT);
      assert.equal(fs.statSync(path.join(dir, 'receipts.json')).mode & 0o777, 0o600);
    }
    const ipc = path.join(root, 'ipc'); fs.mkdirSync(ipc, { mode: 0o700 }); run(ipc, 'seed'); run(ipc, 'ipc');
    assert.equal(lines(ipc, 'sends.jsonl').length, 1);
    assert.deepEqual(lines(ipc, 'providers.jsonl').map(row => row.text), [CONTINUE_AFTER_APP_EXIT_PROMPT, 'Independent later input']);
    const race = path.join(root, 'race'); fs.mkdirSync(race, { mode: 0o700 }); run(race, 'seed');
    const results = await Promise.all(['race-one', 'race-two'].map(client => new Promise((resolve, reject) => {
      children++; const child = spawn(process.execPath, args(race, 'race', client), { stdio: ['ignore', 'ignore', 'pipe'] });
      let error = ''; child.stderr.on('data', data => { error += data; }); child.on('error', reject);
      child.on('exit', code => { if (![0, 48].includes(code)) reject(new Error(error || String(code))); else resolve(code); });
    })));
    assert.deepEqual(results.sort(), [0, 48]);
    assert.equal(lines(race, 'providers.jsonl').length, 0);
    console.log(JSON.stringify({ status: 'passed', childProcesses: children, realPrivateFiles: true, productionContinueEntry: true,
      realDchat: false, realModel: false, checks: ['production IPC plus real coordinator in a new process', 'exact original input claim', 'cross-process concurrent claim exclusion',
        'crashes before enqueue/dispatch/confirmation/terminal never replay', 'restored queued claim rejected before send',
        'sync terminal waits for accepted dispatch', 'model failure status', 'cancel/account revocation', 'later generation excluded', 'unknown output never resent'] }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
