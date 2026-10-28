import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './sqlite-store.ts';
import { checkAppSettingsPreset } from '../core/settings.ts';

const raccoon = { id: 'team.working-animal', packageId: 'app', values: { workingMark: { animal: 'raccoon', helpers: 'kits' } } };

test('a package preset for the app sets the working animal once, and only while it is still the default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-app-preset-'));
  try {
    const fresh = new SqliteStore(join(directory, 'fresh.sqlite'));
    try {
      assert.equal(fresh.readSettings().value.workingMark.animal, 'sheep');
      assert.equal(fresh.applyAppSettingsPreset(raccoon), true);
      assert.deepEqual(fresh.readSettings().value.workingMark, { animal: 'raccoon', helpers: 'kits' });
      const saved = fresh.readSettings();
      fresh.writeSettings({ expectedRevision: saved.revision, value: { ...saved.value, workingMark: { animal: 'sheep', helpers: 'kits' } } });
      assert.equal(fresh.applyAppSettingsPreset(raccoon), false, 'a preset applies once');
      assert.equal(fresh.readSettings().value.workingMark.animal, 'sheep', 'switching back is kept');
    } finally { fresh.close(); }
    const chosen = new SqliteStore(join(directory, 'chosen.sqlite'));
    try {
      const saved = chosen.readSettings();
      chosen.writeSettings({ expectedRevision: saved.revision, value: { ...saved.value, workingMark: { animal: 'raccoon', helpers: 'same' } } });
      chosen.applyAppSettingsPreset({ ...raccoon, values: { workingMark: { animal: 'raccoon', helpers: 'kits' } } });
      assert.deepEqual(chosen.readSettings().value.workingMark, { animal: 'raccoon', helpers: 'same' }, 'a setting someone changed stays theirs');
    } finally { chosen.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an app preset may set only the allowed appearance settings, with valid values', () => {
  assert.doesNotThrow(() => checkAppSettingsPreset(raccoon));
  assert.throws(() => checkAppSettingsPreset({ ...raccoon, values: { keepAwake: true } }), /sets app settings it may not: keepAwake/);
  assert.throws(() => checkAppSettingsPreset({ ...raccoon, values: { workingMark: { animal: 'goat' } } }), /team\.working-animal/);
});
