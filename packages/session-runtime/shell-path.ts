import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Dock/Finder launches lack the user's shell PATH. Import PATH only, never shell output or credentials. */
export async function resolveShellPath(environment: NodeJS.ProcessEnv = process.env, home = homedir(), timeout = 3000): Promise<string> {
  const shell = environment.SHELL && isAbsolute(environment.SHELL) ? environment.SHELL : '/bin/zsh';
  const marker = `CRAFT_PATH_${randomUUID()}`;
  let discovered = '';
  try {
    const { stdout } = await promisify(execFile)(shell, ['-ilc', `printf '\\n${marker}\\n'; /usr/bin/printenv PATH`], {
      env: environment, cwd: home, timeout, maxBuffer: 256 * 1024,
    });
    discovered = stdout.split(`\n${marker}\n`)[1]?.split(/\r?\n/)[0] ?? '';
  } catch { /* Broken/slow shell profiles must not prevent starting the native terminal. */ }
  const candidates = [environment.PATH ?? '', discovered, join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin:/bin:/usr/sbin:/sbin'];
  return [...new Set(candidates.flatMap(path => path.split(':')).filter(path => isAbsolute(path) && !/[\r\n\0]/.test(path)))].join(':');
}
let path: Promise<string> | undefined;
export const sessionPath = () => path ??= resolveShellPath();
