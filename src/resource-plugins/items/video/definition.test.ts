import test from 'node:test';
import { parseVideoSource } from './source.ts';
import assert from 'node:assert/strict';
import { createResourcePluginRegistry } from '../../builtins.ts';

test('a video path or YouTube link becomes a Video, while other files and links keep their types', () => {
  const registry = createResourcePluginRegistry();
  const file = registry.matchFile('/Users/example/Movies/demo.mp4');
  assert.deepEqual(file.map(match => [match.candidate.pluginId, match.candidate.title, match.candidate.data]), [['workspace.video', 'demo.mp4', { source: '/Users/example/Movies/demo.mp4' }]]);
  for (const url of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42', 'https://youtu.be/dQw4w9WgXcQ?si=x', 'https://youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ']) {
    const matches = registry.matchUrl(url);
    assert.deepEqual(matches.map(match => [match.pluginId, match.data]), [['workspace.video', { source: url }]], url);
  }
  assert.deepEqual(registry.matchFile('/Users/example/notes/plan.md').map(match => match.candidate.pluginId), ['workspace.text']);
  for (const url of ['https://example.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com.example.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/@channel', 'https://www.youtube.com/watch?v=short'])
    assert.deepEqual(registry.matchUrl(url).map(match => match.pluginId), ['web.link'], url);
});

test('a YouTube link with a start time plays and opens from that time', () => {
  for (const url of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754s', 'https://youtu.be/dQw4w9WgXcQ?t=12m34s', 'https://www.youtube.com/embed/dQw4w9WgXcQ?start=754']) {
    const source = parseVideoSource(url);
    assert.deepEqual(source?.kind === 'youtube' && [source.url, source.embedUrl], ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754s', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=754'], url);
  }
});
