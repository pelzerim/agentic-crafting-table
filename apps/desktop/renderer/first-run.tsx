import { useEffect, useState } from 'react';
import type { WorkspaceCommand, WorkspaceState } from '../../../packages/core/control.ts';
import { isOffMap } from '../../../src/graph/archive.ts';
import type { AgentInstallation } from '../agent-installation.ts';
import { Button } from './ui/button.tsx';

const ACTIVE_KEY = 'craft.firstRun.active';
const PROJECT_KEY = 'craft.firstRun.project';
const TASK_KEY = 'craft.firstRun.task';
const read = (key: string) => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Session-only when storage is unavailable. */ } };
export const readFirstRunActive = (): boolean | undefined => {
  const saved = read(ACTIVE_KEY);
  if (saved) return saved === '1';
  // Respect people who dismissed the checklist before the guided flow existed.
  return read('craft.firstRun.hidden') === '1' ? false : undefined;
};
export const saveFirstRunActive = (active: boolean) => write(ACTIVE_KEY, active ? '1' : '0');

/** A first-run or explicitly reopened guide. It uses ordinary project, note and agent operations. */
export function FirstRunCard({ state, hidden, createProject, editProject, startAgent, openAgent, apply, close }: {
  state: WorkspaceState; hidden: boolean; createProject(): void; editProject(id: string): void;
  startAgent(projectId: string, taskId: string, provider: string): void; openAgent(id: string): void;
  apply(commands: WorkspaceCommand[]): Promise<unknown>; close(): void;
}) {
  const projects = state.nodes.filter(node => !node.resourceId && !node.projectId && !isOffMap(node, state.nodes));
  const [projectId, setProjectId] = useState(() => read(PROJECT_KEY));
  const project = projects.find(node => node.id === projectId) ?? projects[0];
  const [taskId, setTaskId] = useState(() => read(TASK_KEY));
  const task = state.nodes.find(node => node.id === taskId && node.projectId === project?.id && !isOffMap(node, state.nodes));
  const [text, setText] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState('');
  const [agents, setAgents] = useState<AgentInstallation[]>(), [checking, setChecking] = useState(true), [checkError, setCheckError] = useState('');
  const [provider, setProvider] = useState('claude');
  const check = async () => {
    setChecking(true); setCheckError('');
    try {
      const found = await window.craftingTable.agentInstallation(); setAgents(found);
      setProvider(current => found.some(agent => agent.id === current && agent.installed) ? current : found.find(agent => agent.installed)?.id ?? current);
    } catch { setCheckError('Could not check installed agents. Try again.'); }
    finally { setChecking(false); }
  };
  useEffect(() => { void check(); }, []);
  useEffect(() => { if (project) { setProjectId(project.id); write(PROJECT_KEY, project.id); } }, [project?.id]);
  const agent = task && state.nodes.find(node => node.projectId === project?.id && !isOffMap(node, state.nodes)
    && state.resources.some(resource => resource.id === node.resourceId && resource.pluginId === 'agent.session')
    && state.links.some(link => link.kind === 'context' && link.sourceId === task.id && link.targetId === node.id));
  const ready = !checking && !checkError && agents?.some(agent => agent.id === provider && agent.installed);
  const saveTask = async () => {
    if (!project || !text.trim() || pending) return;
    setPending(true); setError('');
    const id = crypto.randomUUID();
    try {
      await apply([{ type: 'item.add', id, resourceId: crypto.randomUUID(), pluginId: 'workspace.note', title: 'First task',
        projectId: project.id, position: { x: project.position.x + 260, y: project.position.y }, data: { text: text.trim(), display: 'note' } }]);
      setTaskId(id); write(TASK_KEY, id);
    } catch (failure) { setError((failure as Error).message); }
    finally { setPending(false); }
  };
  return <section className="first-run-card" aria-label="Get started" data-docked hidden={hidden} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
    <header><span className="eyebrow">YOUR FIRST SESSION</span><h2>Give an agent a place to work.</h2><p>A project, a task, and an agent linked together. GitHub and Linear can wait.</p></header>
    <ol>
      <li data-done={Boolean(project?.workingDirectory)}><strong>1. Choose a project</strong>
        {projects.length > 0 && <label>Project<select aria-label="Guide project" value={project?.id} onChange={event => setProjectId(event.target.value)}>{projects.map(node => <option key={node.id} value={node.id}>{node.title}</option>)}</select></label>}
        {!project ? <Button onClick={createProject}>Create your first project</Button> : <><p>{project.workingDirectory ? 'Agents will use this project’s folder.' : 'Choose the local repository folder where the agent should work.'}</p><Button size="sm" onClick={() => editProject(project.id)}>{project.workingDirectory ? 'Change project folder' : 'Choose project folder'}</Button></>}
      </li>
      {project?.workingDirectory && <>
        <li data-done={Boolean(task)}><strong>2. Give it a task</strong>
          {task ? <p>Task saved. It will be linked as context to your agent.</p> : <><label>First task<textarea aria-label="First task" rows={3} maxLength={4000} value={text} disabled={pending} onChange={event => setText(event.target.value)} placeholder="For example: explain how retries work here and suggest one improvement." /></label><Button size="sm" disabled={pending || !text.trim()} onClick={() => void saveTask()}>{pending ? 'Saving task…' : 'Save task on map'}</Button></>}
        </li>
        <li data-done={Boolean(agent)}><strong>3. Start an agent</strong>
          {agent ? <><p>Your task and agent are connected. Open the session, read its suggestions, and tell it what to do. Needs me will show when it is waiting for you.</p><Button variant="primary" onClick={() => { openAgent(agent.id); close(); }}>Open my first session</Button></> : <>
            <div role="status">{checking ? 'Checking installed agents…' : agents?.map(agent => `${agent.name}: ${agent.installed ? 'CLI found' : 'CLI not found'}`).join(' · ')}</div>
            {checkError && <p role="alert">{checkError}</p>}
            {!checking && <Button size="sm" onClick={() => void check()}>Check again</Button>}
            <p>Checks installation only. Sign in using the CLI in your terminal before starting.</p>
            {!checking && !agents?.some(agent => agent.installed) && <p>Install Claude Code or Codex, then choose Check again. You can keep your project and task while you set up.</p>}
            <label>Agent<select aria-label="Guide agent" value={provider} onChange={event => setProvider(event.target.value)}><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
            <Button variant="primary" disabled={!task || !ready} onClick={() => task && startAgent(project.id, task.id, provider)}>Review and start session</Button>
            <p>Choose the model in the next form. Once it opens, tell the agent when to begin.</p>
          </>}
        </li>
      </>}
    </ol>
    {error && <p role="alert">{error}</p>}
    <footer><span>Reopen from Settings / General / Get started.</span><Button variant="quiet" size="sm" onClick={close}>Hide</Button></footer>
  </section>;
}
