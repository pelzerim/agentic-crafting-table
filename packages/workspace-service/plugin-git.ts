import { execFile } from 'node:child_process';
import { devNull } from 'node:os';
import { sessionPath } from '../platform/shell.ts';

export class GitError extends Error {}
export type GitRunner = (args: readonly string[], options: { cwd?: string; timeoutMs: number }) => Promise<string>;

/** Hardening applied to every invocation: no command transports, hooks or interactive prompts. */
export const GIT_SAFETY = ['-c', 'protocol.ext.allow=never', '-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-c', 'credential.interactive=never'] as const;

const lastLine = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean).at(-1) ?? '';
/** Drops embedded credentials from git's own messages. */
export const redactGit = (text: string) => text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^@/\s]+@/gi, '$1').slice(0, 400);

/** Runs the user's git without a shell, with their SSH agent and credential helpers, and a hard timeout. */
export const nativeGit: GitRunner = async (args, { cwd, timeoutMs }) => {
  const env = { ...process.env, PATH: await sessionPath(), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never' };
  return new Promise((resolve, reject) => {
    execFile('git', [...GIT_SAFETY, ...args], { cwd, env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) { resolve(stdout); return; }
      const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
      if (failure.code === 'ENOENT') reject(new GitError('Git is not installed or not on your PATH. Install the Xcode command line tools or Git, then try again.'));
      else if (failure.killed || failure.signal === 'SIGKILL') reject(new GitError(`git ${args[0]} did not finish within ${Math.round(timeoutMs / 1000)} s.`));
      else reject(new GitError(redactGit(lastLine(String(stderr)) || `git ${args[0]} failed`)));
    });
  });
};
