import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indicatorsSchema, unreadCommentsIndicator } from './indicators.ts';
import { pullRequestPresentation } from './items/github-pull-request/presentation.ts';
import { notionPagePresentation } from './items/notion-page/presentation.ts';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { dashboardPreview, projectDashboard } from '../graph/project-dashboard.ts';
import type { ResourceSnapshot } from './types.ts';

test('the comment cue is one shape: message glyph, blue, count first', () => {
  assert.deepEqual(unreadCommentsIndicator(1, 'unread'), { id: 'comments', label: '1 unread comment', icon: 'message-square', tone: 'blue' });
  assert.deepEqual(unreadCommentsIndicator(12, 'unseen', { showLabel: true }), { id: 'comments', label: '12 unseen comments', icon: 'message-square', tone: 'blue', showLabel: true });
  indicatorsSchema.parse([unreadCommentsIndicator(3, 'unread', { showLabel: true })]);
});

test('pull requests and Notion pages raise the same comment cue for comments waiting for the person', () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-comment-cue-')), store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try {
    const base = { activity: 'idle', attention: 'none', connection: 'connected', label: '' } as const;
    const pull = { id: 'pr-r', pluginId: 'github.pull-request', schemaVersion: 1, title: 'PR', connectionId: 'github-1', data: { owner: 'acme', repo: 'billing', number: 7 } };
    const discussion = [{ kind: 'comment', id: 1, author: 'colleague', authorType: 'User', body: 'Please look', createdAt: '2026-09-26T12:10:00.000Z' }];
    const pullCue = pullRequestPresentation.indicators!(pull, { ...base, title: 'PR', observedAt: '2026-09-26T12:00:00.000Z', detail: { viewer: 'me', discussion } } as unknown as ResourceSnapshot, store)!.find(cue => cue.id === 'comments');
    assert.deepEqual(pullCue, unreadCommentsIndicator(1, 'unseen'));

    const page = { id: 'page-r', pluginId: 'notion.page', schemaVersion: 1, title: 'Page', connectionId: 'notion-1', data: { pageId: '1'.repeat(32) } };
    const comments = (items: unknown[]) => ({ ...base, title: 'Page', observedAt: '2026-09-26T12:00:30.000Z', detail: { comments: { available: true, items, viewers: ['2'.repeat(32)], blocks: { total: 0, checked: 0 } } } }) as unknown as ResourceSnapshot;
    const notion = notionPagePresentation();
    assert.deepEqual(notion.indicators!(page, comments([]), store), [], 'the first observation records what is there as read');
    const pageCue = notion.indicators!(page, comments([{ id: 'a'.repeat(32), at: '2026-09-26T12:30:00.000Z', author: '7'.repeat(32), parent: '1'.repeat(32) }]), store)!.find(cue => cue.id === 'comments');
    assert.deepEqual(pageCue, unreadCommentsIndicator(1, 'unread', { showLabel: true }));

    const { label: _pullLabel, ...pullShape } = pullCue!, { label: _pageLabel, showLabel: _shown, ...pageShape } = pageCue!;
    assert.deepEqual(pageShape, pullShape, 'same id, glyph and tone on both types');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a Notion page with unread comments reads like a PR in dashboards: the cue is its status and Needs you says why', () => {
  const cue = unreadCommentsIndicator(2, 'unread', { showLabel: true });
  const nodes = [{ id: 'p', title: 'Billing', position: { x: 0, y: 0 }, summary: '', activity: 'unknown' as const, attention: 'none' as const },
    { id: 'page', title: 'Billing experience', resourceId: 'page-r', projectId: 'p', position: { x: 0, y: 0 }, summary: 'Notion page', activity: 'idle' as const, attention: 'none' as const, indicators: [cue],
      attentionSources: { 'notion.comments': 'comment' as const }, attentionNotes: { 'notion.comments': '2 new comments' }, attentionVersion: 1 }];
  const preview = dashboardPreview('page', nodes, [], () => ({ typeName: 'Notion page' }))!;
  assert.deepEqual(preview.status, cue); assert.deepEqual(preview.attention, ['2 new comments']);
  assert.deepEqual(projectDashboard('p', nodes).needsYou.map(row => [row.id, row.detail]), [['page', '2 new comments']]);
});
