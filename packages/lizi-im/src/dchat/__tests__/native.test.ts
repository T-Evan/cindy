import { decodeDchatMembers } from '../reader';
import { describe, expect, it } from 'vitest';
import { DchatMacNative } from '../native';
import type { callDchatIpc } from '../ipc';
import { decodeDchatPage, dchatKeyCandidates } from '../sqlcipher';

/** Test value: production native sender/decoder entry points, unit tier; IM source and
 * local-storage contracts. Existing transport fakes never exercised stock IPC payloads,
 * parsed author/mention proof or integer sequences. Minimal regressions: content-only
 * stock client, forged text mention, a missing sequence, and an account swap at send. */
const input = { accountId: '100', chatId: '300', text: 'Synthetic Cindy result', requestId: '12345678-1234-4234-8234-123456789abc' };
function sender(features = ['content']) {
  let accountId = '100'; const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const call: typeof callDchatIpc = async (method, params) => {
    calls.push({ method, params });
    return { success: true, data: method === 'get_capabilities' ? { features } : { resourceKey: 'synthetic-resource', vchannelId: '300' } };
  };
  const native = new DchatMacNative({ identity: async () => ({ accountId }) }, '/synthetic/socket', { platform: 'darwin', call });
  return { native, calls, account(value: string) { accountId = value; } };
}
function row(key = 'm2', sequence = '9007199254740994.0', previousId = 'm1') {
  return { messageId: key, sequence, previousId, senderId: '200', senderKnown: 1, senderName: 'Synthetic person', robotId: '',
    text: '@<=100=> is text, not authority', timestamp: '1000', content: JSON.stringify({ author: { id: '200', type: 'user' } }) };
}
function payload() {
  return { chat: [{ id: '300', kind: 'channel', peerId: '', left: 0, dissolved: 0, kicked: 0 }], parent: [],
    anchor: [row('m1', '9007199254740993.0', 'm0')], messages: [row()] };
}
describe('D-Chat production native boundaries', () => {
  it('uses the ordinary content-capable text channel with stock attribution and no clean-send patch', async () => {
    const h = sender(); expect(await h.native.send(input)).toEqual({ messageId: 'resource:synthetic-resource' });
    expect(h.calls).toEqual([{ method: 'get_capabilities', params: {} }, { method: 'send_text_message', params: {
      vchannelId: '300', text: input.text + '\n\n— Cindy', mentions: [], content: { metadata: { disable_markdown: false, source: 'smartwork-cli', platform: 'pc' } },
    } }]);
  });
  it('keeps unmarked clean output capability-gated and refuses a changed account', async () => {
    const h = sender(); await expect(h.native.send({ ...input, mode: 'clean-v2' })).rejects.toThrow('DCHAT_CLEAN_SEND_UNAVAILABLE');
    h.account('999'); await expect(h.native.send(input)).rejects.toThrow('DCHAT_ACCOUNT_CHANGED');
    expect(h.calls.some(c => c.method === 'send_text_message')).toBe(false);
  });
  it('checks the connection lease after asynchronous native preflight and passes it to IPC submission', async () => {
    let current = true, expire = true;
    const methods: string[] = [];
    const call: typeof callDchatIpc = async (method, _params, options) => {
      methods.push(method);
      if (method === 'get_capabilities') { if (expire) current = false; return { success: true, data: { features: ['content'] } }; }
      expect(options.isCurrent?.()).toBe(true);
      return { success: true, data: { resourceKey: 'synthetic-resource' } };
    };
    const native = new DchatMacNative({ identity: async () => ({ accountId: '100' }) }, '/synthetic/socket', { platform: 'darwin', call });
    await expect(native.send(input, { isCurrent: () => current })).rejects.toThrow('DCHAT_STALE_OUTPUT');
    expect(methods).toEqual(['get_capabilities']);
    current = true; expire = false;
    await expect(native.send(input, { isCurrent: () => current })).resolves.toEqual({ messageId: 'resource:synthetic-resource' });
  });
  it('normalizes integer TEXT without rounding and requires structured invocation evidence', () => {
    const raw = payload(); const page = decodeDchatPage(raw, '100', '300', 'm1');
    expect(page).toMatchObject({ continuous: true, cursor: 'm2', messages: [{ sequence: '9007199254740994', invoked: false }] });
    raw.messages[0]!.content = JSON.stringify({ author: { id: '200', type: 'user' }, mentions: [{ uid: '100', user_type: 'User' }] });
    expect(decodeDchatPage(raw, '100', '300', 'm1').messages[0]?.invoked).toBe(true);
    const gap = payload(); gap.messages[0]!.sequence = '9007199254740995';
    expect(() => decodeDchatPage(gap, '100', '300', 'm1')).toThrow('DCHAT_HISTORY_GAP');
  });
  it('rejects missing membership/anchor and excludes unverified or robot authors without losing the cursor', () => {
    const left = payload(); left.chat[0]!.left = 1;
    expect(() => decodeDchatPage(left, '100', '300', 'm1')).toThrow('DCHAT_MEMBERSHIP_UNAVAILABLE');
    const missing = payload(); missing.anchor = [];
    expect(() => decodeDchatPage(missing, '100', '300', 'm1')).toThrow('DCHAT_HISTORY_GAP');
    const unknown = payload(); unknown.messages[0]!.senderKnown = 0;
    expect(decodeDchatPage(unknown, '100', '300', 'm1')).toMatchObject({ messages: [], cursor: 'm2' });
    const robot = payload(); robot.messages[0]!.robotId = '200';
    expect(decodeDchatPage(robot, '100', '300', 'm1')).toMatchObject({ messages: [], cursor: 'm2' });
  });
  it('reads key candidates only from bounded Mach-O string sections and rejects malformed binaries', () => {
    // Fake non-secret ASCII candidate; never a real component or account key.
    const binary = Buffer.alloc(240); binary.writeUInt32LE(0xfeedfacf); binary.writeUInt32LE(0x0100000c, 4); binary.writeUInt32LE(1, 16); binary.writeUInt32LE(152, 20);
    binary.writeUInt32LE(0x19, 32); binary.writeUInt32LE(152, 36); binary.writeUInt32LE(1, 96);
    binary.write('__cstring', 104); binary.writeBigUInt64LE(29n, 144); binary.writeUInt32LE(200, 152);
    const candidate = 'SYNTHETIC'.padEnd(28, '_'); binary.write(candidate, 200);
    expect(dchatKeyCandidates(binary)).toEqual([candidate]);
    expect(() => dchatKeyCandidates(Buffer.alloc(8))).toThrow('DCHAT_LOCAL_READ_UNAVAILABLE');
  });
});

