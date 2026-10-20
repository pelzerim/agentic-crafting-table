// A local full-screen CLI with native mouse reporting or arrow-key scrolling.
// No model, provider, network, or user session is involved.
let mode = process.argv[2] || 'mouse', position = 100, up = 0, down = 0, column = 0, pending = '', identity = 'none', pixels = '?';
process.stdin.setRawMode(true);
function draw() {
  process.stdout.write('\x1b[H\x1b[2J' + `SCROLL:${position} UP:${up} DOWN:${down} MODE:${mode} COL:${column} TERM:${identity} PIXELS:${pixels}\r\n` +
    Array.from({ length: Math.max(1, process.stdout.rows - 2) }, (_, i) => `Conversation line ${position + i}`).join('\r\n'));
}
function configure() {
  process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?1l');
  if (mode === 'normal') {
    process.stdout.write('\x1b[?1049l\x1b[2J\x1b[H' + Array.from({ length: 250 }, (_, i) => `HISTORY:${String(i).padStart(3, '0')}\r\n`).join(''));
  } else {
    process.stdout.write('\x1b[?1049h' + (mode === 'mouse' ? '\x1b[?1000h\x1b[?1006h' : mode === 'legacy' ? '\x1b[?1000h' : '\x1b[?1h'));
    draw();
  }
}
process.stdin.on('data', data => {
  pending += data.toString('latin1');
  while (pending) {
    const version = /^\x1bP>\|([^\x1b]*)\x1b\\/.exec(pending);
    if (version) { identity = version[1]; pending = pending.slice(version[0].length); continue; }
    const pixelMode = /^\x1b\[\?1016;(\d)\$y/.exec(pending);
    if (pixelMode) { pixels = pixelMode[1]; pending = pending.slice(pixelMode[0].length); continue; }
    const report = /^(?:\x1b\[<(\d+);(\d+);\d+M|\x1b[\[O]([AB])|\x1b\[M([\s\S]{3}))/.exec(pending);
    if (report) {
      const code = (report[4] ? report[4].charCodeAt(0) - 32 : Number(report[1])) & 67;
      if (report[3] === 'A' || (report[1] || report[4]) && code === 64) { position--; up++; }
      if (report[3] === 'B' || (report[1] || report[4]) && code === 65) { position++; down++; }
      if (report[4]) column = report[4].charCodeAt(1) - 32;
      else if (report[2]) column = Number(report[2]);
      pending = pending.slice(report[0].length);
    } else if (pending.startsWith('\x1b') && pending.length < 32) break;
    else {
      const key = pending[0]; pending = pending.slice(1);
      if (key === 'n') { mode = 'normal'; configure(); }
      if (key === 'm' || key === 'a') { mode = key === 'm' ? 'mouse' : 'arrows'; position = 100; up = down = 0; configure(); }
      if (key === 'o') setTimeout(() => process.stdout.write('LATER_OUTPUT\r\n'), 250);
      if (key === 'q' || key === '\x03') process.exit(0);
    }
  }
  if (mode !== 'normal') draw();
});
process.stdout.on('resize', () => { if (mode !== 'normal') draw(); });
configure();
process.stdout.write('\x1b[>q\x1b[?1016$p');
