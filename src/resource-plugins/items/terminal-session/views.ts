import type { ResourcePluginViews } from '../../types.ts';

export const terminalViews: ResourcePluginViews = {
  identity: resource => String(resource.data.sessionId),
  mountDetail(container, resource, services) {
    let requestId: string | undefined;
    const terminal = services.attachTerminal(String(resource.data.sessionId), container, {
      resumeLabel: 'New shell', resumeWhenStopped: true, startWhenStopped: true,
      resume: async () => {
        requestId ??= crypto.randomUUID();
        try { await services.runAction('terminal.start', { requestId }); requestId = undefined; }
        catch (error) {
          if (['REVISION_CONFLICT', 'INVALID_REQUEST', 'LAUNCH_FAILED'].includes((error as { code: string }).code)) requestId = undefined;
          throw error;
        }
      },
    });
    return { update() {}, setActive: active => terminal.setActive?.(active), dispose: () => terminal.dispose() };
  },
};
