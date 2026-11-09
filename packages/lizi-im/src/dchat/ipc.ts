/** D-Chat WorkspaceServer nanomsg REQ/REP wire adapter. No retries or client patching. */
import { randomInt } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';

export interface DchatIpcResponse { success: boolean; data?: unknown; error?: { code?: string } }
export class DchatIpcError extends Error {
  constructor(readonly code: string, readonly submitted: boolean) { super(`DCHAT_IPC_${code}`); }
}
const hello = Buffer.from('0053500000300000', 'hex');
const replyHello = Buffer.from('0053500000310000', 'hex');
/** Only call known methods; identity/database adapters must provide verified account identity. */
export async function callDchatIpc(method: 'get_capabilities' | 'list_conversations' | 'send_text_message',
  params: Record<string, unknown>, options: { socketPath: string; timeoutMs?: number; signal?: AbortSignal }): Promise<DchatIpcResponse> {
  if (process.platform !== 'darwin') throw new DchatIpcError('PLATFORM_UNSUPPORTED', false);
  if (!options.socketPath.startsWith('/') || options.socketPath.includes('\0')) throw new DchatIpcError('INVALID_SOCKET', false);
  const info = await lstat(options.socketPath).catch(() => null);
  if (!info?.isSocket() || info.uid !== process.getuid?.()) throw new DchatIpcError('SOCKET_UNAVAILABLE', false);
  const body = Buffer.from(JSON.stringify({ method, params }));
  if (body.length > 2_000_000) throw new DchatIpcError('REQUEST_TOO_LARGE', false);
  const requestId = 0x80000000 + randomInt(1, 0x80000000);
  const request = Buffer.alloc(13 + body.length); request[0] = 1;
  request.writeBigUInt64BE(BigInt(body.length + 4), 1); request.writeUInt32BE(requestId, 9); body.copy(request, 13);
  if (options.signal?.aborted) throw new DchatIpcError('ABORTED', false);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: options.socketPath });
    let submitted = false, settled = false, handshaken = false, pending = Buffer.alloc(0);
    const finish = (code?: string, value?: DchatIpcResponse): void => {
      if (settled) return; settled = true; clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort); socket.destroy();
      if (code) reject(new DchatIpcError(code, submitted)); else resolve(value!);
    };
    const abort = (): void => finish('ABORTED');
    const timer = setTimeout(() => finish('TIMEOUT'), options.timeoutMs ?? 3000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) return abort();
    socket.on('connect', () => { socket.write(hello); });
    socket.on('error', () => finish('DISCONNECTED'));
    socket.on('close', () => finish('DISCONNECTED'));
    socket.on('data', chunk => {
      if (settled) return;
      if (pending.length + chunk.length > 8_000_017) return finish('RESPONSE_TOO_LARGE');
      pending = Buffer.concat([pending, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      if (!handshaken) {
        if (pending.length < 8) return;
        if (!pending.subarray(0, 8).equals(replyHello)) return finish('PROTOCOL');
        pending = pending.subarray(8); handshaken = true; submitted = true; socket.write(request);
      }
      if (pending.length < 9) return;
      if (pending[0] !== 1) return finish('PROTOCOL');
      const length = pending.readBigUInt64BE(1);
      if (length < 4n || length > 8_000_000n) return finish('PROTOCOL');
      if (pending.length < 9 + Number(length)) return;
      if (pending.length !== 9 + Number(length) || pending.readUInt32BE(9) !== requestId) return finish('PROTOCOL');
      try {
        // IDs must be strings; refusing rounded numbers is safer than guessing identities.
        const value = JSON.parse(pending.subarray(13).toString('utf8'), (key, item: unknown) => {
          if (key === '__proto__' || key === 'constructor' || (typeof item === 'number' && Number.isInteger(item) && !Number.isSafeInteger(item))) throw new Error('invalid');
          return item;
        }) as DchatIpcResponse;
        if (!value || typeof value !== 'object' || typeof value.success !== 'boolean') return finish('PROTOCOL');
        finish(undefined, value);
      } catch { finish('PROTOCOL'); }
    });
  });
}
