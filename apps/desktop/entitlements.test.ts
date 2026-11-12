import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mac = JSON.parse(readFileSync('package.json', 'utf8')).build.mac;

test('the macOS app and the sessions it starts may ask for the microphone under the hardened runtime', () => {
  assert.equal(mac.entitlements, 'apps/desktop/assets/entitlements.mac.plist');
  assert.equal(mac.entitlementsInherit, mac.entitlements);
  const plist = readFileSync(mac.entitlements, 'utf8');
  for (const key of ['com.apple.security.device.audio-input', 'com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory', 'com.apple.security.cs.disable-library-validation'])
    assert.match(plist, new RegExp(`<key>${key.replaceAll('.', '\\.')}</key>\\s*<true/>`), key);
});
