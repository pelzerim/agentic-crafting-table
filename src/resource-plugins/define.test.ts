import test from 'node:test';
import assert from 'node:assert/strict';
import { webLinkUrl } from './define.ts';
import { githubPullRequest } from './items/github-pull-request/definition.ts';

test('web link templates fill encoded fields and refuse incomplete or non-https links', () => {
  const template = githubPullRequest.webLink!.template;
  assert.equal(webLinkUrl(template, { owner: 'acme', repo: 'app', number: 42 }), 'https://github.com/acme/app/pull/42');
  assert.equal(webLinkUrl(template, { owner: 'acme', repo: 'app' }), undefined);
  assert.equal(webLinkUrl(template, { owner: '', repo: 'app', number: 1 }), undefined);
  assert.equal(webLinkUrl(template, { owner: '../x', repo: 'a?b#c', number: 1 }), 'https://github.com/..%2Fx/a%3Fb%23c/pull/1');
  assert.equal(webLinkUrl('http://example.com/{id}', { id: 'x' }), undefined);
  assert.equal(webLinkUrl('{target}', { target: 'javascript:alert(1)' }), undefined);
});

test('item types with a canonical web page build it from stored fields only', async () => {
  const { linearTicket } = await import('./items/linear-ticket/definition.ts');
  const { githubRollout } = await import('./items/github-rollout/definition.ts');
  const { notionPage } = await import('./items/notion-page/definition.ts');
  const { webLink } = await import('./items/web-link/definition.ts');
  const { bookmark } = await import('./items/bookmark/definition.ts');
  const url = (plugin: { webLink?: { template: string | readonly string[] } }, data: Record<string, string | number>) => webLinkUrl(plugin.webLink!.template, data);
  assert.equal(linearTicket.webLink?.label, 'Open on Linear');
  assert.equal(url(linearTicket, { issueId: 'BIL-128', workspaceKey: 'acme' }), 'https://linear.app/acme/issue/BIL-128');
  assert.equal(url(linearTicket, { issueId: 'BIL-128' }), undefined, 'no workspace saved');
  assert.equal(githubRollout.webLink?.label, 'Open on GitHub');
  assert.equal(url(githubRollout, { owner: 'acme', repo: 'infra', runId: 99 }), 'https://github.com/acme/infra/actions/runs/99');
  assert.equal(url(githubRollout, { owner: 'acme', repo: 'infra', workflow: 'deploy.yml', branch: 'release/1' }), 'https://github.com/acme/infra/actions/workflows/deploy.yml?query=branch%3Arelease%2F1');
  assert.equal(url(githubRollout, { owner: 'acme', repo: 'infra', workflow: 'deploy.yml' }), 'https://github.com/acme/infra/actions/workflows/deploy.yml');
  assert.equal(url(githubRollout, { owner: 'acme', repo: 'infra' }), undefined);
  assert.equal(notionPage.webLink?.label, 'Open on Notion');
  assert.equal(url(notionPage, { pageId: '11111111111111111111111111111111' }), 'https://www.notion.so/11111111111111111111111111111111');
  for (const plugin of [webLink, bookmark]) {
    assert.equal(plugin.webLink?.label, 'Open in browser');
    assert.equal(url(plugin, { url: 'https://example.com/a?b=1#c' }), 'https://example.com/a?b=1#c');
    for (const bad of ['http://example.com/', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url', '']) assert.equal(url(plugin, { url: bad }), undefined, bad);
  }
});

test('multiselect settings fields default to a copy of their list and accept only unique declared options', async () => {
  const { fieldDefaults, validateFields, fieldsSchema, defineResourcePlugin } = await import('./define.ts');
  const { ResourcePluginRegistry } = await import('./registry.ts');
  const fields = { on: { label: 'On', kind: 'boolean' as const, default: true }, picks: { label: 'Picks', kind: 'multiselect' as const, options: ['a', 'b', 'c'], default: ['a', 'b'], enabledBy: 'on', emptyHint: 'Nothing picked.' } };
  const defaults = fieldDefaults(fields);
  assert.deepEqual(defaults, { on: true, picks: ['a', 'b'] }); assert.notEqual(defaults.picks, fields.picks.default);
  assert.deepEqual(fieldDefaults(fields, undefined, { picks: [] }).picks, [], 'an empty saved selection is kept');
  for (const picks of [[], ['c'], ['a', 'b', 'c']]) assert.equal(validateFields(fields, { picks }), true);
  for (const picks of ['a', ['d'], ['a', 'a'], [1], null, { a: true }]) assert.equal(validateFields(fields, { picks } as never), false, JSON.stringify(picks));
  assert.deepEqual((fieldsSchema(fields).properties as Record<string, unknown>).picks, { type: 'array', title: 'Picks', items: { type: 'string', enum: ['a', 'b', 'c'] }, uniqueItems: true });
  const section = (picks: object, on: object = fields.on) => ({ typeId: 'acme.item', label: 'Acme', fields: { on, picks: { ...fields.picks, ...picks } } as never });
  new ResourcePluginRegistry().registerSettings('acme', section({}));
  for (const [change, on] of [[{ options: [] }], [{ default: ['z'] }], [{ default: 'a' }], [{ enabledBy: 'missing' }], [{}, { label: 'On', kind: 'text', default: '' }]] as [object, object?][])
    assert.throws(() => new ResourcePluginRegistry().registerSettings('acme', section(change, on)), /multiselect|enabledBy/i, JSON.stringify(change));
  assert.throws(() => defineResourcePlugin({ id: 'acme.item', apiVersion: 1, schemaVersion: 1, name: 'Acme', icon: 'box', fields: { picks: fields.picks } } as never), /settings/i);
});
