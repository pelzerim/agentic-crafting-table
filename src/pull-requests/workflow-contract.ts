import type { JsonObject, ResourceFields } from '../resource-plugins/types.ts';

/** Which repository workflow answers /review, which of its jobs is the review, the text in its
 * result comment that marks a review that did not complete (empty: rely on the job result), and a
 * regular expression a line of a finished review matches. Requests stored without a marker use the default. */
export interface WorkflowReviewContract { workflowPath: string; jobName: string; failureText: string; reportMarker?: string }

/** A Markdown heading or a bold label such as `**Verdict:**` at the start of a line. */
const DEFAULT_REPORT_MARKER = String.raw`^(?:#{1,6} +\S|\*\*[^*\n]+:\*\*)`;
export const DEFAULT_WORKFLOW_REVIEW_CONTRACT: Readonly<Required<WorkflowReviewContract>> = Object.freeze({ workflowPath: '.github/workflows/review.yml', jobName: 'review', failureText: '', reportMarker: DEFAULT_REPORT_MARKER });

/** The marker as a case-insensitive, per-line expression; an empty or invalid one falls back to the default. */
export function reportMarker(contract: Pick<WorkflowReviewContract, 'reportMarker'>) {
  try { return new RegExp(contract.reportMarker || DEFAULT_REPORT_MARKER, 'im'); } catch { return new RegExp(DEFAULT_REPORT_MARKER, 'im'); }
}
export function validateReportMarker(values: JsonObject) {
  const marker = values.reportMarker;
  if (typeof marker !== 'string' || !marker) return;
  try { new RegExp(marker, 'im'); } catch (error) { throw new Error(`Report marker is not a valid regular expression (${(error as Error).message})`); }
}

const path = String.raw`\.github/workflows/[A-Za-z0-9_.\-]+\.ya?ml`, job = String.raw`[A-Za-z0-9_][A-Za-z0-9 _.\(\)\-]{0,99}`, repository = String.raw`[\w.\-]+/[\w.\-]+`;
const blank = String.raw`[ \t]*`;
const line = `${blank}${repository}${blank}(?:\\|${blank}(?:${path})?${blank}(?:\\|${blank}(?:${job})?${blank}(?:\\|[^|\\n]*)?)?)?`;

export const workflowReviewSettingsFields: ResourceFields = {
  workflowPath: { label: 'Workflow file', kind: 'text', required: true, default: DEFAULT_WORKFLOW_REVIEW_CONTRACT.workflowPath, pattern: `^${path}$`,
    description: 'The repository workflow that runs when /review is posted on a pull request.' },
  jobName: { label: 'Review job', kind: 'text', required: true, default: DEFAULT_WORKFLOW_REVIEW_CONTRACT.jobName, pattern: `^${job}$`,
    description: 'The job in that workflow that writes the review.' },
  failureText: { label: 'Failure text', kind: 'text', default: DEFAULT_WORKFLOW_REVIEW_CONTRACT.failureText,
    description: 'Text in the result comment meaning the review did not complete. Leave empty to rely on the job result.' },
  reportMarker: { label: 'Report marker', kind: 'text', default: DEFAULT_WORKFLOW_REVIEW_CONTRACT.reportMarker,
    description: 'A regular expression, matched case-insensitively at the start of any line, that the result comment contains once the review is written. Leave empty for the default: a Markdown heading or a bold label such as **Verdict:**.' },
  repositories: { label: 'Repository overrides', kind: 'text', multiline: true, rows: 3, default: '', pattern: `^(?:(?:${line})?${blank}(?:\\n|$))*$`,
    description: 'One repository per line: owner/repo | workflow file | job | failure text. Empty or missing parts use the values above.' },
};

/** Per-repository parts keyed by lower-case owner/repo. */
export function parseRepositoryOverrides(text: string): Map<string, Partial<WorkflowReviewContract>> {
  const overrides = new Map<string, Partial<WorkflowReviewContract>>();
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    const [name, workflowPath = '', jobName = '', ...failure] = raw.split('|').map(part => part.trim());
    const failureText = failure.join('|').trim();
    if (failure.length > 1 || !new RegExp(`^${repository}$`).test(name) || (workflowPath && !new RegExp(`^${path}$`).test(workflowPath)) || (jobName && !new RegExp(`^${job}$`).test(jobName))) {
      throw new Error(`Invalid /review repository override: ${raw.trim().slice(0, 120)}`);
    }
    overrides.set(name.toLowerCase(), { ...(workflowPath ? { workflowPath } : {}), ...(jobName ? { jobName } : {}), ...(failureText ? { failureText } : {}) });
  }
  return overrides;
}

/** The contract for one repository from the github.review-run package settings. */
export function workflowReviewContract(settings: JsonObject | undefined, repositoryName: string): WorkflowReviewContract {
  const text = (key: keyof WorkflowReviewContract) => typeof settings?.[key] === 'string' ? settings[key] as string : DEFAULT_WORKFLOW_REVIEW_CONTRACT[key];
  const base = { workflowPath: text('workflowPath'), jobName: text('jobName'), failureText: text('failureText'), reportMarker: text('reportMarker') };
  const overrides = typeof settings?.repositories === 'string' ? parseRepositoryOverrides(settings.repositories) : undefined;
  return { ...base, ...overrides?.get(repositoryName.toLowerCase()) };
}

export const workflowFileName = (contract: Pick<WorkflowReviewContract, 'workflowPath'>) => contract.workflowPath.slice(contract.workflowPath.lastIndexOf('/') + 1);
