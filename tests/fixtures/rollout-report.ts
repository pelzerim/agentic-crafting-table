/** A long progress report: a summary of several sentences, six checks with multi-sentence
 * observations, metrics with windows, evidence and skipped checks with their reason. Sample data only. */
export const longReport = {
  validationId: 'V1', sequence: 1, phase: 'progress',
  summary: 'PR #12 deployed cleanly to both environments. The thumbnail service started on preview without restarts; 4 instances were replaced between 10:05 and 10:15 and served 0 errors while traffic stayed steady. Response times on photos.example.com matched the PR #11 baseline within noise for every image size. The only concern is memory per instance, which rose after the switch and needs a longer window to judge.',
  checks: [
    { id: 'C1', title: 'Instances ready and serving without restarts', status: 'passed', target: 'preview', method: 'metrics', observation: 'All 4 instances became ready within a minute of each other. Restarts stayed at 0 for the whole window, and health checks passed on the first try.',
      metrics: [{ label: 'restarts per instance', before: 0, after: 0, window: '30 min before vs 30 min after' }, { label: 'ready time', before: 50, after: 40, unit: 's', better: 'lower', window: 'start to ready' }] },
    { id: 'C2', title: 'Error rate and latency on photos.example.com stay within the baseline', status: 'concern', target: 'live', method: 'metrics', observation: 'Before and after are 10-minute windows with the same traffic and the same number of uploads per minute. Error rate stayed at 0.5 % and p95 response time fell from 200 ms to 180 ms for every image size. Memory per instance rose from 100 MB to 150 MB, which is within what the larger thumbnails explain but worth a look before the next stage.',
      metrics: [{ label: 'error rate', before: 0.5, after: 0.5, unit: '%', better: 'lower', window: '10 min before vs 10 min after' }, { label: 'p95 response time', before: 200, after: 180, unit: 'ms', better: 'lower' }, { label: 'memory per instance', before: 100, after: 150, unit: 'MB', better: 'lower' }],
      evidence: [{ label: 'Dashboard · thumbnails', url: 'https://metrics.example.com/d/thumbnails', kind: 'dashboard' }, { label: 'Logs · thumbnails', url: 'https://logs.example.com/q?thumbnails', kind: 'logs' }] },
    { id: 'C3', title: 'Settings applied as in the pull request', status: 'passed', method: 'code', observation: 'The rendered config matches the pull request: thumbnail size 256 -> 320 and cache lifetime 1 h -> 6 h.', jobIds: [201],
      evidence: [{ label: 'GitHub job', url: 'https://github.com/fixture/web/actions/runs/101/job/201', kind: 'job' }] },
    { id: 'C4', title: 'Image pipeline keeps up', status: 'passed', target: 'live', method: 'logs', observation: 'Every upload got its thumbnails within 2 s; the 2 retries in the window succeeded on the second try.' },
    { id: 'C5', title: 'Long-term memory growth', status: 'skipped', method: 'metrics', observation: 'Needs a day of traffic to tell growth from warm-up.' },
    { id: 'C6', title: 'Live environment after the approval gate', status: 'skipped', observation: 'Not deployed yet: the run is waiting at the approval gate.' },
  ],
  recommendations: [{ text: 'Re-check memory per instance tomorrow; if it keeps growing, hold the next stage.', blocking: false }, { text: 'Compare against a baseline with the same number of instances before promoting.', blocking: false }],
};
