// A full-screen program drawn by cursor moves: writes more than a view replays, then notes each window-size change.
import { appendFileSync } from 'node:fs';

const [file, megabytes = '2'] = process.argv.slice(2);
let written = 0, frame = 0;
const target = Number(megabytes) * 1024 * 1024;
while (written < target) {
  const chunk = `\x1b[1;1H\x1b[38;2;44;49;46m\x1b[48;2;20;24;22mframe ${frame++} ${'·'.repeat(60)}\x1b[2;1H\x1b[0mWorking ${frame}`;
  process.stdout.write(chunk); written += Buffer.byteLength(chunk);
}
process.on('SIGWINCH', () => appendFileSync(file, 'WINCH\n'));
process.stdout.write('\x1b[3;1HWINCH_READY');
setInterval(() => {}, 1000);
