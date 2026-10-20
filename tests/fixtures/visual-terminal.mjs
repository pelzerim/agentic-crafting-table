// Static, synthetic ANSI screen through the actual PTY. No model or external I/O.
function draw() {
  const rows = process.stdout.rows || 24;
  if (process.argv.includes('dense')) {
    process.stdout.write('\x1b[2J\x1b[H' + Array.from({ length: rows - 1 }, (_, row) =>
      (row === 0 ? 'Billing workspace ' : `Line ${row} `) + 'Repeated terminal output: ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 '.repeat(8).slice(0, process.stdout.columns - 10)).join('\r\n') +
      `\x1b[${rows};1HLast terminal row · ready for input · ${process.stdout.columns} × ${rows}`);
    return;
  }
  process.stdout.write('\x1b[2J\x1b[H' +
    '\x1b[1;36mBilling workspace\x1b[0m\r\n\r\n' +
    '\x1b[32m✓\x1b[0m Read project context\r\n' +
    '\x1b[32m✓\x1b[0m Updated plan-switching flow\r\n' +
    '\x1b[33m?\x1b[0m Should downgrades apply next billing cycle?\r\n\r\n' +
    '  API → billing service → subscription store\r\n' +
    `\x1b[${rows};1H\x1b[90mLast terminal row · ready for input · ${process.stdout.columns} × ${rows}\x1b[0m`);
}
process.stdout.write('\x1b[?1049h\x1b[?25l');
process.stdout.on('resize', draw);
process.stdin.resume();
process.stdin.on('data', draw);
draw();
