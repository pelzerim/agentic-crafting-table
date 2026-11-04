import test from 'node:test';
import assert from 'node:assert/strict';
import { attachEmbeddedPage, embeddedNavigation, embeddedPermissionAllowed, embeddedSite } from './embedded-sites.ts';

const ARTIFACT = 'https://claude.ai/code/artifact/00000000-0000-4000-8000-000000000042';

test('a page attaches only as a known site and on a URL that site allows, with preferences rebuilt from the forced list', () => {
  const preferences = { preload: '/app/dist/preload.cjs', nodeIntegration: true, contextIsolation: false, sandbox: false, webSecurity: false, webviewTag: true, allowRunningInsecureContent: true, experimentalFeatures: true, enableBlinkFeatures: 'X', somethingNew: true, partition: 'persist:claude-artifacts' };
  const params: Record<string, string> = { src: ARTIFACT, partition: 'persist:claude-artifacts', preload: 'file:///app/preload.cjs' };
  assert.equal(attachEmbeddedPage(preferences, params)?.id, 'claude');
  assert.deepEqual(preferences, {
    nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true, webSecurity: true,
    webviewTag: false, allowRunningInsecureContent: false, experimentalFeatures: false, enableBlinkFeatures: '', plugins: false, disablePopups: false, partition: 'persist:claude-artifacts',
  });
  assert.deepEqual(params, { src: ARTIFACT, partition: 'persist:claude-artifacts' });
  for (const partition of [undefined, '', 'persist:github', 'persist:other']) assert.equal(attachEmbeddedPage({}, { src: ARTIFACT, ...(partition === undefined ? {} : { partition }) }), undefined, String(partition));
  for (const src of [undefined, '', 'craft://app/index.html', 'https://example.com/', 'http://claude.ai/artifact/abc', 'https://claude.ai:8443/', 'https://claude.ai.example.com/artifact/abc', 'https://user:pw@claude.ai/', 'file:///etc/passwd']) {
    assert.equal(attachEmbeddedPage({}, { partition: 'persist:claude-artifacts', ...(src === undefined ? {} : { src }) }), undefined, String(src));
  }
  assert.equal(embeddedSite('claude')?.partition, 'persist:claude-artifacts'); assert.equal(embeddedSite('github'), undefined);
});

test('top-level https pages stay in the guest so sign-in can leave the site and return; anything else is not loaded there', () => {
  for (const url of [ARTIFACT, 'https://accounts.example.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fclaude.ai%2Fcallback', 'https://sso.example.com/saml']) assert.equal(embeddedNavigation(url, true), 'allow', url);
  for (const url of ['http://example.com/', 'javascript:alert(1)', 'file:///etc/passwd', 'craft://app/index.html', 'not a url']) assert.equal(embeddedNavigation(url, true), 'external', url);
  assert.equal(embeddedNavigation('http://example.com/embed', false), 'allow');
});

test('embedded pages get no device or notification permissions', () => {
  assert.equal(embeddedPermissionAllowed('clipboard-sanitized-write'), true);
  for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'display-capture']) assert.equal(embeddedPermissionAllowed(permission), false);
});
