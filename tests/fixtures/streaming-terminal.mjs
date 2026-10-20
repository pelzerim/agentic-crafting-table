// Local typewriter workload; no provider, model, files or network access.
process.stdin.setRawMode(true); process.stdin.resume();
const total = 900;
let part = 0, timer, command = '', input = '', replies = 0;
const header = () => process.stdout.write(`\x1b7\x1b[1;1H\x1b[2KSTREAM INPUT ${input}\x1b8`);
const status = text => process.stdout.write(`\x1b7\x1b[2;1H\x1b[2K${text}\x1b8`);
const stop = text => { clearInterval(timer); timer = undefined; status(`${text} ${part}/${total}`); };
function stream() {
  if (timer) return;
  status('STREAM_ACTIVE');
  timer = setInterval(() => {
    // Deliberately split ANSI and UTF-8 across writes. PTY and renderer must
    // preserve the stream rather than decoding each packet independently.
    const text = Buffer.from(`\x1b[36mpart-${String(part).padStart(4, '0')}\x1b[0m Grüße 世界 🛠 ┌─┐ — ${'text '.repeat(9)}\r\n`);
    for (let i = 0; i < text.length; i += 7) process.stdout.write(text.subarray(i, i + 7));
    part++;
    if (part % 150 === 0) process.stdout.write('\x1b[6n');
    if (part === total) { stop(`STREAM_COMPLETE replies=${replies}`); process.stdout.write('FINAL_SENTENCE_COMPLETE.\r\n'); }
  }, 8);
}
function line(value) {
  if (value === 'start' || value === 'resume') stream();
  else if (value === 'pause') stop('SOURCE_PAUSED');
  else if (value.startsWith('ping')) { input = value; header(); }
}
process.stdin.on('data', data => {
  command += data.toString();
  // xterm's protocol replies must reach the CLI during live streaming; replay
  // must not inject them back into the process.
  command = command.replace(/\x1b\[\d+;\d+R/g, () => { replies++; return ''; });
  for (;;) {
    if (command.startsWith('\x03')) { command = command.slice(1); stop('SOURCE_INTERRUPTED'); continue; }
    const end = command.search(/[\r\n]/);
    if (end < 0) break;
    const value = command.slice(0, end); command = command.slice(end + 1); line(value);
  }
});
process.stdout.write(`\x1b[2J\x1b[H\x1b[?25l\x1b[3;${process.stdout.rows}r\x1b[3;1H`);
header(); status('STREAM_READY');
