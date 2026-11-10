import test from 'node:test';
import assert from 'node:assert/strict';
import { attachEmbeddedPage, embeddedDownload, embeddedNavigation, embeddedPermissionAllowed, embeddedSite } from './embedded-sites.ts';

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
  for (const src of [undefined, '', 'craft://app/index.html', 'https://example.com/', 'http://claude.ai/artifact/abc', 'https://claude.ai:8443/', 'https://claude.ai.example.com/artifact/abc', 'https://user:@claude.ai/', 'file:///etc/passwd']) {
    assert.equal(attachEmbeddedPage({}, { partition: 'persist:claude-artifacts', ...(src === undefined ? {} : { src }) }), undefined, String(src));
  }
  assert.equal(embeddedSite('claude')?.partition, 'persist:claude-artifacts'); assert.equal(embeddedSite('github'), undefined);
});

test('top-level https pages stay in the guest so sign-in can leave the site and return; anything else is not loaded there', () => {
  for (const url of [ARTIFACT, 'https://accounts.example.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fclaude.ai%2Fcallback', 'https://sso.example.com/saml']) assert.equal(embeddedNavigation(url, true), 'allow', url);
  for (const url of ['http://example.com/', 'javascript:alert(1)', 'file:///etc/passwd', 'craft://app/index.html', 'not a url']) assert.equal(embeddedNavigation(url, true), 'external', url);
  assert.equal(embeddedNavigation('http://example.com/embed', false), 'allow');
});

test('only Google sign-in and the site itself open as a sign-in window in the site session', () => {
  const signIn = embeddedSite('claude')!.signIn!;
  for (const url of ['https://accounts.google.com/o/oauth2/v2/auth?client_id=x', 'https://claude.ai/login', 'https://auth.claude.ai/callback']) assert.equal(signIn(url), true, url);
  for (const url of ['https://accounts.google.com.evil.example/o/oauth2', 'http://accounts.google.com/o/oauth2', 'https://evilaccounts.google.com/', 'https://example.com/popup', 'not a url']) assert.equal(signIn(url), false, url);
});

test('only the site\'s own pages may write to the clipboard, and no page gets device or notification permissions', () => {
  const site = embeddedSite('claude')!;
  assert.equal(embeddedPermissionAllowed(site, 'clipboard-sanitized-write', ARTIFACT), true);
  for (const url of ['https://accounts.google.com/o/oauth2', 'https://idp.example.com/authorize', 'https://claude.ai.example.com/', 'http://claude.ai/', '', undefined]) {
    assert.equal(embeddedPermissionAllowed(site, 'clipboard-sanitized-write', url), false, String(url));
  }
  for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'display-capture']) assert.equal(embeddedPermissionAllowed(site, permission, ARTIFACT), false);
});

test('downloads the browser can fetch open there; files the page made are saved in the app', () => {
  for (const url of ['https://claude.ai/files/notes.txt', 'http://example.com/file.zip', 'not a url']) assert.equal(embeddedDownload(url), 'browser', url);
  for (const url of ['blob:https://claude.ai/00000000-0000-4000-8000-000000000001', 'data:text/plain,hello']) assert.equal(embeddedDownload(url), 'save', url);
});
