import type { AgentPromptStatus, ResourcePluginViews } from '../../types.ts';

export const agentViews: ResourcePluginViews = {
  identity: resource => String(resource.data.sessionId),
  mountDetail(container, resource, services) {
    let requestId: string | undefined, promptRequestId: string | undefined;
    const terminal = services.attachTerminal(String(resource.data.sessionId), container, {
      launchLabel: [resource.data.provider, resource.data.model].filter(Boolean).join(' · '),
      agentMenu: true, nativePaste: resource.data.provider === 'codex', selectionCut: resource.data.provider === 'claude' ? 'end-included' : 'end-excluded', agentName: ({ claude: 'Claude', codex: 'Codex' } as Record<string, string>)[String(resource.data.provider)],
      prompt: resource.data.provider === 'claude' ? async operation => {
        if (operation === 'queue') promptRequestId ??= crypto.randomUUID();
        const status = await services.runAction('agent.context.inject', { operation, sessionId: String(resource.data.sessionId), ...(operation === 'queue' ? { requestId: promptRequestId! } : {}) }) as unknown as AgentPromptStatus;
        if (operation === 'queue') promptRequestId = undefined;
        return status;
      } : undefined,
      resume: async () => {
        requestId ??= crypto.randomUUID();
        try { await services.runAction('agent.resume', { requestId }); requestId = undefined; }
        catch (error) {
          if (['REVISION_CONFLICT', 'INVALID_REQUEST', 'LAUNCH_FAILED'].includes((error as { code: string }).code)) requestId = undefined;
          throw error;
        }
      },
    });
    return { update() {}, setActive: active => terminal.setActive?.(active), dispose() { terminal.dispose(); } };
  },
};
