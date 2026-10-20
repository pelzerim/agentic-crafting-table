// Deterministic Unicode table, emitted through the real PTY without a model.
import { spawnSync } from 'node:child_process';
export const table = [
  '┌────────────┬───────────┐',
  '│ Copy test  │ 120–340KB │',
  '├────────────┼───────────┤',
  '│ Grüße     │ 世界 🛠   │',
  '└────────────┴───────────┘',
].join('\r\n');
process.stdout.write('\x1b[2J\x1b[H' + table + '\r\n');
process.stdin.resume();
if (process.argv.includes('native-selection')) {
  // A CLI that owns selection receives mouse reports instead of an xterm
  // selection and writes the native pasteboard on release. No model involved.
  process.stdin.setRawMode(true);
  process.stdout.write('\x1b[?1000h\x1b[?1006h');
  process.stdin.on('data', data => {
    if (!/\x1b\[<\d+;\d+;\d+m/.test(data.toString())) return;
    const result = spawnSync('/usr/bin/pbcopy', [], { input: table.replaceAll('\r\n', '\n'), env: process.env });
    if (result.status !== 0) process.exit(1);
    process.stdout.write('\x1b[7;1HCOPIED_BY_NATIVE_FIXTURE');
  });
}
