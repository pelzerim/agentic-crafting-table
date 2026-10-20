import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenReaderWatch, assistiveTechnologyOverride } from './assistive-technology.ts';

test('only test runs can pin the assistive technology report', () => {
  assert.equal(assistiveTechnologyOverride(true, '1'), true);
  assert.equal(assistiveTechnologyOverride(true, '0'), false);
  for (const value of [undefined, '', 'yes', 'true']) assert.equal(assistiveTechnologyOverride(true, value), undefined, String(value));
  assert.equal(assistiveTechnologyOverride(false, '1'), undefined, 'an installed app always asks macOS');
  assert.equal(assistiveTechnologyOverride(false, '0'), undefined);
});

function watch(platform: string, chromium: { value: boolean }, voiceOver: { value: boolean }) {
  const changes: boolean[] = []; let asked = 0;
  const reader = new ScreenReaderWatch(platform, () => chromium.value, async () => { asked++; return voiceOver.value; }, active => changes.push(active));
  return { reader, changes, asked: () => asked };
}

test('on macOS another app using the accessibility API is not a screen reader', async () => {
  const chromium = { value: false }, voiceOver = { value: false }, { reader, changes, asked } = watch('darwin', chromium, voiceOver);
  assert.equal(await reader.refresh(), false);
  assert.equal(asked(), 0, 'nothing to look for while macOS reports no client at all');
  chromium.value = true;
  assert.equal(await reader.refresh(), false, 'a window manager or automation tool sets the flag too');
  assert.deepEqual(changes, []);
  voiceOver.value = true;
  assert.equal(await reader.refresh(), true); assert.equal(await reader.refresh(), true);
  assert.deepEqual(changes, [true], 'a change is announced once');
  voiceOver.value = false;
  assert.equal(await reader.refresh(), false);
  assert.deepEqual(changes, [true, false]);
});

test('elsewhere the platform report is the screen reader signal', async () => {
  const chromium = { value: true }, { reader, changes, asked } = watch('win32', chromium, { value: false });
  assert.equal(await reader.refresh(), true);
  chromium.value = false; assert.equal(await reader.refresh(), false);
  assert.deepEqual(changes, [true, false]); assert.equal(asked(), 0);
});
