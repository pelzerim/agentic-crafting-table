import { createInterface } from 'node:readline';
import { once } from 'node:events';

// Synthetic output only. The actual desktop bridge, supervisor, PTY and xterm are used.
let timer, frame = 0, echo = '';
const render = () => {
  // Keep input echo in fixed columns, separate from the changing frame counter,
  // so the performance check can observe real rendered pixels with either renderer.
  const rows = [`PERF_STREAM ${++frame}`.padEnd(24) + echo, ...Array.from({ length: 28 }, (_, i) => `\x1b[${32 + i % 6}mTask ${i}: ${'progress '.repeat(7)}\x1b[0m`)];
  process.stdout.write('\x1b[H' + rows.map(row => '\x1b[2K' + row).join('\r\n'));
};
const lines = createInterface({ input: process.stdin });
lines.on('line', async line => {
  if (line === 'stream') { clearInterval(timer); process.stdout.write('\x1b[2J'); render(); timer = setInterval(render, 33); }
  else if (line.startsWith('ping')) { echo = `ECHO:${line}`; render(); }
  else if (line === 'burst') {
    clearInterval(timer);
    const block = ('synthetic terminal output '.repeat(3) + '\r\n').repeat(128);
    for (let i = 0; i < 440; i++) if (!process.stdout.write(block)) await once(process.stdout, 'drain');
    console.log('\r\nBURST_DONE');
  } else if (line === 'idle') { clearInterval(timer); console.log('\r\nPERF_IDLE'); }
});
console.log('PERF_READY');
