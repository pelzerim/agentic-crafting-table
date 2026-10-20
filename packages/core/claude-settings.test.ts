import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsSchema } from './settings.ts';
import { claudePermissionSettings } from './claude-settings.ts';

test('Claude auto mode defaults on for new and older settings; explicit off survives parsing', () => {
  assert.equal(settingsSchema.parse({}).claude.autoMode, true);
  const old = settingsSchema.parse({ claude: { remoteControl: false, arguments: ['--effort', 'high'] } }).claude;
  assert.equal(old.autoMode, true); assert.equal(old.remoteControl, false);
  assert.deepEqual(claudePermissionSettings(old), { mode: 'auto', override: undefined, arguments: ['--effort', 'high'] });
  const off = settingsSchema.parse({ claude: { autoMode: false } }).claude;
  assert.equal(off.autoMode, false); assert.equal(claudePermissionSettings(off).mode, 'default');
  assert.throws(() => settingsSchema.parse({ claude: { autoMode: 'yes' } }));
});

test('explicit split and inline permission modes retain precedence and can be replaced without losing unrelated arguments', () => {
  for (const args of [['--permission-mode', 'plan'], ['--permission-mode=plan']]) {
    const settings = settingsSchema.parse({ claude: { arguments: ['--effort', 'high', ...args, '--verbose'] } }).claude;
    const permission = claudePermissionSettings(settings);
    assert.deepEqual(permission, { mode: 'plan', override: 'plan', arguments: ['--effort', 'high', '--verbose'] });
    assert.equal(claudePermissionSettings({ ...settings, arguments: permission.arguments, autoMode: true }).mode, 'auto');
    assert.equal(claudePermissionSettings({ ...settings, arguments: permission.arguments, autoMode: false }).mode, 'default');
  }
  assert.deepEqual(claudePermissionSettings({ autoMode: true, arguments: ['--permission-mode=auto', '--permission-mode', 'default'] }), { mode: 'default', override: 'default', arguments: [] });
  // An incomplete draft can render, but cannot be saved or launched.
  assert.equal(claudePermissionSettings({ autoMode: true, arguments: ['--permission-mode', '--verbose'] }).mode, 'auto');
  assert.throws(() => settingsSchema.parse({ claude: { arguments: ['--permission-mode', '--verbose'] } }));
});