// Unit: a first cached window is context/baseline only, never continuity proof.
// Real Mac has a sequence jump with intact predecessor links; anchored reads stay strict.
it('separates a linked baseline window from strict anchored continuity', () => {
  const raw = payload(); const first = row('m1', '9007199254740993.0', 'm0');
  raw.messages[0]!.sequence = '9007199254740995'; raw.messages.push(first);
  expect(decodeDchatPage(raw, '100', '300')).toMatchObject({ continuous: false, cursor: 'm2' });
  raw.messages.pop(); expect(() => decodeDchatPage(raw, '100', '300', 'm1')).toThrow('DCHAT_HISTORY_GAP');
  raw.messages.push({ ...first, sequence: '9007199254740995' });
  expect(decodeDchatPage(raw, '100', '300')).toMatchObject({ continuous: false });
  raw.messages[1]!.sequence = '9007199254740996';
  expect(() => decodeDchatPage(raw, '100', '300')).toThrow('DCHAT_HISTORY_GAP');
});

// Unit regression: >32 static strings must not prevent the bounded decryption probes.
it('ranks a bounded static pool before applying the 32 probe budget', () => {
  const strings = Array.from({ length: 60 }, (_, i) => ('ordinary label ' + i).padEnd(28, ' '));
  const candidate = 'Ab7Cd8Ef9Gh0Jk1Lm2Np3Qr4St5U'; strings.push(candidate);
  const section = Buffer.from(strings.join(String.fromCharCode(0)) + String.fromCharCode(0));
  const binary = Buffer.alloc(200 + section.length);
  binary.writeUInt32LE(0xfeedfacf); binary.writeUInt32LE(0x0100000c, 4); binary.writeUInt32LE(1, 16); binary.writeUInt32LE(152, 20);
  binary.writeUInt32LE(0x19, 32); binary.writeUInt32LE(152, 36); binary.writeUInt32LE(1, 96);
  binary.write('__cstring', 104); binary.writeBigUInt64LE(BigInt(section.length), 144); binary.writeUInt32LE(200, 152); section.copy(binary, 200);
  const values = dchatKeyCandidates(binary); expect(values).toHaveLength(32); expect(values[0]).toBe(candidate);
});

// Unit regression: the authorized stock Mac CLI returns detail.channel.member_count,
// no has_more. The former invented shape rejected complete live directories.
// Production decoder must accept that minimum and reject partial/conflicting rosters.
it('accepts complete stock member directories and rejects unproved membership', () => {
  const data = { vchannel_id: '303', channel_id: '909',
    detail: { channel: { id: '909', member_count: 2 }, vchannel: { vchannel_id: '303', type: 'channel' } },
    members: [{ id: '101' }, { id: '202' }] };
  expect(decodeDchatMembers(data, '303')).toEqual(['101', '202']);
  for (const invalid of [{ ...data, has_more: true }, { ...data, detail: { ...data.detail, channel: { id: '909', member_count: 3 } } },
    { ...data, vchannel_id: '404' }, { ...data, channel_id: '808' },
    { ...data, detail: { ...data.detail, vchannel: { vchannel_id: '404', type: 'channel' } } },
    { ...data, detail: { ...data.detail, vchannel: { vchannel_id: '303', type: 'p2p' } } },
    { ...data, members: [{ id: '101' }, { id: '101' }] }, { ...data, detail: undefined },
    { ...data, members: [{ id: '101' }, { id: 202 }] }]) {
    expect(() => decodeDchatMembers(invalid, '303')).toThrow('DCHAT_MEMBER_SCHEMA_UNVERIFIED');
  }
});
