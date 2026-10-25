import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopNotifications, announcementSchema, type DesktopAnnouncement } from './notifications.ts';
import { emptyState, stateSchema } from '../../packages/core/control.ts';
import { settingsSchema } from '../../packages/core/settings.ts';

const snapshot = (nodes: unknown[], cursor = 1) => ({ state: stateSchema.parse({ ...emptyState(), nodes }), cursor });
const node = (version = 1, extra = {}) => ({ id: 'agent', resourceId: 'session', title: 'Agent', position: { x: 0, y: 0 }, attention: 'input', attentionVersion: version, ...extra });
function fixture() {
  const shown: DesktopAnnouncement[] = [], closed: string[] = []; let focused = false;
  const subject = new DesktopNotifications({ show: n => shown.push(n), close: key => closed.push(key) }, () => focused);
  subject.preferences = settingsSchema.parse({}).notifications;
  return { subject, shown, closed, focus: (value: boolean) => { focused = value; } };
}

test('old settings default to background notifications; invalid modes are rejected', () => {
  assert.deepEqual(settingsSchema.parse({}).notifications, { mode: 'background', needsMe: true, announcements: true, sound: true, dockBadge: true, countFinished: false, seenOnOpen: [], reminders: 'sound' });
  assert.equal(settingsSchema.parse({ notifications: { mode: 'off' } }).notifications.reminders, 'sound', 'older settings read sound');
  assert.equal(settingsSchema.safeParse({ notifications: { reminders: 'loud' } }).success, false);
  assert.equal(settingsSchema.safeParse({ notifications: { mode: 'sometimes' } }).success, false);
  assert.equal(announcementSchema.safeParse({ key: 'x', title: 'Hi', url: 'file:///etc/passwd' }).success, false);
});

test('baseline, alias duplication, reconnect and out-of-order snapshots do not replay old events', () => {
  const f = fixture(); f.subject.snapshot(snapshot([node()]));
  f.subject.snapshot(snapshot([node(), node(1, { id: 'alias' })], 2));
  assert.equal(f.shown.length, 0);
  f.subject.snapshot(snapshot([node(2), node(2, { id: 'alias' })], 3));
  assert.equal(f.shown.length, 1); assert.equal(f.shown[0].body, 'Waiting for your input');
  f.subject.snapshot(snapshot([node(2)], 3)); f.subject.snapshot(snapshot([node(10)], 2));
  assert.equal(f.shown.length, 1);
  f.subject.snapshot(snapshot([node(3, { attentionNote: 'Agent needs permission' })], 4)); assert.equal(f.shown.length, 2);
  assert.equal(f.shown[1].body, 'Agent needs permission', 'the trigger reason replaces the category label');
  assert.deepEqual(f.closed, ['attention:session:2']);
});

test('read and archive remove native notices, OS dismissal alone changes no domain state', () => {
  const f = fixture(); f.subject.snapshot(snapshot([]));
  const unread = snapshot([node()], 2); f.subject.snapshot(unread);
  assert.equal(unread.state.nodes[0].attentionSeenVersion, undefined);
  f.subject.snapshot(snapshot([node(1, { attentionSeenVersion: 1 })], 3));
  assert.deepEqual(f.closed, ['attention:session:1']);
  f.subject.snapshot(snapshot([node(2)], 4));
  f.subject.snapshot(snapshot([node(2, { archivedAt: '2026-09-29T10:00:00Z' })], 5));
  assert.deepEqual(f.closed, ['attention:session:1', 'attention:session:2']);
});

test('initial archived/read items never become notifications merely by restoring their alias', () => {
  const f = fixture(); f.subject.snapshot(snapshot([node(2, { archivedAt: '2026-09-29T10:00:00Z' })]));
  f.subject.snapshot(snapshot([node(2)], 2)); assert.equal(f.shown.length, 0);
});

test('background/always/off and individual switches suppress without delayed replay', () => {
  const f = fixture(); f.subject.snapshot(snapshot([])); f.focus(true);
  f.subject.snapshot(snapshot([node()], 2)); assert.equal(f.shown.length, 0);
  f.focus(false); f.subject.snapshot(snapshot([node()], 3)); assert.equal(f.shown.length, 0);
  f.subject.preferences!.mode = 'always'; f.focus(true);
  f.subject.snapshot(snapshot([node(2)], 4)); assert.equal(f.shown.length, 1);
  f.subject.preferences!.mode = 'off'; f.subject.snapshot(snapshot([node(3)], 5));
  f.subject.preferences!.mode = 'always'; f.subject.snapshot(snapshot([node(3)], 6)); assert.equal(f.shown.length, 1);
  f.subject.preferences!.needsMe = false;
  f.subject.snapshot(snapshot([node(4)], 7)); assert.equal(f.shown.length, 1);
  f.subject.snapshot(snapshot([node(5, { attention: 'none', attentionSources: { completion: 'finished' } })], 8)); assert.equal(f.shown.length, 1, 'finished work raises no banner by default');
  f.subject.preferences!.countFinished = true;
  f.subject.snapshot(snapshot([node(6, { attention: 'none', attentionSources: { completion: 'finished' } })], 9)); assert.equal(f.shown.length, 2);
  f.subject.preferences!.announcements = false;
  f.subject.snapshot(snapshot([node(7, { attention: 'none', attentionSources: { completion: 'finished' } })], 10)); assert.equal(f.shown.length, 2);
});

