import type { ResourcePluginViews } from '../../types.ts';
import type { WorkflowReviewStatus } from './action.ts';
import { formatWhen } from '../../format-when.ts';
import { mountViewHeader } from '../../view-header.ts';
import { workflowReviewChip } from '../../state-chips.ts';

export const workflowReviewViews: ResourcePluginViews = {
  identity: resource => String(resource.data.requestId),
  mountDetail(container, resource, services) {
    const document = container.ownerDocument;
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };
    const root = element('section', '', 'wr-detail workflow-review-detail'), source = element('button', 'Back to PR', 'wr-back'), stop = element('button', 'Stop watching');
    source.type = 'button'; stop.type = 'button'; source.onclick = () => services.openResource(String(resource.data.sourcePrId));
    const notice = element('p', '', 'wr-notice'), links = element('nav', '', 'wr-links'), reconciliation = element('div', '', 'workflow-reconciliation'), report = element('pre', '', 'wr-report workflow-report');
    notice.setAttribute('role', 'status'); notice.hidden = true; links.setAttribute('aria-label', 'Workflow links'); root.append(notice, links, reconciliation, report); container.append(root);
    const header = mountViewHeader(document, services, root);
    header.actions.append(stop, source); header.update({ status: { label: 'Reading…', tone: 'neutral' } });
    let active = false, disposed = false, epoch = 0, busy = false, timer: ReturnType<typeof setTimeout> | undefined, rendered = '';
    const run = (operation: string, extra = {}) => services.runAction('pr.review.workflow', { operation, requestId: String(resource.data.requestId), ...extra });
    const link = (title: string, url: string) => { const anchor = element('a', title, 'view-link-out'); anchor.href = url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; return anchor; };
    async function action(operation: 'reconcile' | 'stop', extra = {}) {
      rendered = ''; busy = true; stop.disabled = true; for (const button of reconciliation.querySelectorAll('button')) button.disabled = true;
      try { await run(operation, extra); rendered = ''; }
      catch (error) { notice.textContent = (error as Error).message; notice.hidden = false; }
      finally { busy = false; clearTimeout(timer); if (active) void poll(); }
    }
    stop.onclick = () => { void action('stop'); };
    async function poll() {
      if (disposed || !active || busy) return;
      const current = epoch;
      try {
        const results = await run('status') as unknown as WorkflowReviewStatus[];
        if (disposed || !active || current !== epoch) return;
        const result = results[0]; if (!result) { header.update({ status: { label: 'Unavailable', tone: 'red' } }); notice.textContent = 'This workflow record is unavailable.'; notice.hidden = false; stop.hidden = true; return; }
        const key = JSON.stringify(result); if (key === rendered) return; rendered = key;
        const pr = result.prNumber ? `PR #${result.prNumber}` : 'PR';
        header.update({ status: workflowReviewChip(result.status), meta: [pr, result.repository, 'requested with /review', ...(result.tracking === 'timed' ? ['matched by time'] : [])], ...(result.repository && result.prNumber ? { link: { url: `https://github.com/${result.repository}/pull/${result.prNumber}`, provider: 'GitHub' } } : {}) });
        source.textContent = `← Back to ${pr}`; source.setAttribute('aria-label', `Back to ${pr}`);
        notice.textContent = result.state === 'outcome-unknown' ? '' : result.error ?? ''; stop.hidden = ['succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(result.state); stop.disabled = false;
        links.replaceChildren();
        if (result.triggerId) links.append(link('Review request', `https://github.com/${result.repository}/pull/${result.prNumber}#issuecomment-${result.triggerId}`));
        if (result.runUrl) links.append(link('Workflow run', result.runUrl));
        else if (result.runsUrl) links.append(link('Workflow runs', result.runsUrl));
        if (result.resultUrl) links.append(link('Review result', result.resultUrl));
        report.textContent = result.report ?? (result.state === 'cancelled' ? 'Local watching stopped. Any workflow on GitHub may still be running.' : 'The completed report will appear here.');
        report.hidden = result.state === 'outcome-unknown'; notice.hidden = !notice.textContent;
        reconciliation.replaceChildren();
        if (result.state === 'outcome-unknown') {
          reconciliation.append(element('h2', 'Check whether your review request was posted.'), element('p', 'GitHub did not confirm the response. Open the candidate comment before continuing. Nothing will be posted again automatically.'));
          for (const id of result.candidates) {
            const row = element('article', '', 'workflow-candidate'), choose = element('button', 'Track this request'); choose.setAttribute('aria-label', `Track this request: comment #${id}`); choose.onclick = () => { void action('reconcile', { triggerId: id }); };
            const identity = element('header'), candidate = result.candidateDetails?.find(candidate => candidate.id === id);
            identity.append(element('strong', `Comment #${id}`));
            if (candidate) {
              if (candidate.author) identity.append(element('span', `@${candidate.author}`));
              const date = new Date(candidate.createdAt);
              if (Number.isFinite(date.getTime())) { const time = element('time', formatWhen(date)); time.dateTime = date.toISOString(); time.title = formatWhen(date, 'full'); identity.append(time); }
            }
            const controls = element('div', '', 'workflow-candidate-actions'); controls.append(link('View on GitHub', `https://github.com/${result.repository}/pull/${result.prNumber}#issuecomment-${id}`), choose);
            row.append(identity); if (candidate) row.append(element('pre', candidate.body)); row.append(controls); reconciliation.append(row);
          }
          if (!result.candidates.length) reconciliation.append(link('View pull request on GitHub', `https://github.com/${result.repository}/pull/${result.prNumber}`));
          const absent = element('button', 'I checked: no comment was posted', 'workflow-confirm-absent'); absent.onclick = () => { void action('reconcile', { triggerId: null }); }; reconciliation.append(absent);
        }
      } catch (error) { if (!disposed && active && current === epoch) { notice.textContent = (error as Error).message; notice.hidden = false; } }
      finally { if (!disposed && active && current === epoch) timer = setTimeout(() => { void poll(); }, 1500); }
    }
    return { update() {}, setActive(value) { if (value === active) return; active = value; epoch++; clearTimeout(timer); if (active) void poll(); }, dispose() { disposed = true; epoch++; clearTimeout(timer); header.dispose(); root.remove(); } };
  },
};
