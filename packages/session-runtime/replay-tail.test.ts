import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeJournal } from './journal.ts';
import { TerminalModes, restartOffset } from './replay-tail.ts';

const request = (cwd: string) => ({ sessionId: 's', requestId: 'r', nodeId: 'n', workspaceId: 'w', cwd, executable: '/bin/sh', args: [], cols: 80, rows: 24 });
async function withJournal(run: (journal: RuntimeJournal) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-replay-tail-'));
  const journal = new RuntimeJournal(join(directory, 'supervisor.sqlite'), 'test');
  try { journal.reserve(request(directory)); run(journal); } finally { journal.close(); await rm(directory, { recursive: true, force: true }); }
}
const replay = (journal: RuntimeJournal, after: number, through: number, maxBytes: number, pending = [] as { sequence: number; data: string }[]) => {
  const start = journal.replayStart('s', after, through, maxBytes, pending);
  if (!start) return undefined;
  let text = start.prefix, sequence = start.sequence - 1, contiguous = true;
  for (;;) {
    const page = journal.history('s', sequence, through, pending);
    if (!page.length) break;
    for (const chunk of page) {
      contiguous &&= chunk.sequence === sequence + 1;
      text += chunk.sequence === start.sequence ? chunk.data.slice(start.offset) : chunk.data;
      sequence = chunk.sequence;
    }
  }
  return { ...start, text, contiguous, last: sequence };
};

test('restart points prefer the earliest full reset and otherwise begin at a whole line', () => {
  assert.equal(restartOffset('partial\x1b[2Jscreen\x1b[3Jmore'), 7);
  assert.equal(restartOffset('a\x1bcb'), 1);
  assert.equal(restartOffset('xx\x1b[?1049hfull'), 2);
  assert.equal(restartOffset('xx\x1b[?1049lnormal'), 2);
  assert.equal(restartOffset('cut line\r\nwhole line\r\n'), 10);
  assert.equal(restartOffset('one long line without a break'), 0);
  assert.equal(restartOffset('only a final break\n'), 0);
  assert.equal(restartOffset('\x1b[2K erases a line, not the screen\nnext'), 35);
});

test('terminal modes left by skipped output are restored, including sequences split across chunks', () => {
  const modes = new TerminalModes();
  for (const part of ['\x1b[?2004h\x1b[?10', '04h\x1b[?25l\x1b[?1;1000h', '\x1b[?1000l\x1b[3;20r\x1b=']) modes.scan(part);
  assert.equal(modes.prefix(), '\x1b[?1h\x1b[?25l\x1b[?1004h\x1b[?2004h\x1b[3;20r\x1b=');
  modes.scan('\x1b[!p');
  assert.equal(modes.prefix(), '\x1b[?1004h\x1b[?2004h');
  modes.scan('\x1b[?1049h\x1b[?1006h\x1b[r');
  assert.equal(modes.prefix(), '\x1b[?1049h\x1b[?1004h\x1b[?1006h\x1b[?2004h');
  modes.scan('\x1b[?1049l\x1bc');
  assert.equal(modes.prefix(), '');
  modes.scan('\x1b[?7l\x1b[?12h');
  assert.equal(modes.prefix(), '\x1b[?7l', 'cursor blink is cosmetic; wraparound is not');
});

test('a range within the budget replays in full', async () => withJournal(journal => {
  journal.append('s', Array.from({ length: 10 }, (_, i) => ({ sequence: i + 1, data: `line ${i}\r\n` })));
  assert.equal(journal.replayStart('s', 0, 10, 1024), undefined);
  assert.equal(journal.replayStart('s', 0, 0, 4), undefined);
}));

