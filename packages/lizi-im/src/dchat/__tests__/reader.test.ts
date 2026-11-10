import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ execFile: vi.fn(), lstat: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('node:fs/promises', () => ({ lstat: mocks.lstat }));
import { DchatCliReader } from '../reader';

// Unit: the official skill wrapper is mode 0644. Detecting its path is useless
// if the production reader attempts direct execution (EACCES). No process,
// account, installed skill, network or database is accessed by these tests.
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('installed D-Chat reader invocation', () => {
  it.each(['/synthetic/with space/dws-unix.sh', '/synthetic/dws-readonly'])(
    'supports the selected wrapper %s without shell interpolation or provider credentials', async executable => {
      vi.stubGlobal('process', { ...process, platform: 'darwin', getuid: () => 501,
        env: { PATH: '/synthetic/bin', HOME: '/synthetic/home', ANTHROPIC_API_KEY: 'synthetic-not-a-key' } });
      mocks.lstat.mockResolvedValue({ isFile: () => true, mode: 0o100644, uid: 501 });
      mocks.execFile.mockImplementation((_command, _args, _options, done) => done(null, JSON.stringify({ ok: true, data: { user: { id: '101' } } })));
      expect(await new DchatCliReader(executable).identity()).toEqual({ accountId: '101' });
      const [command, args, options] = mocks.execFile.mock.calls[0];
      expect(command).toBe(executable.endsWith('.sh') ? '/bin/bash' : executable);
      expect(args).toEqual([...(executable.endsWith('.sh') ? [executable] : []), '--output', 'json', 'user', 'info', '--self']);
      expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(options.shell).toBeUndefined();
    });
});
