import { runLoggedService } from './log-service.ts';

const directory = process.env.ACT_DATA_DIR, entrypoint = process.argv[2];
if (!directory || !entrypoint) throw new Error('A service directory and entrypoint are required');
runLoggedService({ directory, entrypoint }).then(code => { process.exitCode = code; }).catch(() => {
  // No provider errors, environment values or terminal content in bootstrap output.
  console.error('Service diagnostics could not start. Check data-directory permissions and available disk space.');
  process.exitCode = 1;
});
