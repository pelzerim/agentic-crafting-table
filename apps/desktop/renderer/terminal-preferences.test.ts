import test from 'node:test';
import assert from 'node:assert/strict';
import { replayTailBytes, terminalOptions } from './terminal-preferences.ts';
import { settingsSchema } from '../../../packages/core/settings.ts';

test('screen reader support is off unless chosen or a screen reader is running', () => {
  const defaults = settingsSchema.parse({}).terminal;
  assert.equal(terminalOptions(defaults, false).screenReaderMode, false);
  assert.equal(terminalOptions(defaults, true).screenReaderMode, true, 'VoiceOver turns it on automatically');
  assert.equal(terminalOptions({ ...defaults, screenReader: true }, false).screenReaderMode, true);
  assert.equal(terminalOptions(undefined, false).screenReaderMode, false, 'before settings load');
  assert.equal(terminalOptions(undefined, true).screenReaderMode, true);
});

test('scrollback follows the setting and uses the default before settings load', () => {
  const defaults = settingsSchema.parse({}).terminal;
  assert.equal(terminalOptions(undefined, false).scrollback, 5000);
  assert.equal(terminalOptions(defaults, false).scrollback, 5000);
  assert.equal(terminalOptions({ ...defaults, scrollback: 25000 }, true).scrollback, 25000);
});

test('a fresh view replays a recording tail sized to its scrollback, within fixed bounds', () => {
  const KiB = 1024, MiB = 1024 * KiB;
  assert.equal(replayTailBytes(2000), 512 * KiB, 'never less than 512 KiB');
  assert.equal(replayTailBytes(5000), 1_000_000);
  assert.equal(replayTailBytes(10000), 2_000_000, 'about the previous fixed 2 MiB at the previous 10,000 lines');
  assert.equal(replayTailBytes(25000), 4 * MiB, 'never more than 4 MiB');
});
