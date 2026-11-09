import { describe, expect, it } from 'vitest';
import { DchatLedger, type DchatDestination, type DchatLedgerStorage } from '../ledger';

/**
 * Test value: public receipt admission/output delivery and durable restart behavior.
 * Rules: im-turn-flow durable acceptance; credentials-and-local-storage owner isolation.
 * Gap: this is a new transport ledger, existing IM receipts do not exercise it.
 * Minimal failures: same message after restart; send timeout; account change before send.
 * Tier: unit, injected content-free storage and transport; no real accounts/network.
 */
function store() {
  let data: unknown = null; let fail = false;
  const storage: DchatLedgerStorage = { read: () => structuredClone(data), write: value => {
    if (fail) throw new Error('disk failure'); data = structuredClone(value);
  } };
  return { storage, fail: (value: boolean) => { fail = value; }, data: () => structuredClone(data) };
}
const destination = (botId = 'bot-a', chatId = 'group-a'): DchatDestination =>
  ({ accountId: 'account-a', connectionId: 'connection-a', botId, chatId, topicId: 'topic-a' });
function accepted(ledger: DchatLedger, messageId = 'message-a', dest = destination()) {
  const row = ledger.reserve(messageId, dest, 'generation-a')!;
  ledger.transition(row.requestKey, row.generation, 'accepted'); return row;
}

describe('DchatLedger', () => {
  it('does not replay accepted/reserved inputs after restart or teammate rebinding', () => {
    const s = store(); const ledger = new DchatLedger(s.storage);
    const row = accepted(ledger);
    const restarted = new DchatLedger(s.storage);
    expect(restarted.read(row.requestKey)?.state).toBe('unknown');
    expect(restarted.reserve(row.messageId, destination('bot-b'), 'generation-b')).toBeNull();
    const otherAccount = { ...destination(), accountId: 'account-b' };
    expect(restarted.reserve(row.messageId, otherAccount, 'generation-b')).not.toBeNull();
  });
  // A revoked native configuration cannot replay its queued inputs. Earlier
  // restart coverage only checked accepted inputs and teammate rebinding.
  it('resumes never-dispatched queued input only under its original persisted authorization', () => {
    const s = store(); const ledger = new DchatLedger(s.storage);
    const row = ledger.reserve('queued-input', destination(), 'generation-a', 'lease-a')!;
    ledger.transition(row.requestKey, row.generation, 'queued');
    const restarted = new DchatLedger(s.storage);
    expect(restarted.reserve(row.messageId, destination(), 'generation-b', 'lease-b')).toBeNull();
    expect(restarted.reserve(row.messageId, destination(), 'generation-b')).toBeNull();
    expect(restarted.reserve(row.messageId, destination(), 'generation-b', 'lease-a')?.state).toBe('reserved');
  });
  it('binds simultaneous partner outputs to their original account/chat/topic', async () => {
    const ledger = new DchatLedger(store().storage);
    const a = accepted(ledger, 'a', destination());
    const b = accepted(ledger, 'b', destination('bot-b', 'group-b'));
    const seen: string[] = [];
    await Promise.all([a, b].map(row => ledger.deliver(row.requestKey, row.generation, row.destination, 'final', async () => {
      seen.push(row.destination.chatId); return { messageId: `sent-${row.messageId}` };
    }, () => true)));
    expect(seen.sort()).toEqual(['group-a', 'group-b']);
    await expect(ledger.deliver(a.requestKey, a.generation, b.destination, 'another', async () => {
      throw new Error('must not submit');
    }, () => true)).rejects.toThrow('DCHAT_STALE_OUTPUT');
  });
  it('keeps unknown sends blocked across changed output IDs and restart', async () => {
    const s = store(); const ledger = new DchatLedger(s.storage); const row = accepted(ledger);
    let submits = 0;
    const send = async () => { submits++; throw new Error('timeout'); };
    await expect(ledger.deliver(row.requestKey, row.generation, row.destination, 'final', send, () => true)).rejects.toThrow('DCHAT_SEND_OUTCOME_UNKNOWN');
    await expect(ledger.deliver(row.requestKey, row.generation, row.destination, 'new-id', send, () => true)).rejects.toThrow('DCHAT_OUTPUT_ALREADY_ATTEMPTED');
    const restarted = new DchatLedger(s.storage);
    await expect(restarted.deliver(row.requestKey, row.generation, row.destination, 'new-id', send, () => true)).rejects.toThrow('DCHAT_STALE_OUTPUT');
    expect(submits).toBe(1);
  });
  it('rejects stale generations, disabled accounts and terminal/cancelled inputs before submission', async () => {
    const ledger = new DchatLedger(store().storage); const row = accepted(ledger); let submits = 0;
    const send = async () => { submits++; return { messageId: 'unexpected' }; };
    for (const [generation, live] of [['generation-b', true], [row.generation, false]] as const) {
      await expect(ledger.deliver(row.requestKey, generation, row.destination, 'final', send, () => live)).rejects.toThrow('DCHAT_STALE_OUTPUT');
    }
    ledger.transition(row.requestKey, row.generation, 'aborted');
    await expect(ledger.deliver(row.requestKey, row.generation, row.destination, 'final', send, () => true)).rejects.toThrow('DCHAT_STALE_OUTPUT');
    expect(submits).toBe(0);
  });
  it('does not submit when durable output reservation fails', async () => {
    const s = store(); const ledger = new DchatLedger(s.storage); const row = accepted(ledger);
    s.fail(true); let submitted = false;
    await expect(ledger.deliver(row.requestKey, row.generation, row.destination, 'final', async () => {
      submitted = true; return { messageId: 'bad' };
    }, () => true)).rejects.toThrow('disk failure');
    expect(submitted).toBe(false); s.fail(false);
    expect(Object.values(ledger.read(row.requestKey)!.outputs)).toEqual([]);
  });
  it('rejects corrupt ledgers without silently resetting deduplication', () => {
    expect(() => new DchatLedger({ read: () => ({ version: 9, receipts: [] }), write: () => { throw new Error('must not write'); } })).toThrow('DCHAT_LEDGER_INVALID');
  });
});
