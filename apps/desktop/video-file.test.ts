import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { videoFilePath, videoResponse } from './video-file.ts';

const node = (id: string, resourceId: string, archivedAt?: string) => ({ id, title: id, position: { x: 0, y: 0 }, resourceId, ...(archivedAt ? { archivedAt } : {}) });
const resource = (id: string, pluginId: string, data: Record<string, string>) => ({ id, pluginId, schemaVersion: 1, title: id, data });

test('the video route serves only the file a live video item names, and only a video file', async () => {
  const state = {
    nodes: [node('n1', 'video'), node('n2', 'note'), node('n3', 'archived', '2026-01-01T00:00:00.000Z'), node('n4', 'link')],
    resources: [resource('video', 'workspace.video', { source: '~/Movies/demo.mp4' }), resource('note', 'workspace.text', { path: '/Users/example/demo.mp4' }),
      resource('archived', 'workspace.video', { source: '/Users/example/old.mp4' }), resource('link', 'workspace.video', { source: 'https://youtu.be/dQw4w9WgXcQ' }),
      resource('loose', 'workspace.video', { source: '/Users/example/loose.mp4' })],
  } as never;
  assert.equal(videoFilePath(state, 'video', '/Users/example'), '/Users/example/Movies/demo.mp4');
  for (const id of ['note', 'archived', 'link', 'loose', 'missing', '../etc/passwd']) assert.equal(videoFilePath(state, id, '/Users/example'), undefined, id);

  const folder = await mkdtemp(join(tmpdir(), 'video-route-'));
  await writeFile(join(folder, 'secret.txt'), 'secret'); await symlink(join(folder, 'secret.txt'), join(folder, 'disguised.mp4'));
  assert.equal((await videoResponse(join(folder, 'disguised.mp4'), null)).status, 404);
  await writeFile(join(folder, 'clip.mp4'), '0123456789');
  const part = await videoResponse(join(folder, 'clip.mp4'), 'bytes=2-5');
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(await part.text(), '2345');
});

test('a named pipe named like a video is refused without waiting for a writer', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'video-fifo-'));
  execFileSync('mkfifo', [join(folder, 'pipe.mp4')]);
  assert.equal((await videoResponse(join(folder, 'pipe.mp4'), null)).status, 404);
});
