// A scripted stand-in for Claude Code used by scripts/record-demo.ts: it plays one short, invented turn in the
// terminal and reports activity through the table's hooks. It never calls a model, reads a repository or touches the network.
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
if (args.includes('--version')) { console.log('2.1.281 (demo fixture)'); process.exit(0); }
if (args.includes('--help')) { console.log('--append-system-prompt --session-id --resume --mcp-config --plugin-dir --system-prompt-snapshot --remote-control\n  --permission-mode <mode> (choices: "auto", "default", "plan")'); process.exit(0); }

const sessionId = value(args.includes('--resume') ? '--resume' : '--session-id');
const hooks = JSON.parse(await readFile(join(value('--plugin-dir'), 'hooks/hooks.json'), 'utf8')).hooks;
function hook(event, payload = {}) {
  const command = hooks[event]?.[0]?.hooks?.[0];
  if (!command) return Promise.resolve();
  return new Promise(resolve => {
    const child = spawn(command.command, command.args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => resolve()); child.on('close', () => resolve());
    child.stdin.end(JSON.stringify({ session_id: sessionId, hook_event_name: event, ...payload }));
  });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const dim = text => `\x1b[2m${text}\x1b[0m`, bold = text => `\x1b[1m${text}\x1b[0m`;
const mint = text => `\x1b[38;2;152;214;172m${text}\x1b[0m`, amber = text => `\x1b[38;2;229;190;92m${text}\x1b[0m`;
const red = text => `\x1b[38;2;224;108;96m${text}\x1b[0m`, green = text => `\x1b[38;2;132;200;150m${text}\x1b[0m`;
const say = line => process.stdout.write(`${line}\r\n`);

await hook('SessionStart');
say('');
say(`${amber('❯')} ${bold('Update the plan switcher so a downgrade keeps the current cycle and the credit lands on the next invoice.')}`);
say('');
await sleep(1100);
const pace = .75;
const steps = [
  [250, () => say(`${mint('✻')} Reading the billing module…`)],
  [350, () => say(`  ${mint('●')} Read ${bold('src/billing/plan-switcher.ts')} ${dim('(142 lines)')}`)],
  [300, () => say(`  ${mint('●')} Read ${bold('src/billing/proration.ts')} ${dim('(88 lines)')}`)],
  [450, () => say(`${mint('✻')} Making the change…`)],
  [300, () => say(`  ${mint('●')} Edit ${bold('src/billing/plan-switcher.ts')}`)],
  [120, () => say(`      ${red('-  const effectiveAt = now();')}`)],
  [120, () => say(`      ${green('+  const effectiveAt = downgrade ? cycle.end : now();')}`)],
  [120, () => say(`      ${green('+  credit.schedule(cycle.next, proration(previous, next));')}`)],
  [400, () => say(`  ${mint('●')} Edit ${bold('tests/billing/plan-switcher.test.ts')} ${dim('(+2 cases)')}`)],
  [450, () => say(`${mint('✻')} Running tests…`)],
  [300, () => say(`  ${mint('●')} npm test -- plan-switcher`)],
  [700, () => say(`      ${green('14 passed')}`)],
  [400, () => say('')],
  [0, () => say(`${green('✓')} Downgrades now switch at the end of the cycle; the proration credit lands on the next invoice.`)],
  [200, () => say(`  ${dim('Opening pull request #42 · Plan switcher')}`)],
];
await hook('PreToolUse', { tool_name: 'Read' });
for (const [delay, step] of steps) { await sleep(delay * pace); step(); }
await hook('PostToolUse', { tool_name: 'Edit' });
say('');
say(`${amber('❯')} ${dim('What next?')}`);
process.on('SIGTERM', () => process.exit(0));
process.stdin.resume();
