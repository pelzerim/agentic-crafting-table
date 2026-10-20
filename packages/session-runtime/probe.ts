import { smokePty } from './smoke.ts';

smokePty().then(pty => {
  console.log(JSON.stringify({ pty, runtimeNode: process.versions.node }));
}).catch(error => { console.error(error); process.exitCode = 1; });
