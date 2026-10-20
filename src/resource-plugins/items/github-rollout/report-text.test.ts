import test from 'node:test';
import assert from 'node:assert/strict';
import { plainLine, reportText, sentences, splitLead, readableSource } from './report-text.ts';

test('report text keeps paragraphs and list lines, drops control characters, stray spaces and extra blank lines', () => {
  assert.equal(reportText('Preview healthy.\r\n\r\n\r\n\r\n- p95  2.1 s\u0007\n-\tno restarts   \n', 600), 'Preview healthy.\n\n- p95 2.1 s\n- no restarts');
  assert.equal(reportText('  one   line  ', 600), 'one line');
  assert.ok(reportText('word '.repeat(300), 600).length <= 600);
});

test('sentences split at a full stop before a capital, not inside numbers, versions or abbreviations', () => {
  assert.deepEqual(sentences('Upload p95 fell from 200.5 ms to 180.5 ms. The only concern is the settle window, e.g. retries. Memory needs hours (v1.2 vs. v1.3).'),
    ['Upload p95 fell from 200.5 ms to 180.5 ms.', 'The only concern is the settle window, e.g. retries.', 'Memory needs hours (v1.2 vs. v1.3).']);
  assert.deepEqual(sentences('Ready at 10:07! Old set scaled to 0? Yes.'), ['Ready at 10:07!', 'Old set scaled to 0?', 'Yes.']);
  assert.deepEqual(sentences('Checked the U.S. site and the EU site.'), ['Checked the U.S. site and the EU site.']);
});

test('the lead is the first sentence of the first paragraph; the rest keeps its paragraphs', () => {
  assert.deepEqual(splitLead('PR #12 deployed cleanly. Response times matched the baseline; p95 fell.\n\nOne concern: memory per instance.'),
    { lead: 'PR #12 deployed cleanly.', rest: 'Response times matched the baseline; p95 fell.\n\nOne concern: memory per instance.' });
  assert.deepEqual(splitLead('Preview healthy'), { lead: 'Preview healthy', rest: '' });
  assert.deepEqual(splitLead('Preview healthy\n- p95 fine\n- no restarts'), { lead: 'Preview healthy', rest: '- p95 fine\n- no restarts' });
  const long = `${'word '.repeat(60).trim()}. Then more.`;
  assert.deepEqual(splitLead(long), { lead: '', rest: long });
  assert.deepEqual(splitLead('- first\n- second'), { lead: '', rest: '- first\n- second' });
  assert.deepEqual(splitLead(''), { lead: '', rest: '' });
});

test('a long single paragraph reads one sentence per line; written structure and short text stay as they are', () => {
  const dense = 'Before = 10:00-10:10 with 2 instances; after = 11:00-11:10 with 4 instances, so the per-instance numbers are what matter. Per instance: error rate 1 %, now 0.5 %; CPU 0.2, now 0.25; response time p50 0.05 s, now 0.04 s. Two signals are above the 2-instance baseline: error rate and memory.';
  assert.equal(readableSource(dense), sentences(dense).join('\n\n'));
  assert.equal(readableSource('Short. Two sentences.'), 'Short. Two sentences.');
  const written = 'Thumbnails arrived within 2 s.\n\n- 0 failed jobs\n- 2 retries';
  assert.equal(readableSource(written), written);
  const code = `${'Rendered config matches. '.repeat(12)}\`a. B\` stays.`;
  assert.equal(readableSource(code), code);
});

test('a collapsed row reads the observation as one plain line', () => {
  assert.equal(plainLine('Memory grew.\n\n1. 2 instances: **100 MB**\n- see [the dashboard](https://metrics.example.com/d/1) and `top`\n```\nmemory 150\n```'),
    'Memory grew. 2 instances: 100 MB see the dashboard and top memory 150');
});
