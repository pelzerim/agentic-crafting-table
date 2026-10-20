/** Node entry of the sample package: a local connector and one runtime operation. */
export default {
  activate(host) {
    host.connector('sample.card', {
      async load(resource) {
        return { activity: 'idle', attention: 'none', connection: 'connected', label: 'Sample card', observedAt: new Date().toISOString(), detail: { text: String(resource.data.text ?? '') } };
      },
    });
    host.runtimeOperation('sample.echo', context => ({ echo: context.arguments, plugin: host.pluginId }));
  },
};
