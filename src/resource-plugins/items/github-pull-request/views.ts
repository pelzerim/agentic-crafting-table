import { commentKey, commentVersion, commentUrl } from './comment-state.ts';
import { reviewDeskItem } from './desk.ts';
import { findingGlyph, reviewGlyph } from '../code-review/desk.ts';
import { DEFAULT_CONVERSATION, visibleComments, conversationThreads, commentPreview } from './discussion.ts';
import type { PullComment } from './discussion.ts';
import { renderMarkdown } from '../../markdown-view.ts';
import { mountWorkflowAction } from '../github-review-run/action.ts';
import { runArchitectureAction, runReviewContextAction } from './context-actions.ts';
import { openResourceChoices } from '../../choices.ts';
import { titleTag } from './show-ship.ts';
import { AUTO_DEPLOY_OPERATION } from '../github-rollout/auto-deploy.ts';
import { mountReviewLoop } from './review-loop-line.ts';
import { previewPull } from './preview.ts';
import { formatWhen } from '../../format-when.ts';
import { emptyState, mountViewHeader, skeleton, staleNotice } from '../../view-header.ts';
import { autoValidates, pullHeader, pullViewIdentity } from './header.ts';
import type { JsonObject, ResourcePluginViews, ResourceSnapshot, RelatedResourceItem } from '../../types.ts';
import type { GitHubPullRequest } from '../../../../packages/provider-runtime/github.ts';

