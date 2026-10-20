import type { ReviewFindings } from '../../src/pull-requests/review-findings.ts';

/** Sample output of a structured review; no provider or customer content. */
export const sampleReview: ReviewFindings = {
  schemaVersion: 1, summary: 'No blocking issues. Two low cancellation gaps and one hardening idea.',
  findings: [
    { id: 'F1', kind: 'bug', severity: 'low', title: 'Thumbnails are resized synchronously', verification: { level: 'partial', note: 'Impact is an estimate' }, locations: [{ path: 'src/thumbnails.ts', startLine: 170, endLine: 172 }], when: 'An album uploads many photos.', why: ['Blocks the event loop.'], fix: 'Resize asynchronously.' },
    { id: 'F2', kind: 'hardening', title: 'Readers match exact file names', verification: { level: 'verified' }, locations: [{ path: 'src/handler.ts', startLine: 380 }], details: 'Safe today.' },
    { id: 'F3', kind: 'bug', severity: 'critical', title: 'Tokens are logged', verification: { level: 'unverified' }, locations: [{ path: 'src/log.ts', startLine: 10 }] },
  ],
  checked: ['File names stay unique'], tests: { ran: false, notes: 'I did not run tests.' },
};

/** One open question with a long title and verification note; used to check wrapping,
 * clamping and detail scrolling. Sample data only. */
export const questionReview: ReviewFindings = {
  schemaVersion: 1,
  summary: 'Looks correct. Uploads and imports now resize photos the same way, and I found no code in this sample app that still reads the removed settings. The one open question is whether every environment already sets the thumbnail folder.',
  findings: [{
    id: 'F1', kind: 'question', qualifier: 'The PR accepts this risk and says every environment sets the folder',
    title: 'Making THUMBNAIL_CACHE_DIR required stops the whole photo service from starting in any environment that does not set it, including local development and preview sites',
    verification: { level: 'partial', note: 'Confirmed that the base revision fell back to a temporary folder and that the head revision marks the setting as required. The environment settings were not part of the checkout, so their values could not be checked.' },
    locations: [{ path: 'services/photos/config.ts', startLine: 340 }, { path: 'services/photos/cache.ts', startLine: 80, endLine: 90 }],
    when: 'The photo service starts in an environment where THUMBNAIL_CACHE_DIR is unset.',
    why: ['Before this change a missing folder only slowed thumbnails down; now the whole service refuses to start.', 'Failing the whole service is a large failure for a setting only the thumbnail cache uses.'],
    fix: 'Before merging, confirm that every environment already sets THUMBNAIL_CACHE_DIR. Alternatively, keep the setting optional at start and warn when the cache is first used, so a missing value cannot take down unrelated pages.',
  }],
  checked: ['Uploads and imports resize the same way', 'No remaining readers of the removed flag', 'No remaining readers of the removed settings', 'Thumbnail names derive from the photo id', 'Retry counts are unchanged', 'Imports share the upload path', 'Metrics labels are unchanged', 'Tests cover both paths'],
  tests: { ran: false, notes: 'I did not run tests; the checkout was read-only.' },
};
