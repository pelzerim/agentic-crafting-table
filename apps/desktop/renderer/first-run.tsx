import { useState } from 'react';
import type { WorkspaceState } from '../../../packages/core/control.ts';
import type { ProviderConnection } from '../../../packages/core/connections.ts';
import { Button } from './ui/button.tsx';
import { PixelGlyph } from './ui/pixel-glyph.tsx';

const HIDDEN_KEY = 'craft.firstRun.hidden';
const readHidden = () => { try { return localStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; } };

/** The product's core loop as a checklist. Shown while the map holds no items
 * (projects only); a finished step collapses to one line. */
export function FirstRunCard({ state, connections, docked, openConnections }: {
  state: WorkspaceState; connections: readonly ProviderConnection[]; docked: boolean; openConnections(): void;
}) {
  const [hidden, setHidden] = useState(readHidden);
  const project = state.nodes.find(node => !node.resourceId);
  const connected = connections.filter(connection => (connection.providerId === 'github' || connection.providerId === 'linear') && connection.enabled);
  const agent = state.resources.some(resource => resource.pluginId === 'agent.session');
  const steps = [
    { name: 'Create a project', done: Boolean(project), meta: project?.title, hint: 'A project gathers the items and agents for one piece of work.' },
    { name: 'Connect GitHub or Linear', done: connected.length > 0, meta: connected.map(connection => connection.account).join(', '), hint: 'Pull requests and tickets appear as items you can open here.', action: { label: 'Connect…', run: openConnections } },
    { name: 'Start an agent', done: agent, hint: 'Double-click inside a project and choose Agent.' },
  ];
  const done = steps.filter(step => step.done).length;
  if (hidden || done === steps.length) return null;
  const hide = () => { setHidden(true); try { localStorage.setItem(HIDDEN_KEY, '1'); } catch { /* the card simply returns next launch */ } };
  return <section className="first-run-card" aria-label="Get started" data-docked={docked || undefined}>
    <ol>{steps.map(step => <li key={step.name} data-done={step.done}>
      <span className="first-run-check" aria-hidden="true">{step.done && <PixelGlyph name="check" />}</span>
      <span className="first-run-name">{step.name}{step.done && <span className="first-run-state">, done</span>}</span>
      {step.done ? step.meta && <small>{step.meta}</small> : 'action' in step && step.action && <Button variant="primary" size="sm" onClick={step.action.run}>{step.action.label}</Button>}
      {!step.done && <p>{step.hint}</p>}
    </li>)}</ol>
    <footer><span>{done} of {steps.length} done · steps collapse as you go</span><Button variant="quiet" size="sm" className="first-run-hide" onClick={hide}>Hide</Button></footer>
  </section>;
}
