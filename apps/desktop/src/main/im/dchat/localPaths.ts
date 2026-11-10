import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { DchatSetupPath } from '../../../shared/dchatConnection';

/** Inspect a bounded set of installed public tools; never run a command, read
 * messages, copy credentials, or install software while opening configuration. */
export async function detectDchatLocalPaths(options: { home: string; skillRoots: string[] },
  inspect = inspectDchatLocalPath): Promise<Partial<Record<DchatSetupPath, string>>> {
  const scripts = options.skillRoots.flatMap(root => [
    'xdt-agents/smartwork-cli/smartwork-shared/assets/dws-unix.sh',
    'smartwork-cli/smartwork-shared/assets/dws-unix.sh',
    'smartwork-im-bundle/smartwork-shared/assets/dws-unix.sh',
    'smartwork-shared/assets/dws-unix.sh',
  ].map(relative => path.join(root, relative)));
  const candidates: Record<DchatSetupPath, string[]> = {
    identityExecutable: scripts,
    sqlcipherExecutable: ['/opt/homebrew/bin/sqlcipher', '/usr/local/bin/sqlcipher'],
    component: [path.join('/Applications/D-Chat.app/Contents/MacOS/D-Chat'),
      path.join(options.home, 'Applications/D-Chat.app/Contents/MacOS/D-Chat')],
    databaseRoot: [path.join(options.home, 'Library/Application Support/com.dichat.desktop/D-Chat/CefChat')],
  };
  const result: Partial<Record<DchatSetupPath, string>> = {};
  await Promise.all((Object.keys(candidates) as DchatSetupPath[]).map(async field => {
    for (const candidate of candidates[field]) {
      const found = await inspect(candidate, field === 'databaseRoot');
      if (found) { result[field] = found; break; }
    }
  }));
  return result;
}

async function inspectDchatLocalPath(candidate: string, directory: boolean): Promise<string | null> {
  try {
    // Homebrew and managed skills use symlinks; the reader receives the real file.
    const file = await realpath(candidate), info = await lstat(file);
    if ((info.mode & 0o022) || (info.uid !== 0 && info.uid !== process.getuid?.())) return null;
    return (directory ? info.isDirectory() : info.isFile()) ? file : null;
  } catch { return null; }
}
