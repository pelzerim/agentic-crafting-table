import test from 'node:test';
import assert from 'node:assert/strict';
import { themeSource } from './appearance.ts';

test('outside tests the appearance setting decides the theme', () => {
  for (const setting of ['system', 'light', 'dark'] as const) assert.equal(themeSource(false, 'light', setting), setting);
});

test('in a test run System is dark unless pinned, so screenshots do not follow the machine', () => {
  assert.equal(themeSource(true, undefined, 'system'), 'dark'); assert.equal(themeSource(true, 'light', 'system'), 'light');
  for (const value of ['', 'system', 'sepia']) assert.equal(themeSource(true, value, 'system'), 'dark', value);
});

test('in a test run an explicit Light or Dark setting still applies', () => {
  assert.equal(themeSource(true, undefined, 'light'), 'light'); assert.equal(themeSource(true, 'light', 'dark'), 'dark');
});
