import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HeadlessTerminal, modeReply, terminalIdentity, versionReply } from './terminal-identity.ts';

test('the identity names the app and its version, not the emulator library', () => {
  const app = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(terminalIdentity, `${app.build.productName}(${app.version})`);
  assert.doesNotMatch(terminalIdentity, /xterm\.js/, 'the name xterm.js selects a CLI wheel profile made for VS Code');
  assert.equal(versionReply, `\x1bP>|${terminalIdentity}\x1b\\`);
  assert.equal(modeReply(2026, 2), '\x1b[?2026;2$y');
});

test('a session nobody is viewing still answers the probes a CLI sends at startup', () => {
  const terminal = new HeadlessTerminal();
  assert.equal(terminal.feed('\x1b[>q'), versionReply);
  assert.equal(terminal.feed('\x1b[>0q'), versionReply);
  assert.equal(terminal.feed('\x1b[?2026$p'), '\x1b[?2026;2$y', 'synchronized output is supported and off');
  assert.equal(terminal.feed('\x1b[?1016$p'), '\x1b[?1016;0$y', 'pixel mouse reports are declined');
  assert.equal(terminal.feed('\x1b[c'), '\x1b[?1;2c');
  assert.equal(terminal.feed('\x1b[0c'), '\x1b[?1;2c');
  assert.equal(terminal.feed('\x1b[?1049h\x1b[>q hello \x1b[?2026$p\x1b[2J\x1b[c'), `${versionReply}\x1b[?2026;2$y\x1b[?1;2c`, 'replies keep the order of the questions');
});

test('ordinary output, other queries and unknown modes get no reply', () => {
  const terminal = new HeadlessTerminal();
  for (const data of ['plain text', '\x1b[31mred\x1b[0m', '\x1b[?25l', '\x1b[6n', '\x1b[?u', '\x1b[?9999$p', '\x1b[>1q', '\x1b[1c', '\x1b]11;?\x07', '\x1b[2026$p'])
    assert.equal(terminal.feed(data), '', JSON.stringify(data));
});

test('a probe split across PTY chunks is answered once, when it completes', () => {
  const terminal = new HeadlessTerminal();
  assert.equal(terminal.feed('text\x1b'), '');
  assert.equal(terminal.feed('[>'), '');
  assert.equal(terminal.feed('q more\x1b[?20'), versionReply);
  assert.equal(terminal.feed('26$'), '');
  assert.equal(terminal.feed('p'), '\x1b[?2026;2$y');
  assert.equal(terminal.feed('p'), '');
  // A lone escape that never becomes a sequence does not hold output back forever.
  assert.equal(terminal.feed('\x1b'), '');
  assert.equal(terminal.feed('x'.repeat(100) + '\x1b[c'), '\x1b[?1;2c');
});
