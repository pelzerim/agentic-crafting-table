import test from 'node:test';
import assert from 'node:assert/strict';
import { githubPullRequestConnector } from './connector.ts';
import { GitHubClient } from '../../../../packages/provider-runtime/github.ts';
import type { ResourceRecord } from '../../types.ts';

const id = '1aed960f-ed0b-4451-913d-41aa0aee8d04', src = `https://github.com/user-attachments/assets/${id}`;
const html = `<p>After:</p><img alt="image" src="https://private-user-images.githubusercontent.com/1/2-${id}.png?jwt=fixture">`;
const resource: ResourceRecord = { id: 'pr', pluginId: 'github.pull-request', schemaVersion: 1, title: 'PR', data: { owner: 'fixture', repo: 'billing', number: 42 } };
const signal = () => AbortSignal.timeout(1000);

test('the image action is a person-only read that returns the attachment as data and keeps it for the next view', async () => {
  let reads = 0, images = 0;
  const client = new GitHubClient({ async get() { throw new Error('not used'); },
    async html() { reads++; return { status: 200, headers: new Headers(), body: { body_html: html } }; },
    async image() { images++; return { type: 'image/png', bytes: new Uint8Array([1, 2, 3]) }; } });
  const connector = githubPullRequestConnector(() => client);
  const action = connector.actions!(resource).find(entry => entry.id === 'image');
  assert.equal(action?.readOnly, true); assert.equal(action?.humanOnly, true);
  assert.deepEqual(await connector.execute!(resource, 'image', signal(), { kind: 'discussion', commentId: '5', src }), { src: 'data:image/png;base64,AQID' });
  assert.deepEqual(await connector.execute!(resource, 'image', signal(), { kind: 'discussion', commentId: '5', src }), { src: 'data:image/png;base64,AQID' });
  assert.deepEqual([reads, images], [1, 1]);
  await connector.execute!(resource, 'image', signal(), { kind: 'description', src });
  assert.deepEqual([reads, images], [1, 1], 'the same attachment of this pull request is not fetched twice');
  await assert.rejects(connector.execute!(resource, 'image', signal(), { kind: 'files', commentId: '5', src }), /Unknown image/);
  await assert.rejects(connector.execute!(resource, 'image', signal(), { kind: 'discussion', commentId: '5', src: 'https://images.example.test/x.png' }), /Only GitHub attachments/);
});