export const githubPullRequestViews: ResourcePluginViews = {
  runContextAction: runReviewContextAction,
  preview: previewPull,
  identity: pullViewIdentity,
  mountDetail(container, resource, services) {
    const document = container.ownerDocument;
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => {
      const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
    };
    const root = element('section', '', 'pr-detail pr-desk');
    const repository = `${resource.data.owner}/${resource.data.repo}`, url = `https://github.com/${repository}/pull/${resource.data.number}`;
    const link = { url, provider: 'GitHub' };
    const error = element('p', '', 'pr-error'); error.setAttribute('role', 'status'); error.hidden = true;
    const body = element('div', '', 'pr-content');
    const reviewToggle = element('button', 'Review', 'pr-review-toggle'); reviewToggle.type = 'button'; reviewToggle.setAttribute('aria-label', 'Review');
    reviewToggle.setAttribute('aria-expanded', 'false');
    const actions = element('div', '', 'pr-review-actions'); actions.hidden = true;
    reviewToggle.onclick = () => { actions.hidden = !actions.hidden; reviewToggle.setAttribute('aria-expanded', String(!actions.hidden)); };
    const author = element('span', '', 'pr-meta'), refs = element('code', '', 'pr-refs'), commits = element('code', '', 'pr-commits');
    const meta = element('div', '', 'pr-metadata'); meta.append(author, refs);
    const description = element('div', '', 'pr-description markdown-content');
    const descriptionPanel = element('details', '', 'pr-description-panel'), descriptionSummary = element('summary', 'Description');
    descriptionPanel.append(descriptionSummary, meta, description, commits);
    const tools = element('div', '', 'pr-tools'), primary = element('div', '', 'pr-primary-actions');
    const merge = element('button', 'Merge', 'pr-merge'); merge.type = 'button'; merge.setAttribute('aria-label', 'Merge'); merge.disabled = true; merge.setAttribute('aria-expanded', 'false'); merge.dataset.irreversible = '';
    let closeMerge: (() => void) | undefined;
    merge.onclick = () => {
      if (!active || disposed || merge.disabled) return;
      if (merge.getAttribute('aria-expanded') === 'true') { closeMerge?.(); return; }
      closeMerge = openResourceChoices(merge, services, { load: 'pr.merge.options', apply: 'pr.merge', irreversible: true, pickConfirms: true }, () => active && !disposed ? load(true) : Promise.resolve(),
        report, { menu: 'Merge pull request', loading: 'Merging…', pending: 'Merging on GitHub…', reportLoad: true, first: true });
    };
    const showShip = element('button', 'Show/Ship', 'pr-show-ship'); showShip.type = 'button'; showShip.setAttribute('aria-label', 'Show/Ship'); showShip.disabled = true; showShip.setAttribute('aria-haspopup', 'menu'); showShip.setAttribute('aria-expanded', 'false');
    let closeShowShip: (() => void) | undefined;
    showShip.hidden = true;
    const applyTitleTags = (preferences: JsonObject) => {
      const own = preferences.plugins && typeof preferences.plugins === 'object' && !Array.isArray(preferences.plugins) ? preferences.plugins['github.pull-request'] : undefined;
      showShip.hidden = !(own && typeof own === 'object' && !Array.isArray(own) && own.showShip === true);
      if (showShip.hidden) closeShowShip?.();
    };
    showShip.onclick = () => {
      if (!active || disposed || showShip.disabled) return;
      if (showShip.getAttribute('aria-expanded') === 'true') { closeShowShip?.(); return; }
      closeShowShip = openResourceChoices(showShip, services, { load: 'pr.showShip.options', apply: 'pr.showShip' }, () => active && !disposed ? load(true) : Promise.resolve(),
        report, { menu: 'Show or ship', loading: 'Checking the title…', pending: 'Updating the title on GitHub…', reportLoad: true });
    };
    // Draft/ready and close/reopen narrow the shared Change state menu to the one transition they name.
    const stateButton = (className: string) => { const button = element('button', '', className); button.type = 'button'; button.hidden = true; button.disabled = true; button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false'); return button; };
    const draftToggle = stateButton('pr-draft-toggle'), closeToggle = stateButton('pr-close-toggle');
    let closeState: (() => void) | undefined;
    const openState = (button: HTMLButtonElement, only: string) => {
      if (!active || disposed || button.disabled) return;
      if (button.getAttribute('aria-expanded') === 'true') { closeState?.(); return; }
      closeState?.();
      closeState = openResourceChoices(button, services, { load: 'pr.state.options', apply: 'pr.state' }, () => active && !disposed ? load(true) : Promise.resolve(),
        report, { menu: button.textContent ?? 'Change state', loading: 'Checking the pull request…', pending: 'Updating the pull request on GitHub…', only, reportLoad: true });
    };
    draftToggle.onclick = () => openState(draftToggle, draftToggle.dataset.change ?? '');
    closeToggle.onclick = () => openState(closeToggle, closeToggle.dataset.change ?? '');
    draftToggle.dataset.menuGroup = closeToggle.dataset.menuGroup = 'state';
    const autoDeploy = element('button', 'Auto deploy', 'pr-auto-deploy'); autoDeploy.type = 'button'; autoDeploy.setAttribute('aria-label', 'Auto deploy'); autoDeploy.setAttribute('aria-haspopup', 'menu'); autoDeploy.setAttribute('aria-expanded', 'false');
    autoDeploy.title = 'Tag, merge, deploy, validate and approve every phase, halting on any doubt';
    let closeAutoDeploy: (() => void) | undefined;
    autoDeploy.onclick = () => {
      if (!active || disposed) return;
      if (autoDeploy.getAttribute('aria-expanded') === 'true') { closeAutoDeploy?.(); return; }
      closeAutoDeploy = openResourceChoices(autoDeploy, services, { load: 'options', apply: 'set', runtime: AUTO_DEPLOY_OPERATION }, () => active && !disposed ? readAutoDeploy() : Promise.resolve(),
        report, { menu: 'Auto deploy', loading: 'Checking auto deploy…', pending: 'Updating auto deploy…', reportLoad: true });
    };
    const deployText = element('span', '', 'pr-auto-deploy-text'), stopDeploy = element('button', 'Stop', 'pr-auto-deploy-stop'); stopDeploy.type = 'button';
    stopDeploy.setAttribute('aria-label', 'Stop auto deploy'); stopDeploy.title = 'Nothing further is tagged, merged or approved. A write already sent is not undone.';
    const deployStatus = element('div', '', 'pr-auto-deploy-status'); deployStatus.setAttribute('role', 'status'); deployStatus.hidden = true; deployStatus.append(deployText, stopDeploy);
    stopDeploy.onclick = async () => {
      stopDeploy.disabled = true;
      try { await services.runAction(AUTO_DEPLOY_OPERATION, { operation: 'set', value: 'stop', sourceResourceId: resource.id, requestId: crypto.randomUUID() }); await readAutoDeploy(); }
      catch (failure) { report((failure as Error).message); }
      finally { stopDeploy.disabled = false; }
    };
    /** The status line follows the service's record: armed with Stop, then its last word (done or halted) until the next start. */
    async function readAutoDeploy() {
      const value = await services.runAction(AUTO_DEPLOY_OPERATION, { operation: 'status' }).catch(() => undefined) as { state?: string; line?: string } | undefined;
      if (disposed) return;
      const state = value?.state ?? 'off';
      deployStatus.hidden = !value?.line || state === 'stopped'; deployStatus.dataset.state = state;
      deployText.textContent = value?.line ?? ''; stopDeploy.hidden = state !== 'armed';
      autoDeploy.textContent = state === 'armed' ? 'Auto deploy · on' : 'Auto deploy'; autoDeploy.setAttribute('aria-label', autoDeploy.textContent);
    }
    const reviewLoop = mountReviewLoop(document, services, resource, message => report(message));
    primary.append(reviewToggle, reviewLoop.entry, showShip, merge, autoDeploy, draftToggle, closeToggle); tools.append(descriptionPanel);
    const discussion = element('section', '', 'pr-discussion'); discussion.setAttribute('aria-label', 'Conversation');
    const discussionTitle = element('h3', 'Conversation'), entries = element('div', 'Loading comments…', 'pr-comments');
    const filters = element('details', '', 'pr-filters'), filterSummary = element('summary', 'Human comments');
    const filterOptions = element('div', '', 'pr-filter-options'); filters.append(filterSummary, filterOptions);
    const seenAll = element('button', 'Mark all seen', 'pr-seen-all'); seenAll.type = 'button'; seenAll.hidden = true;
    seenAll.title = 'Mark every comment loaded here as seen, including filtered ones';
    const conversationHeader = element('div', '', 'pr-conversation-header'); conversationHeader.append(discussionTitle, seenAll, filters);
    const seenSection = element('details', '', 'pr-seen'), seenSummary = element('summary'), seenEntries = element('div'); seenSection.append(seenSummary, seenEntries);
    discussion.append(conversationHeader, entries, seenSection);
    const desk = element('div', '', 'pr-desk-columns'), sidebar = element('details', '', 'pr-related'); sidebar.setAttribute('aria-label', 'Connected items'); sidebar.hidden = true;
    const relatedSummary = element('summary', 'Connected reviews'), relatedEntries = element('div'); sidebar.append(relatedSummary, relatedEntries);
    tools.append(sidebar); desk.append(discussion);
    const loadingBody = skeleton(document);
    body.append(loadingBody, tools, actions, desk);
    const workflowAction = mountWorkflowAction(actions, services);
    const reviewStatus = element('span', '', 'pr-review-status'); reviewStatus.setAttribute('role', 'status');
    // Explain architecture sits with the other Claude/Codex analyses; the map menu shares runArchitectureAction.
    const architecture = element('section', '', 'pr-review-action pr-architecture-action'); architecture.setAttribute('aria-label', 'Explain architecture');
    const explainControls = element('div', '', 'pr-review-controls'), explain = element('button', 'Explain architecture'); explain.type = 'button';
    explainControls.append(explain);
    architecture.append(element('strong', 'Architecture'), explainControls, element('small', 'Claude · publishes a private artifact'));
    actions.insertBefore(architecture, actions.querySelector('.pr-workflow-action'));
    let explaining: AbortController | undefined;
    explain.onclick = async () => {
      if (explaining || disposed) return;
      const controller = explaining = new AbortController(); explain.disabled = true; reviewStatus.textContent = 'Preparing the architecture session…';
      try { const { nodeId } = await runArchitectureAction(services, controller.signal); if (!disposed) { reviewStatus.textContent = ''; if (active) services.openResource(nodeId); } }
      catch (failure) { if (!controller.signal.aborted && !disposed) reviewStatus.textContent = (failure as Error).message; }
      finally { if (explaining === controller) { explaining = undefined; if (!disposed) explain.disabled = false; } }
    };
    root.append(reviewStatus, reviewLoop.status, deployStatus, error, body); container.append(root);
    const header = mountViewHeader(document, services, root, { menu: 'Actions', onRefresh: () => { actionNotice = ''; void load(true); } });
    const autoValidate = element('label', '', 'pr-auto-validate'), autoValidateBox = element('input'); autoValidateBox.type = 'checkbox'; autoValidateBox.checked = autoValidates(resource);
    autoValidate.append(autoValidateBox, document.createTextNode('Auto validate'));
    autoValidate.title = 'Validate every rollout this pull request starts after its merge, with a ready connected agent';
    autoValidateBox.onchange = async () => {
      const on = autoValidateBox.checked; autoValidateBox.disabled = true;
      try { await services.saveData?.({ autoValidate: on ? null : false }); }
      catch (failure) { autoValidateBox.checked = !on; if (!disposed) notify((failure as Error).message); }
      finally { autoValidateBox.disabled = false; }
    };
    header.actions.append(autoValidate, primary); header.update({ meta: pullHeader(undefined, undefined, repository).meta, link });
    let pull: GitHubPullRequest | undefined, disposed = false, active = false, generation = 0, observedAt: string | undefined;
    let statusTimer: ReturnType<typeof setTimeout> | undefined;
    let loading = false, renderedPull = '', renderedDiscussion = '';
    let seen: Record<string, boolean> = {}, latestComments: PullComment[] = [], latestTotal = 0;
    const drafts = new Map<string, string>();
    const commentNodes = new Map<string, { version: string; entry: HTMLElement; content: HTMLElement; preview: HTMLButtonElement; controls: HTMLElement; seenButton: HTMLButtonElement; expand: HTMLButtonElement; agents: HTMLSelectElement; fix: HTMLButtonElement }>();
    function updateAgents() {
      const agents = related.filter(item => item.resource?.pluginId === 'agent.session');
      for (const row of commentNodes.values()) {
        const selected = row.agents.value;
        row.agents.replaceChildren(...agents.map(item => { const option = element('option', item.title); option.value = item.nodeId; return option; }));
        if (agents.some(item => item.nodeId === selected)) row.agents.value = selected;
        row.agents.hidden = agents.length < 2;
        row.fix.hidden = !agents.length;
        const target = agents.find(item => item.nodeId === row.agents.value);
        row.fix.disabled = row.fix.dataset.sent === 'true' || row.fix.dataset.sending === 'true' || !target || target.activity !== 'idle' || target.attention === 'input' || !target.resource?.data.sessionId;
        row.fix.title = row.fix.disabled ? 'The connected agent must be ready for a new prompt' : `Send fix request to ${target?.title}`;
      }
    }
    let visibility = { ...DEFAULT_CONVERSATION };
    let offPreferences: (() => void) | undefined;
    for (const [key, label] of Object.entries({ comments: 'Human discussion comments', threads: 'Code comments and thread replies', reviewBodies: 'Written review comments', bots: 'Include bots and GitHub Actions', activity: 'Approvals and other review activity without comments' })) {
      const input = element('input'); input.type = 'checkbox'; input.dataset.filter = key;
      input.onchange = () => { visibility = { ...visibility, [key]: input.checked }; renderComments(latestComments, latestTotal); };
      const field = element('label'); field.append(input, document.createTextNode(label)); filterOptions.append(field);
    }
    filterOptions.append(element('small', 'For this view. Save defaults in Settings → Items → GitHub pull request.'));
    seenAll.onclick = async () => {
      seenAll.disabled = true;
      try {
        seen = await services.runAction('pr.comments', { operation: 'seen-all', sourceResourceId: resource.id, comments: (latestComments ?? []).map(comment => ({ kind: comment.kind, id: comment.id, version: commentVersion(comment) })) }) as Record<string, boolean>;
        renderComments(latestComments, latestTotal);
      } catch (error) { seenAll.title = (error as Error).message; }
      finally { seenAll.disabled = false; }
    };
    function renderComments(value: PullComment[] | undefined, total = value?.length ?? 0) {
      if (!value) { entries.replaceChildren(emptyState(document, 'Comments unavailable in this saved copy.', { detail: 'Refresh to read them from GitHub.' })); return; }
      latestComments = value; latestTotal = total;
      if (discussion.contains(document.activeElement) && document.activeElement?.tagName === 'TEXTAREA') return;
      const key = JSON.stringify([value, total, pull?.head.sha, seen, visibility]); if (key === renderedDiscussion) return; renderedDiscussion = key;
      const focused = discussion.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
      const visible = visibleComments(value, visibility);
      discussionTitle.textContent = `Conversation${value.length ? ` · ${visible.filter(c => !seen[commentKey(c)]).length} unseen` : ''}`;
      seenAll.hidden = !value.some(c => !seen[commentKey(c)]);
      filterSummary.textContent = JSON.stringify(visibility) === JSON.stringify(DEFAULT_CONVERSATION) ? 'Human comments' : 'Filtered comments';
      for (const input of filterOptions.querySelectorAll<HTMLInputElement>('input')) input.checked = visibility[input.dataset.filter as keyof typeof visibility];
      visible.forEach(comment => {
        const id = commentKey(comment), version = commentVersion(comment);
        let row = commentNodes.get(id);
        if (!row || row.version !== version) {
          const entry = element('article', '', 'pr-comment'), meta = element('header', '', 'pr-comment-meta');
          entry.dataset.kind = comment.kind; entry.dataset.commentId = String(comment.id);
          const avatar = element('span', comment.author.slice(0, 2).toUpperCase(), 'pr-avatar'); avatar.setAttribute('aria-hidden', 'true');
          const link = element('a', comment.author); link.href = commentUrl(url, comment); link.target = '_blank'; link.rel = 'noopener noreferrer';
          const date = element('time', formatWhen(comment.date)); date.dateTime = comment.date; date.title = formatWhen(comment.date, 'full');
          const reviewLabel = ({ APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', DISMISSED: 'Dismissed', COMMENTED: 'Reviewed' } as Record<string, string>)[comment.reviewState ?? ''];
          const cue = element('span', reviewLabel ?? (comment.kind === 'inline' ? 'Code comment' : comment.kind === 'review' ? 'Review' : ''), 'pr-comment-state');
          if (comment.reviewState) cue.dataset.state = comment.reviewState;
          const fresh = element('span', 'New', 'act-chip pr-comment-new'); fresh.dataset.tone = 'info'; fresh.title = 'Not marked seen yet';
          meta.append(link, fresh, cue, date);
          if (comment.kind === 'review') meta.append(element('small', '', 'pr-comment-revision'));
          const content = element('div', '', 'markdown-content'); renderMarkdown(content, comment.body, { allowHtml: true });
          const controls = element('div', '', 'pr-comment-controls'), feedback = element('small', '', 'pr-comment-feedback'); feedback.setAttribute('role', 'status');
          const seenButton = element('button'), expand = element('button', 'Expand comment');
          const preview = element('button', '', 'pr-comment-preview');
          const plain = content.cloneNode(true) as HTMLElement;
          for (const block of plain.querySelectorAll('p,div,li,br,h1,h2,h3,h4,summary,tr,pre,blockquote')) block.append(document.createTextNode(' '));
          preview.textContent = commentPreview(plain.textContent ?? '') || reviewLabel || 'No written comment';
          preview.setAttribute('aria-label', `Expand comment by ${comment.author}`);
          content.id = `pr-comment-body-${resource.id}-${id}`; preview.setAttribute('aria-controls', content.id); expand.setAttribute('aria-controls', content.id);
          content.hidden = true; preview.setAttribute('aria-expanded', 'false'); expand.setAttribute('aria-expanded', 'false');
          expand.onclick = preview.onclick = () => { content.hidden = !content.hidden; preview.hidden = !content.hidden; expand.textContent = content.hidden ? 'Expand comment' : 'Collapse comment'; expand.setAttribute('aria-expanded', String(!content.hidden)); preview.setAttribute('aria-expanded', String(!content.hidden)); if (preview.hidden) expand.focus(); };
          seenButton.onclick = async () => {
            seenButton.disabled = true;
            try { seen = await services.runAction('pr.comments', { operation: 'seen', sourceResourceId: resource.id, kind: comment.kind, id: comment.id, version, seen: !seen[id] }) as Record<string, boolean>; renderComments(latestComments, latestTotal); }
            catch (error) { feedback.textContent = (error as Error).message; }
            finally { seenButton.disabled = false; }
          };
          const copy = element('button', 'Copy link'); copy.onclick = async () => { try { await services.copyUrl?.(link.href); feedback.textContent = 'Link copied'; } catch { feedback.textContent = 'Could not copy link'; } };
          const reply = element('button', 'Reply'), editor = element('div', '', 'pr-reply-editor'); editor.hidden = true;
          const draft = element('textarea'); draft.value = drafts.get(id) ?? ''; draft.oninput = () => drafts.set(id, draft.value); if (draft.value) editor.hidden = false; draft.onblur = () => { setTimeout(() => { if (!disposed) renderComments(latestComments, latestTotal); }, 0); }; draft.maxLength = 60_000; draft.setAttribute('aria-label', `Reply to ${comment.author}`);
          const send = element('button', 'Post reply'), cancel = element('button', 'Cancel');
          const hint = element('small', comment.kind === 'inline' ? 'Replies in this code thread on GitHub.' : 'Posts in the PR discussion with a link to this comment.');
          editor.append(hint, draft, send, cancel);
          reply.onclick = () => { editor.hidden = !editor.hidden; if (!editor.hidden) draft.focus(); };
          cancel.onclick = () => { editor.hidden = true; };
          send.onclick = async () => {
            if (!draft.value.trim()) { draft.focus(); return; }
            const request = { requestId: crypto.randomUUID(), sourceResourceId: resource.id, kind: comment.kind, commentId: String(comment.id), body: draft.value };
            send.disabled = true; draft.disabled = true; feedback.textContent = 'Posting reply…';
            try { await services.runAction('resource.action', { actionId: 'reply', input: request }); feedback.textContent = 'Reply posted'; draft.value = ''; drafts.delete(id); editor.hidden = true; send.disabled = false; await load(true); }
            catch (error) { feedback.textContent = `${(error as Error).message} Check GitHub before trying again.`; }
            finally { draft.disabled = false; /* An explicit new editor is required after an uncertain write. */ }
          };
          const agents = element('select'); agents.setAttribute('aria-label', 'Agent for fix request'); agents.onchange = updateAgents;
          const fix = element('button', 'Fix with agent');
          let fixRequest: { operation: string; sourceResourceId: string; kind: string; id: number; version: string; targetNodeId: string; sessionId: string; requestId: string } | undefined;
          fix.onclick = async () => {
            const target = related.find(item => item.nodeId === agents.value), sessionId = target?.resource?.data.sessionId;
            if (!target || typeof sessionId !== 'string') return;
            fix.disabled = true; agents.disabled = true; fix.dataset.sending = 'true';
            fixRequest ??= { operation: 'fix', sourceResourceId: resource.id, kind: comment.kind, id: comment.id, version, targetNodeId: target.nodeId, sessionId, requestId: crypto.randomUUID() };
            try { await services.runAction('pr.comments', fixRequest); feedback.textContent = `Fix request sent to ${target.title}`; fix.dataset.sent = 'true'; fix.textContent = 'Sent to agent'; }
            catch (error) { feedback.textContent = (error as Error).message; }
            finally { delete fix.dataset.sending; updateAgents(); }
          };
          const quick = element('span', '', 'pr-comment-quick'); quick.append(seenButton, copy); meta.append(quick);
          controls.append(expand, reply, agents, fix);
          const message = element('div', '', 'pr-comment-message'); message.append(meta, preview, content, controls, editor, feedback); entry.append(avatar, message);
          row = { version, entry, content, preview, controls, seenButton, expand, agents, fix }; commentNodes.set(id, row);
        }
        const revision = row.entry.querySelector('.pr-comment-revision');
        if (revision) revision.textContent = !comment.headSha ? 'Revision unverified' : comment.headSha !== pull?.head.sha ? 'Earlier revision' : '';
        const wasSeen = row.entry.dataset.seen === 'true';
        row.entry.dataset.seen = String(!!seen[id]);
        row.seenButton.textContent = seen[id] ? 'Mark unseen' : 'Mark seen';
        if (seen[id] && !wasSeen) { row.content.hidden = true; row.preview.hidden = false; row.expand.textContent = 'Expand comment'; row.expand.setAttribute('aria-expanded', 'false'); row.preview.setAttribute('aria-expanded', 'false'); }

      });
      // Move existing articles instead of rebuilding their forms during polling.
      const unseenGroups: HTMLElement[] = [], readGroups: HTMLElement[] = [];
      for (const thread of conversationThreads(visible, value)) {
        const group = element('section', '', 'pr-thread'); group.dataset.thread = thread.key;
        const source = thread.comments.find(c => c.path) ?? thread.hiddenRoot;
        if (thread.rootId && !thread.comments.some(c => c.id === thread.rootId)) {
          const context = element('a', thread.hiddenRoot ? `Replying to hidden comment by ${thread.hiddenRoot.author}` : 'Replying to a comment outside this saved conversation', 'pr-thread-context');
          context.href = `${url}#discussion_r${thread.rootId}`; context.target = '_blank'; context.rel = 'noopener noreferrer'; group.append(context);
        }
        if (source?.path) group.append(element('code', `${source.path}${source.line ? `:${source.line}` : ''}`, 'pr-thread-path'));
        for (const comment of thread.comments) {
          const row = commentNodes.get(commentKey(comment))!;
          row.entry.dataset.reply = String(comment.kind === 'inline' && comment.id !== thread.rootId); group.append(row.entry);
        }
        const isSeen = thread.comments.every(c => seen[commentKey(c)] && !drafts.get(commentKey(c)));
        (isSeen ? readGroups : unseenGroups).push(group);
      }
      entries.replaceChildren(...unseenGroups); seenEntries.replaceChildren(...readGroups);
      seenSection.hidden = !readGroups.length; seenSummary.textContent = `Seen · ${readGroups.length}`;
      if (focused?.isConnected) { if (focused.getClientRects().length) focused.focus({ preventScroll: true }); else if (!seenSection.hidden) seenSummary.focus({ preventScroll: true }); }
      for (const id of commentNodes.keys()) if (!value.some(c => commentKey(c) === id)) commentNodes.delete(id);
      updateAgents();
      if (!total) entries.append(emptyState(document, 'No comments yet.', { action: { label: 'Open in GitHub', url } }));
      else if (!visible.length) entries.append(emptyState(document, 'No comments match your conversation settings.', { detail: 'Change the filter above or in Settings → Items → GitHub pull request.' }));
      if (value.length > visible.length) entries.append(element('small', `${value.length - visible.length} updates hidden · Change in Settings → Items → GitHub pull request`, 'pr-filter-note'));
      if (total > value.length) { const more = element('a', `Showing the latest ${value.length} of ${total} comments · View all on GitHub`); more.href = url; entries.prepend(more); }
    }
    let related: RelatedResourceItem[] = [], relatedKey = '', offRelated: (() => void) | undefined;
    function renderRelated() {
      const key = JSON.stringify([related, pull?.head.sha, pull?.base.sha]); if (key === relatedKey) return; relatedKey = key;
      const reviews = related.flatMap(item => { const detail = reviewDeskItem(item, resource.id, pull); return detail ? [{ item, detail }] : []; });
      updateAgents();
      relatedEntries.replaceChildren(); sidebar.hidden = !reviews.length; const counts = new Map<string, number>();
      for (const { detail } of reviews) counts.set(detail.state, (counts.get(detail.state) ?? 0) + 1);
      relatedSummary.textContent = `Connected reviews · ${[...counts].map(([state, count]) => `${count} ${state.toLowerCase()}`).join(' · ')}`;
      if (reviews.length) {
        const group = element('section', '', 'pr-connected-reviews'); group.setAttribute('aria-label', 'Connected reviews');

        for (const { item, detail } of reviews) {
          const button = element('button', '', 'pr-linked-review'); button.setAttribute('aria-label', `Open review: ${item.title}`); button.onclick = () => services.openResource(item.nodeId);
          button.dataset.revision = detail.stale ? 'stale' : 'current-or-unknown';
          const label = element('strong', '', 'pr-linked-label'); label.dataset.tint = detail.tint; label.append(reviewGlyph(document), detail.label);
          if (detail.findings) {
            const mix = element('span', '', 'pr-linked-mix');
            for (const entry of detail.findings.mix) { const part = element('span', '', 'pr-linked-kind'); part.dataset.s = entry.key; part.append(findingGlyph(document, entry.key), `${entry.count} ${entry.label}`); mix.append(part); }
            if (!detail.findings.mix.length) mix.append('No findings');
            button.append(label, mix, element('span', detail.findings.progress, 'pr-linked-progress'), element('span', detail.state, 'pr-linked-state'), element('small', detail.revision, 'pr-linked-revision'));
          } else button.append(label, element('span', detail.summary, 'pr-linked-summary'), element('span', detail.state, 'pr-linked-state'), element('small', detail.revision, 'pr-linked-revision'));
          group.append(button);
        }
        relatedEntries.append(group);
      }
    }
    let reviewTimer: ReturnType<typeof setTimeout> | undefined, optionsLoaded = false, reviewEpoch = 0, launchError = '';
    let reviewPoll = false;
    const requests = new Map<string, { requestId: string; model: string; sourceResourceId: string }>(), reviewButtons = new Map<string, HTMLButtonElement>();
    async function pollReviews() {
      if (disposed || !active || reviewPoll) return;
      const epoch = reviewEpoch; reviewPoll = true;
      try {
        const runs = await services.runAction('pr.review.status') as unknown as { requestId: string; provider: string; state: string; error?: string; nodeId?: string }[];
        if (disposed || !active || epoch !== reviewEpoch) return;
        const pending = runs.filter(run => ['queued', 'running', 'outcome-unknown'].includes(run.state));
        const failure = runs.at(-1)?.state === 'failed' ? runs.at(-1) : undefined;
        for (const run of runs) if (['failed', 'cancelled'].includes(run.state) && requests.get(run.provider)?.requestId === run.requestId) requests.delete(run.provider);
        if (runs.some(run => requests.get(run.provider)?.requestId === run.requestId)) launchError = '';
        reviewStatus.textContent = pending.length ? 'Preparing review…' : failure?.error ?? launchError;
        for (const [provider, button] of reviewButtons) button.disabled = pending.some(run => run.provider === provider);
        for (const run of runs) if (run.nodeId && requests.get(run.provider)?.requestId === run.requestId) { requests.delete(run.provider); if (active) services.openResource(run.nodeId); }
      } catch { /* Reconnect on the next bounded poll. */ }
      finally { reviewPoll = false; if (!disposed && active) { clearTimeout(reviewTimer); reviewTimer = setTimeout(() => { void pollReviews(); }, 1500); } }
    }
    async function loadReviewOptions() {
      if (optionsLoaded) return; optionsLoaded = true;
      try {
        const providers = await services.runAction('pr.review.options') as unknown as { provider: string; options: string[]; default?: string; error?: string }[];
        if (disposed) return;
        for (const provider of providers) {
          const label = provider.provider === 'codex' ? 'Codex' : 'Claude', group = element('section', '', 'pr-review-action');
          group.setAttribute('aria-label', `${label} local review`);
          const heading = element('strong', label), controls = element('div', '', 'pr-review-controls');
          const model = element('select'); model.setAttribute('aria-label', `${label} review model`);
          for (const value of provider.options) { const option = element('option', ({ 'gpt-6-astra': 'Astra', opus: 'Opus', fable: 'Fable', sonnet: 'Sonnet', haiku: 'Haiku' } as Record<string, string>)[value] ?? value); option.value = value; model.append(option); }
          if (provider.default) model.value = provider.default;
          const button = element('button', 'Start review'); button.setAttribute('aria-label', `Start ${label} review`); button.disabled = !provider.options.length; if (provider.error) button.title = provider.error;
          if (provider.options.length) reviewButtons.set(provider.provider, button);
          button.onclick = async () => {
            button.disabled = true; launchError = ''; reviewStatus.textContent = 'Preparing review…';
            const request = requests.get(provider.provider) ?? { requestId: crypto.randomUUID(), model: model.value, sourceResourceId: resource.id }; requests.set(provider.provider, request);
            try { await services.runAction(`pr.review.${provider.provider}`, request); void pollReviews(); }
            // Preserve the frozen request on a lost reply: retry must reconcile it,
            // not create a second run with a new identity or changed model.
            catch (error) { launchError = (error as Error).message; reviewStatus.textContent = launchError; button.disabled = false; }
          };
          if (provider.options.length) controls.append(model); controls.append(button);
          group.append(heading, controls, element('small', provider.error || 'Local session · no GitHub post'));
          actions.insertBefore(group, architecture);
        }
      } catch (error) { reviewStatus.textContent = (error as Error).message; optionsLoaded = false; }
    }
    const notify = (message = '') => { error.textContent = message; error.hidden = !message; };
    // A GitHub action's outcome outlasts background reads until the next action or a manual refresh.
    let actionNotice = '', reverted = '';
    function report(message: string) { if (!active || disposed) return; actionNotice = message; notify(message); }
    function overview() {
      if (!pull) return;
      const contentKey = JSON.stringify(pull);
      if (contentKey === renderedPull) return; // Preserve selection and scroll through unchanged background reads.
      renderedPull = contentKey;
      loadingBody.remove();
      author.textContent = `by ${pull.user.login}`;
      refs.textContent = `${pull.base.ref} ← ${pull.head.ref}`;
      commits.textContent = `Commits: ${pull.base.sha.slice(0, 12)} ← ${pull.head.sha.slice(0, 12)}`; commits.title = `${pull.base.sha} ← ${pull.head.sha}`;
      renderMarkdown(description, pull.body || 'No description provided.', { allowHtml: true });
      renderRelated();
    }
    async function display(snapshot: ResourceSnapshot, current: number, savedPreview = false) {
      if (disposed || current !== generation) return;
      pull = snapshot.detail?.pull as unknown as GitHubPullRequest;
      const state = pullHeader(pull, typeof snapshot.detail?.status === 'string' ? snapshot.detail.status : undefined, repository);
      header.update({ status: state.chip && snapshot.pending ? { ...state.chip, pending: true } : state.chip, meta: state.meta, link }); root.dataset.state = String(snapshot.detail?.status ?? pull?.state);
      root.toggleAttribute('data-pending', Boolean(snapshot.pending));
      // A change that was taken back says why once, then stays like any action notice.
      if (snapshot.reverted && snapshot.reverted.requestId !== reverted) { reverted = snapshot.reverted.requestId; actionNotice = snapshot.reverted.message; }
      observedAt = snapshot.observedAt; header.freshness({ observedAt, stale: snapshot.stale, error: snapshot.error, provider: 'GitHub' });
      merge.toggleAttribute('data-primary', state.primary === 'merge'); reviewToggle.toggleAttribute('data-primary', state.primary === 'review');
      // GitHub decides every write; only missing content or an already merged PR keeps Merge from trying.
      const unsure = snapshot.stale || savedPreview ? 'GitHub state may be out of date — GitHub may decline' : '';
      const blocked = !pull ? 'Pull request content is unavailable.' : pull.merged ? 'Already merged' : '';
      const doubt = !pull || pull.merged ? '' : pull.state === 'closed' ? 'Closed — GitHub may decline' : pull.draft ? 'Draft — GitHub may decline'
        : snapshot.detail?.status === 'queued' ? 'Already in the merge queue — GitHub may decline' : unsure;
      if (merge.getAttribute('aria-expanded') !== 'true') merge.disabled = Boolean(blocked);
      if (blocked) { merge.title = blocked; closeMerge?.(); } else merge.title = doubt || 'Merge on GitHub';
      const tag = pull ? titleTag(pull.title).tag : '', untaggable = !pull ? 'Pull request content is unavailable.' : '';
      const tagDoubt = !pull ? '' : pull.merged ? 'Merged — GitHub may decline' : pull.state !== 'open' ? 'Closed — GitHub may decline' : unsure;
      showShip.textContent = tag === 'ship' ? 'Ship' : tag === 'show' ? 'Show' : 'Show/Ship';
      if (showShip.getAttribute('aria-expanded') !== 'true') showShip.disabled = Boolean(untaggable);
      if (untaggable) { showShip.title = untaggable; closeShowShip?.(); } else showShip.title = tagDoubt || (tag ? `Tagged [${tag}] · change the tag on GitHub` : 'Tag the title [show] or [ship] on GitHub');
      const lifecycle = !pull ? undefined : pull.merged ? 'merged' : pull.state === 'closed' ? 'closed' : pull.draft ? 'draft' : 'open';
      const showState = (button: HTMLButtonElement, change: string | undefined, label: string, title: string) => {
        const changed = button.dataset.change !== change;
        button.hidden = !change; button.dataset.change = change ?? ''; button.textContent = label; button.setAttribute('aria-label', label);
        if (button.getAttribute('aria-expanded') !== 'true') button.disabled = !change;
        button.title = unsure || title;
        if ((!change || changed) && button.getAttribute('aria-expanded') === 'true') closeState?.();
      };
      showState(draftToggle, lifecycle === 'draft' ? 'ready' : lifecycle === 'open' ? 'draft' : undefined, lifecycle === 'draft' ? 'Ready for review' : 'Convert to draft',
        lifecycle === 'draft' ? 'Mark ready for review on GitHub' : 'Convert to a draft on GitHub');
      showState(closeToggle, lifecycle === 'closed' ? 'reopen' : lifecycle === 'open' || lifecycle === 'draft' ? 'close' : undefined, lifecycle === 'closed' ? 'Reopen' : 'Close…',
        lifecycle === 'closed' ? 'Reopen the pull request on GitHub' : 'Close the pull request on GitHub, with an optional comment');
      if (!savedPreview) notify(actionNotice || (snapshot.stale ? staleNotice({ observedAt: snapshot.observedAt, error: snapshot.error, provider: 'GitHub' }) : ''));
      if (!pull) throw new Error('Pull request content is unavailable.');
      overview();
      seen = await services.runAction('pr.comments', { operation: 'read', sourceResourceId: resource.id }) as Record<string, boolean>;
      if (disposed || current !== generation) return;
      renderComments(snapshot.detail?.discussion as unknown as PullComment[] | undefined, Number(snapshot.detail?.discussionTotal ?? 0));
    }
    async function load(reload = false) {
      if (disposed) return;
      if (loading) { again = true; return; }
      loading = true;
      const current = ++generation;
      header.busy(true); notify(actionNotice);
      try {
        if (!pull) {
          const saved = await services.runAction('resource.read', { cachedOnly: true }) as unknown as ResourceSnapshot | null;
          if (disposed || current !== generation) return;
          if (saved?.detail?.pull) await display(saved, current, true);
        }
        if (disposed || current !== generation) return;
        let snapshot = await services.runAction('resource.read', { refresh: reload }) as unknown as ResourceSnapshot;
        // Pre-upgrade snapshots contain counts only. Refresh once to populate
        // comments without discarding a saved copy if the provider is offline.
        if (!reload && !snapshot.stale && !snapshot.detail?.discussion && active && !disposed) {
          snapshot = await services.runAction('resource.read', { refresh: true }) as unknown as ResourceSnapshot;
        }
        await display(snapshot, current);
        await readAutoDeploy(); await reviewLoop.read();
      } catch (failure) { if (!disposed && current === generation) { if (pull) { const saved = { observedAt, stale: true, error: (failure as Error).message, provider: 'GitHub' }; header.freshness(saved); notify(actionNotice || staleNotice(saved)); } else { header.update({ status: { label: 'Unavailable', tone: 'red' }, meta: pullHeader(undefined, undefined, repository).meta, link }); loadingBody.remove(); notify((failure as Error).message); } } }
      finally {
        loading = false; if (!disposed && current === generation) header.busy(false);
        if (!disposed && active) { clearTimeout(statusTimer); statusTimer = setTimeout(() => { void load(); }, again ? 0 : 15_000); }
        again = false;
      }
    }
    // The map's saved state of this item changed (a pending change confirmed or taken back, a poll): read the service's copy again.
    let saved = '', again = false;
    return { update(snapshot) { const key = JSON.stringify([snapshot.label, snapshot.indicators]); if (key === saved) return; const first = !saved; saved = key; if (!first && active && !disposed) void load(); }, setActive(value) { if (value === active) return; const entered = value && !active; active = value; offRelated?.(); offRelated = undefined; offPreferences?.(); offPreferences = undefined; if (value) offPreferences = services.observePreferences?.(preferences => { applyTitleTags(preferences); const saved = preferences.pullRequestConversation; if (saved && typeof saved === 'object' && !Array.isArray(saved)) { visibility = { ...DEFAULT_CONVERSATION, ...saved } as typeof visibility; renderComments(latestComments, latestTotal); } }); if (value) offRelated = services.observeRelated?.(items => { related = items; renderRelated(); }); workflowAction.setActive(value); reviewLoop.setActive(value); reviewEpoch++; clearTimeout(reviewTimer); clearTimeout(statusTimer); if (entered) { void load(); void loadReviewOptions(); void pollReviews(); } }, dispose() { explaining?.abort(); closeMerge?.(); closeAutoDeploy?.(); reviewLoop.dispose(); closeShowShip?.(); closeState?.(); header.dispose(); offPreferences?.(); offRelated?.(); workflowAction.dispose(); disposed = true; clearTimeout(reviewTimer); clearTimeout(statusTimer); generation++; root.remove(); } };
  },
};
