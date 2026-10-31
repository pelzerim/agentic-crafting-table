import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';

export const powerShell = (systemRoot = process.env.SystemRoot ?? 'C:\\Windows') => win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
/** Git Bash exports a POSIX `SHELL` that Windows cannot start, so only a drive path counts as configured there. */
export function defaultShell(configured?: string | null, platform: NodeJS.Platform = process.platform) {
  if (platform === 'win32') return configured && /^[A-Za-z]:[\\/]/.test(configured) ? configured : powerShell();
  return configured || '/bin/zsh';
}
/** Arguments that start the shell as an interactive terminal. */
export const terminalShellArgs = (platform: NodeJS.Platform = process.platform) => platform === 'win32' ? [] : ['-l'];
/** Arguments that make `shell` run `script` with the person's login profile loaded. */
export const profileScriptArgs = (script: string) => ['-ilc', script];
/** The command that runs `command` with extra `NAME=value` assignments.
 * Windows has no `env`, so `cmd.exe` assigns them. It reads `&`, `%` and the like inside an unquoted word as syntax, and spawn only quotes words with spaces. */
export function envCommand(assignments: string[], command: string[], platform: NodeJS.Platform = process.platform) {
  if (platform !== 'win32') return { command: '/usr/bin/env', args: [...assignments, ...command] };
  if (!assignments.length) return { command: command[0], args: command.slice(1) };
  if ([...assignments, ...command].some(part => /[&|<>^%!"]/.test(part))) throw new Error('A path contains a character that cmd.exe cannot pass safely');
  return { command: 'cmd.exe', args: ['/d', '/c', ...assignments.flatMap(assignment => ['set', `${assignment}&&`]), ...command] };
}
/** Windows names are case-insensitive, and `{ ...process.env, PATH }` leaves the inherited `Path` beside the new `PATH`. */
export const isShadowedPath = (key: string, platform: NodeJS.Platform = process.platform) => platform === 'win32' && key !== 'PATH' && key.toUpperCase() === 'PATH';
/** The file an executable called `name` has. Windows batch shims stay out: their arguments cannot be quoted safely. */
export const executableName = (name: string, platform: NodeJS.Platform = process.platform) => platform === 'win32' ? `${name}.exe` : name;

/** The first executable called `name` on `searchPath`, then in `fallbackDirectories`. */
export function findExecutable(name: string, searchPath: string, fallbackDirectories: string[] = []) {
  const candidates = [...searchPath.split(delimiter).filter(Boolean), ...fallbackDirectories].map(directory => join(directory, executableName(name)));
  return candidates.find(path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } });
}

/** Dock/Finder launches lack the user's shell PATH. Import PATH only, never shell output or credentials. */
export async function resolveShellPath(environment: NodeJS.ProcessEnv = process.env, home = homedir(), timeout = 3000): Promise<string> {
  // Windows gives every launch the PATH from the registry; there is no login shell to ask.
  if (process.platform === 'win32') return [...new Set([...(environment.PATH ?? '').split(delimiter), join(home, '.local/bin')].filter(path => isAbsolute(path)))].join(delimiter);
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
