import { stateSchema } from '../../packages/core/control.ts';

/** Static provider records only: no credentials, processes or external calls. */
export function denseMap(itemCount: 200 | 500) {
  const nodes: Record<string, unknown>[] = [], resources: Record<string, unknown>[] = [], links: Record<string, unknown>[] = [];
  const members = itemCount / 10, rows = members / 5;
  for (let project = 0; project < 10; project++) {
    const projectId = `project-${project}`, origin = { x: (project % 5) * 1560, y: Math.floor(project / 5) * (rows * 150 + 500) };
    nodes.push({ id: projectId, title: `Project ${project + 1}`, position: origin });
    for (let member = 0; member < members; member++) {
      const index = project * members + member, id = `item-${index}`, title = `Work ${index + 1}`;
      const kind = [
        { pluginId: 'agent.session', data: { sessionId: `static-agent-${index}`, provider: 'claude' } },
        { pluginId: 'github.pull-request', data: { owner: 'fixture', repo: 'dense-map', number: index + 1 } },
        { pluginId: 'linear.ticket', data: { issueId: `DENSE-${index + 1}` } },
        { pluginId: 'notion.page', data: { pageId: index.toString(16).padStart(32, '0') } },
        // Preserved records must remain fast/renderable when their optional plugin is absent.
        { pluginId: 'fixture.optional-resource', data: {} },
        { pluginId: 'workspace.todo', data: { completed: false } },
      ][index % 6];
      resources.push({ id: id + '-resource', schemaVersion: 1, title, ...kind });
      nodes.push({ id, title, resourceId: id + '-resource', projectId, position: { x: origin.x + member % 5 * 280, y: origin.y + Math.floor(member / 5) * 150 },
        summary: 'Fixture activity', activity: index % 6 === 0 ? 'working' : 'idle', attention: index % 17 === 0 ? 'input' : 'none', acceptsContext: index % 6 === 0 });
    }
    let count = 0;
    for (const offset of [1, 2, 3]) for (let member = 0; member < members && count < members * 2.5; member++) {
      const source = project * members + member, target = project * members + (member + offset) % members;
      links.push({ id: `edge-${project}-${count++}`, sourceId: `item-${source}`, targetId: `item-${target}`, kind: 'reference' });
    }
  }
  return stateSchema.parse({ version: 1, revision: 0, nodes, resources, links, todos: [], view: {} });
}
