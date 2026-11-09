import { callDchatIpc, type DchatIpcResponse } from './ipc.js';
import type { DchatNative } from './transport.js';

export interface DchatMacIdentityReader {
  /** Fresh identity from the signed-in local D-Chat client; never user-supplied text. */
  identity(): Promise<{ accountId: string }>;
}
function data(response: DchatIpcResponse): Record<string, unknown> {
  if (response.success !== true || !response.data || typeof response.data !== 'object' || Array.isArray(response.data)) throw new Error('DCHAT_NATIVE_RESPONSE_INVALID');
  return response.data as Record<string, unknown>;
}
/** macOS IPC implementation. The database reader is a separate platform adapter. */
export class DchatMacNative implements DchatNative {
  constructor(private readonly reader: DchatMacIdentityReader, private readonly socketPath: string,
    private readonly deps = { platform: process.platform as string, call: callDchatIpc }) {}
  async identity(): Promise<{ accountId: string }> {
    if (this.deps.platform !== 'darwin') throw new Error('DCHAT_PLATFORM_UNSUPPORTED');
    const identity = await this.reader.identity();
    if (!/^\d{1,128}$/.test(identity.accountId)) throw new Error('DCHAT_IDENTITY_UNAVAILABLE');
    return identity;
  }
  async capabilities(): Promise<string[]> {
    const value = data(await this.deps.call('get_capabilities', {}, { socketPath: this.socketPath }));
    if (!Array.isArray(value.features) || value.features.some(feature => typeof feature !== 'string')) throw new Error('DCHAT_CAPABILITIES_UNAVAILABLE');
    return value.features as string[];
  }
  async send(input: { accountId: string; chatId: string; text: string; requestId: string; mode?: 'attributed' | 'clean-v2' }, options?: { isCurrent(): boolean }): Promise<{ messageId: string }> {
    if (!/^\d{1,128}$/.test(input.accountId) || !/^\d{1,128}$/.test(input.chatId)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.requestId)
      || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 100_000) throw new Error('DCHAT_INVALID_SEND');
    const clean = input.mode === 'clean-v2';
    if (input.mode !== undefined && !['attributed', 'clean-v2'].includes(input.mode)) throw new Error('DCHAT_INVALID_SEND');
    if (!(await this.capabilities()).includes(clean ? 'dchat_im_clean_send_v2' : 'content')) throw new Error(clean ? 'DCHAT_CLEAN_SEND_UNAVAILABLE' : 'DCHAT_ATTRIBUTED_SEND_UNAVAILABLE');
    if ((await this.identity()).accountId !== input.accountId) throw new Error('DCHAT_ACCOUNT_CHANGED');
    if (options?.isCurrent() === false) throw new Error('DCHAT_STALE_OUTPUT');
    // Ordinary text names Cindy visibly and preserves the stock client's source/footer.
    // Quotes and structured mentions are deliberately outside this text-only API.
    const result = data(await this.deps.call('send_text_message', { vchannelId: input.chatId, text: clean ? input.text : input.text + '\n\n— Cindy', mentions: [],
      content: { metadata: { disable_markdown: false, source: 'smartwork-cli', platform: 'pc' } },
      ...(clean ? { cleanSend: { version: 2, ownerId: input.accountId, requestId: input.requestId } } : {}) },
    { socketPath: this.socketPath, timeoutMs: 45_000, isCurrent: options?.isCurrent }));
    if (typeof result.resourceKey !== 'string' || !result.resourceKey || (result.vchannelId !== undefined && String(result.vchannelId) !== input.chatId)) throw new Error('DCHAT_SEND_UNCONFIRMED');
    // A resource acknowledgement is not the server message key.
    return { messageId: `resource:${result.resourceKey}` };
  }
}