test('an oversized range restarts at the earliest clear inside the newest budget with contiguous sequences', async () => withJournal(journal => {
  const chunks = [];
  for (let i = 1; i <= 400; i++) {
    const clear = i % 50 === 0 ? '\x1b[2' : '';
    const data = i % 50 === 1 && i > 1 ? `J\x1b[H\x1b[3Jframe ${i}\r\n` : `\x1b[32mrow ${i}\x1b[0m\r\n${clear}`;
    chunks.push({ sequence: i, data });
  }
  chunks[0].data = '\x1b[?2004h\x1b[?25l' + chunks[0].data;
  journal.append('s', chunks.slice(0, 380));
  const pending = chunks.slice(380);
  const full = chunks.map(chunk => chunk.data).join('');
  const result = replay(journal, 0, 400, 2048, pending)!;
  assert.ok(result, 'the recording exceeds the budget');
  assert.equal(result.contiguous, true); assert.equal(result.last, 400);
  assert.equal(result.prefix, '\x1b[?25l\x1b[?2004h');
  assert.match(result.text.slice(result.prefix.length), /^\x1b\[[23]J/);
  assert.ok(full.endsWith(result.text.slice(result.prefix.length)));
  assert.ok(Buffer.byteLength(result.text) <= 2048 + result.prefix.length);
  const clears = [...full.matchAll(/\x1b\[[23]J/g)].map(match => match.index);
  const skipped = full.length - (result.text.length - result.prefix.length);
  assert.ok(clears.includes(skipped));
  assert.ok(!clears.some(index => index < skipped && Buffer.byteLength(full.slice(index)) <= 2048 - 64), 'no earlier clear well inside the budget');
}));

test('without a clear the replay begins after a line break, and an oversized newest chunk keeps a whole-character suffix', async () => withJournal(journal => {
  journal.append('s', Array.from({ length: 100 }, (_, i) => ({ sequence: i + 1, data: `\x1b[?1h${'x'.repeat(30)} ${i}\r\n` })));
  const lines = replay(journal, 0, 100, 400)!;
  assert.equal(lines.contiguous, true); assert.equal(lines.prefix, '\x1b[?1h');
  assert.ok(lines.offset > 0 || lines.sequence > 1);
  assert.match(lines.text.slice(lines.prefix.length), /^\x1b\[\?1hx{30} \d+\r\n/);
  journal.append('s', [{ sequence: 101, data: '🌲'.repeat(300) }]);
  const big = replay(journal, 0, 101, 64)!;
  assert.equal(big.sequence, 101); assert.equal(big.text, '\x1b[?1h' + '🌲'.repeat(16));
}));

test('replay starts respect the requested range and deleted recordings', async () => withJournal(journal => {
  journal.append('s', Array.from({ length: 50 }, (_, i) => ({ sequence: i + 1, data: `${i % 10 === 0 ? '\x1bc' : ''}line ${i}\r\n` })));
  const bounded = replay(journal, 0, 25, 50)!;
  assert.equal(bounded.last, 25); assert.equal(bounded.sequence, 21); assert.equal(bounded.offset, 0);
  assert.equal(journal.replayStart('s', 46, 50, 40), undefined);
  journal.update('s', { state: 'exited' }); journal.manage('s', 'archive'); journal.deleteRecording('s');
  assert.equal(journal.replayStart('s', 0, 50, 40), undefined);
}));

test('repeated replays continue the earlier mode scan without forgetting later changes', async () => withJournal(journal => {
  journal.append('s', [{ sequence: 1, data: '\x1b[?2004h' }, ...Array.from({ length: 99 }, (_, i) => ({ sequence: i + 2, data: `line ${i}\r\n` }))]);
  const first = journal.replayStart('s', 0, 100, 100)!;
  assert.equal(first.prefix, '\x1b[?2004h');
  assert.deepEqual(journal.replayStart('s', 0, 100, 100), first);
  journal.append('s', [{ sequence: 101, data: '\x1b[?2004l\x1b[?1049h' }, ...Array.from({ length: 99 }, (_, i) => ({ sequence: i + 102, data: `next ${i}\r\n` }))]);
  const later = journal.replayStart('s', 0, 200, 100)!;
  assert.ok(later.sequence > 101); assert.equal(later.prefix, '\x1b[?1049h');
  assert.deepEqual(journal.replayStart('s', 0, 100, 100), first, 'an earlier range rescans');
}));
