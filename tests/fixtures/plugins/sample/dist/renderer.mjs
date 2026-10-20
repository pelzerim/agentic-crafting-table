/** Window entry of the sample package. */
export default {
  activate(host) {
    host.views('sample.card', {
      mountDetail(container, resource) {
        const text = container.ownerDocument.createElement('p');
        text.className = 'sample-card-text';
        text.textContent = `Sample says: ${resource.data.text ?? ''}`;
        container.append(text);
        return { update() {}, dispose() { text.remove(); } };
      },
    });
  },
};
