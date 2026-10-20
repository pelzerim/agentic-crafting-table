import { spawn } from 'node-pty';
import { tmpdir } from 'node:os';

/** A real, bounded input/output/resize check for the packaged native module. */
export function smokePty(): Promise<{ input: true; resize: true; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const terminal = spawn('/bin/sh', ['-c', 'printf "ACT_READY\\n"; read value; printf "ACT_INPUT:%s\\n" "$value"; stty size'], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: tmpdir(), env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
    });
    let output = '', sent = false;
    const timer = setTimeout(() => { terminal.kill(); reject(new Error('PTY smoke timed out')); }, 10_000);
    terminal.onData(data => {
      output += data;
      if (!sent && output.includes('ACT_READY')) {
        sent = true;
        terminal.resize(61, 19);
        terminal.write('crafting-table\r');
      }
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode !== 0 || !output.includes('ACT_INPUT:crafting-table') || !/19\s+61/.test(output)) {
        reject(new Error(`PTY smoke failed (exit ${exitCode}): ${output}`));
      } else resolve({ input: true, resize: true, exitCode });
    });
  });
}
