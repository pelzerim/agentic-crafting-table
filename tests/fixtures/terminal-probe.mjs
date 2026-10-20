// Asks the terminal what a CLI asks at startup and prints what came back.
// With `wait`, it asks only after a key arrives.
process.stdin.setRawMode(true);
let received = '', asked = false;
function ask() {
  asked = true;
  process.stdout.write('\x1b[>q\x1b[?2026$p\x1b[?1016$p\x1b[c');
  setTimeout(() => process.stdout.write(`REPLIES:${JSON.stringify(received)}:END\r\n`), 600);
}
process.stdin.on('data', data => { if (asked) received += data.toString('latin1'); else ask(); });
if (process.argv[2] !== 'wait') ask();
setInterval(() => {}, 1000);
