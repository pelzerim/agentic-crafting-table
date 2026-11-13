// A deterministic raw CLI: real PTY, no model or remote I/O.
process.stdin.setRawMode(true); process.stdin.resume();
const osc = (url, text) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
let draft = '', submitted = '', paste = false, buffer = '', mouse = 0, newlineInput = '';
function draw() {
  process.stdout.write('\x1b[2J\x1b[H' + [
    'Terminal interaction fixture',
    'https://example.com/pr/42?hello=world#review',
    osc('https://example.com/architecture?pr=42', 'Architecture overview'),
    'https://example.com/' + 'long-path/'.repeat(15) + 'end',
    osc('javascript:alert(1)', 'Invalid scheme'),
    `Draft: ${JSON.stringify(draft)}`, `Submitted: ${JSON.stringify(submitted)}`, `Mouse reports: ${mouse}`, `Newline input: ${newlineInput}`,
  ].join('\r\n'));
}
process.stdout.write((process.argv.includes('no-paste') ? '' : '\x1b[?2004h') + (process.argv.includes('mouse') ? '\x1b[?1000h\x1b[?1006h' : ''));
process.stdin.on('data', data => {
  buffer += data.toString();
  while (buffer) {
    if (buffer.startsWith('\x1b[200~')) { paste = true; buffer = buffer.slice(6); continue; }
    if (buffer.startsWith('\x1b[201~')) { paste = false; buffer = buffer.slice(6); continue; }
    if (buffer.startsWith('\x1b[13;2u')) { newlineInput = 'shift-enter'; draft += '\n'; buffer = buffer.slice(7); continue; }
    const report = /^\x1b\[<\d+;\d+;\d+[mM]/.exec(buffer);
    if (report) { mouse++; buffer = buffer.slice(report[0].length); continue; }
    if (buffer[0] === '\x1b') break;
    const char = buffer[0]; buffer = buffer.slice(1);
    if (char === '\x03') { process.stdout.write('\x1b[?2004l\x1b[?1000l\x1b[?1006l'); process.exit(0); }
    if (char === '\r' && !paste) { submitted = draft; draft = ''; }
    else { if (char === '\r') newlineInput = 'paste'; draft += char === '\r' ? '\n' : char; }
  }
  draw();
});
draw();
