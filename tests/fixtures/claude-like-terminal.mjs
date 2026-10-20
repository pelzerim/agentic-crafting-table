import { once } from 'node:events';

// Synthetic Claude Code-like output only: no provider, model, files or network.
// Each turn redraws an Ink-style live region in place (erase line + cursor up,
// truecolor spinner and status rows), then commits a block of coloured
// transcript lines (tool calls, results, diff rows with backgrounds) above it.
// Ends after the requested number of committed transcript lines.
const target = Number(process.argv[2] ?? 50_000), perTurn = 40, liveRows = 8, frames = 12;
const columns = process.stdout.columns || 100;
const rgb = i => `2;${40 + i * 37 % 200};${90 + i * 53 % 160};${120 + i * 71 % 130}`;
const spinner = ['✻', '✽', '✶', '✳', '✢', '·'];
let written = 0, printed = 0, turn = 0;
const write = async text => { written += Buffer.byteLength(text); if (!process.stdout.write(text)) await once(process.stdout, 'drain'); };
const erase = count => '\x1b[2K\x1b[1A'.repeat(count) + '\x1b[2K\x1b[G';
const live = (n, f) => [
  `\x1b[38;${rgb(n + f)}m${spinner[f % spinner.length]} \x1b[1mPondering…\x1b[22m \x1b[2m(${f}s · ↑ ${n * 31 % 9000} tokens · esc to interrupt)\x1b[0m`,
  '',
  `\x1b[38;5;244m╭${'─'.repeat(Math.max(10, columns - 2))}╮\x1b[0m`,
  `\x1b[38;5;244m│\x1b[0m > ${'draft prompt text '.repeat(3).slice(0, Math.max(0, columns - 6))}`,
  `\x1b[38;5;244m╰${'─'.repeat(Math.max(10, columns - 2))}╯\x1b[0m`,
  `  \x1b[38;5;214m⏵⏵ auto mode on\x1b[0m \x1b[2m(shift+tab to cycle)\x1b[0m`,
  `  \x1b[2mcontext ${(n * 7) % 100}% · turn ${n}\x1b[0m`,
  '',
].slice(0, liveRows);
const transcript = (n, i) => {
  if (i === 0) return `\x1b[38;${rgb(n)}m●\x1b[0m \x1b[1mUpdate\x1b[22m(packages/example/module-${n}.ts)`;
  if (i === 1) return `  \x1b[2m⎿\x1b[0m  Updated packages/example/module-${n}.ts with ${n % 17 + 1} additions and ${n % 5} removals`;
  const line = `${String(n * 10 + i).padStart(6)} ${i % 3 ? '+' : '-'}   const value${i} = compute(input.${'field'.repeat(1 + i % 4)}, options);`.slice(0, columns - 2);
  return `\x1b[48;${rgb(i)}m\x1b[38;5;${i % 3 ? 151 : 217}m${line}\x1b[0m`;
};

await write('\x1b[?2004h\x1b[?25l');
while (printed < target) {
  turn++;
  let previous = 0;
  for (let f = 0; f < frames; f++) {
    const rows = live(turn, f);
    await write(erase(previous) + rows.join('\r\n')); previous = rows.length - 1;
  }
  const block = Array.from({ length: perTurn }, (_, i) => transcript(turn, i));
  await write(erase(previous) + block.join('\r\n') + '\r\n'); printed += perTurn;
}
await write(`\x1b[?25h\x1b[?2004l\x1b[0mCLAUDE_LIKE_DONE lines=${printed} bytes=${written}\r\n`);
