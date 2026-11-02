import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const defaultShell = (configured?: string | null) => configured || '/bin/zsh';
/** Arguments that start the shell as an interactive terminal. */
export const terminalShellArgs = () => ['-l'];
/** Arguments that make `shell` run `script` with the person's login profile loaded. */
export const profileScriptArgs = (script: string) => ['-ilc', script];
/** The command that runs `command` with extra `NAME=value` assignments. */
export const envCommand = (assignments: string[], command: string[]) => ({ command: '/usr/bin/env', args: [...assignments, ...command] });

/** The first executable called `name` on `searchPath`, then in `fallbackDirectories`. */
export function findExecutable(name: string, searchPath: string, fallbackDirectories: string[] = []) {
  const candidates = [...searchPath.split(delimiter).filter(Boolean), ...fallbackDirectories].map(directory => join(directory, name));
  return candidates.find(path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } });
}

/** Dock/Finder launches lack the user's shell PATH. Import PATH only, never shell output or credentials. */
export async function resolveShellPath(environment: NodeJS.ProcessEnv = process.env, home = homedir(), timeout = 3000): Promise<string> {
  const shell = defaultShell(environment.SHELL && isAbsolute(environment.SHELL) ? environment.SHELL : undefined);
  const marker = `CRAFT_PATH_${randomUUID()}`;
  let discovered = '';
  try {
    const { stdout } = await promisify(execFile)(shell, profileScriptArgs(`printf '\\n${marker}\\n'; /usr/bin/printenv PATH`), {
      env: environment, cwd: home, timeout, maxBuffer: 256 * 1024,
    });
    discovered = stdout.split(`\n${marker}\n`)[1]?.split(/\r?\n/)[0] ?? '';
  } catch { /* Broken/slow shell profiles must not prevent starting the native terminal. */ }
  const candidates = [environment.PATH ?? '', discovered, join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin:/bin:/usr/sbin:/sbin'];
  return [...new Set(candidates.flatMap(path => path.split(delimiter)).filter(path => isAbsolute(path) && !/[\r\n\0]/.test(path)))].join(delimiter);
}
let path: Promise<string> | undefined;
export const sessionPath = () => path ??= resolveShellPath();
