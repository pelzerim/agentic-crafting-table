import { createInterface } from 'node:readline';
import { once } from 'node:events';

// Synthetic full-screen agent output only: no provider, model, files or network.
// Imitates an Ink-style CLI that erases and redraws its live region per frame,
// colours with truecolor SGR and periodically clears screen plus scrollback
// before reprinting its transcript.
const megabytes = Number(process.argv[2] ?? 48), target = megabytes * 1024 * 1024;
const columns = process.stdout.columns || 100;
const colour = i => `\x1b[38;2;${40 + i * 37 % 200};${90 + i * 53 % 160};${120 + i * 71 % 130}m`;
const transcript = [];
let written = 0, frame = 0;
const write = async text => { written += Buffer.byteLength(text); if (!process.stdout.write(text)) await once(process.stdout, 'drain'); };
const live = n => Array.from({ length: 12 }, (_, i) => `${colour(n + i)}│ ${`frame ${n} row ${i} `.padEnd(24)}\x1b[1m✻\x1b[22m ${'thinking about the change '.repeat(3)}`.slice(0, columns + 40) + '\x1b[0m');
const erase = count => '\x1b[2K\x1b[1A'.repeat(count) + '\x1b[2K\x1b[G';

await write('\x1b[?2004h\x1b[?1004h\x1b[?25l');
let previous = 0;
while (written < target) {
  frame++;
  if (frame % 40 === 0) {
    transcript.push(`${colour(frame)}● Turn ${frame / 40}: edited packages/example/file-${frame}.ts\x1b[0m`, `  ⎿ ${'Updated 12 lines, removed 4 lines '.repeat(2)}`);
    const reprint = transcript.slice(-400).join('\r\n');
    await write(`\x1b[2J\x1b[3J\x1b[H${reprint}\r\n`); previous = 0;
  }
  const rows = live(frame);
  await write(erase(previous) + rows.join('\r\n')); previous = rows.length - 1;
}
await write(`${erase(previous)}\x1b[?25h\x1b[0mHUGE_DONE frames=${frame} bytes=${written}\r\n`);
const lines = createInterface({ input: process.stdin });
// Focus reports (mode 1004) are not typed text; bracketed paste markers stay visible.
lines.on('line', line => { line = line.replace(/\x1b\[[IO]/g, '').replace('\x1b[200~', '<paste>').replace('\x1b[201~', '</paste>'); if (line === 'exit') process.exit(0); console.log(`HUGE_ECHO:${line}`); });