test('a banner names the tier before the item; finished work stays quiet until it is counted', () => {
  const f = fixture(); f.subject.snapshot(snapshot([]));
  f.subject.snapshot(snapshot([node(1), node(1, { id: 'pr', resourceId: 'pr', title: 'Album table', attention: 'review' }), node(1, { id: 'done', resourceId: 'done', title: 'Resizer', attention: 'none', attentionSources: { completion: 'finished' } }), node(1, { id: 'ok', resourceId: 'ok', title: 'Metrics', attention: 'none', attentionSources: { 'github.review': 'approved' } })], 2));
  assert.deepEqual(f.shown.map(notice => notice.title), ['Asking me · Agent', 'My turn · Album table']);
  f.subject.preferences!.countFinished = true;
  f.subject.snapshot(snapshot([node(1), node(2, { id: 'done', resourceId: 'done', title: 'Resizer', attention: 'none', attentionSources: { completion: 'finished' } })], 3));
  assert.deepEqual(f.shown.slice(2).map(notice => [notice.title, notice.body]), [['Finished · Resizer', 'Finished · ready to view']]);
});

test(`a banner's body is the line the agent ended its turn on, when it has one`, () => {
  const f = fixture(); f.subject.snapshot(snapshot([])); f.subject.preferences!.countFinished = true;
  const finished = { attention: 'none', attentionSources: { completion: 'finished' } };
  f.subject.snapshot(snapshot([node(1, { ...finished, lastLine: 'Tests pass; the PR is ready for review.' }), node(1, { ...finished, id: 'quiet', resourceId: 'quiet', title: 'Resizer' })], 2));
  assert.deepEqual(f.shown.map(notice => [notice.title, notice.body]), [['Finished · Agent', 'Tests pass; the PR is ready for review.'], ['Finished · Resizer', 'Finished · ready to view']]);
});

test('announcements deduplicate, respect settings, allow explicit test and dispose outstanding items', () => {
  const f = fixture(), notice = { key: 'recovery', title: '1 session restored', body: '' };
  assert.equal(f.subject.announcement(notice), true); assert.equal(f.subject.announcement(notice), false);
  f.focus(true); assert.equal(f.subject.announcement({ ...notice, key: 'foreground' }), false);
  f.focus(false); assert.equal(f.subject.announcement({ ...notice, key: 'foreground' }), false);
  f.subject.preferences!.mode = 'off'; assert.equal(f.subject.announcement({ ...notice, key: 'test' }, true), true);
  f.subject.preferences!.mode = 'always'; f.subject.snapshot(snapshot([])); f.subject.snapshot(snapshot([node()], 2));
  f.subject.dispose(); assert.deepEqual(f.closed, ['attention:session:1']);
});

test('large workspaces do not replay unchanged attention after the bounded dedup cache fills', () => {
  const f = fixture();
  const nodes = Array.from({ length: 2100 }, (_, index) => node(1, { id: `node-${index}`, resourceId: `resource-${index}` }));
  f.subject.snapshot(snapshot(nodes)); f.subject.snapshot(snapshot(nodes, 2));
  assert.equal(f.shown.length, 0);
  f.subject.snapshot(snapshot(nodes.map((n, i) => i === 0 ? { ...n, attentionVersion: 2 } : n), 3));
  assert.equal(f.shown.length, 1);
});

test('a muted project raises no native notification, closes the ones it had, and unmuting replays nothing', () => {
  const f = fixture(), project = (mutedAt?: string) => ({ id: 'p', title: 'Website', position: { x: 0, y: 0 }, ...(mutedAt ? { mutedAt } : {}) });
  const member = (version: number, extra = {}) => node(version, { projectId: 'p', ...extra }), other = (version: number) => node(version, { id: 'other', resourceId: 'other-session', title: 'Other' });
  f.subject.snapshot(snapshot([project(), member(1), other(1)]));
  f.subject.snapshot(snapshot([project(), member(2), other(1)], 2));
  assert.equal(f.shown.length, 1);
  f.subject.snapshot(snapshot([project('2026-10-05T08:00:00.000Z'), member(2), other(1)], 3));
  assert.deepEqual(f.closed, ['attention:session:2'], 'muting withdraws its banner');
  f.subject.snapshot(snapshot([project('2026-10-05T08:00:00.000Z'), member(3, { attentionSources: { completion: 'finished' } }), other(1)], 4));
  assert.equal(f.shown.length, 1, 'neither Needs me nor a completion banner');
  f.subject.snapshot(snapshot([project('2026-10-05T08:00:00.000Z'), member(3), other(2)], 5));
  assert.equal(f.shown.length, 2, 'other projects still notify'); assert.equal(f.shown[1].title, 'Asking me · Other');
  f.subject.snapshot(snapshot([project(), member(3), other(2)], 6));
  assert.equal(f.shown.length, 2, 'unmuting is not an event');
  f.subject.snapshot(snapshot([project(), member(4), other(2)], 7));
  assert.equal(f.shown.length, 3, 'and the project notifies again');
});

test('reminders notify whatever the Needs me mode, with or without sound, or only in the app', () => {
  const shown: [string, boolean | undefined][] = [], closed: string[] = [];
  const subject = new DesktopNotifications({ show: (notice, silent) => shown.push([notice.key, silent]), close: key => closed.push(key) }, () => true);
  const notice = { key: 'reminder:stretch:2026-10-07', title: 'Stretch', body: '12:30' };
  subject.preferences = { ...settingsSchema.parse({}).notifications, mode: 'off', sound: false };
  assert.equal(subject.reminder(notice), true, 'the Needs me mode and focus do not gate reminders');
  subject.preferences.reminders = 'silent';
  assert.equal(subject.reminder(notice), true, 'a snoozed reminder notifies again under the same key');
  subject.preferences.reminders = 'app';
  assert.equal(subject.reminder(notice), false);
  assert.deepEqual(shown, [[notice.key, false], [notice.key, true]]);
  assert.deepEqual(closed, [notice.key, notice.key], 'an earlier banner for the same day is replaced');
});
