import { createInterface } from 'node:readline';

// Deterministic executable running through a real PTY, with no provider/model calls.
console.log(`READY:${process.pid}`);
process.stdout.on('resize', () => console.log(`RESIZE:${process.stdout.columns}:${process.stdout.rows}`));
process.on('SIGINT', () => console.log('CONTROL:SIGINT'));
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  if (line === 'exit') process.exit(0);
  if (line === 'colors') console.log(`COLORS:${process.env.TERM}:${process.env.COLORTERM}:${process.env.NO_COLOR ?? 'unset'}:${process.env.FORCE_COLOR ?? 'unset'}\x1b[32m GREEN\x1b[0m`);
  if (line === 'size') console.log(`SIZE:${process.stdout.columns}:${process.stdout.rows}`);
  else if (line === 'flood' || line === 'flood-large') { process.stdout.write('x'.repeat(1024 * 1024 * (line === 'flood-large' ? 20 : 1))); console.log('\nFLOOD_DONE'); }
  else console.log(`RECEIVED:${line}`);
});
