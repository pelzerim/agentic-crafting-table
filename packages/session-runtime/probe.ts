import { smokePty } from './smoke.ts';

smokePty().then(pty => {
  // ConPTY keeps its pipes open after the terminal exits, so Windows would never leave the event loop.
  process.stdout.write(JSON.stringify({ pty, runtimeNode: process.versions.node }) + '\n', () => process.exit(0));
}).catch(error => { console.error(error); process.exitCode = 1; });
