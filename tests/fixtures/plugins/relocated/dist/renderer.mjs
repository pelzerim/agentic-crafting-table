/** Window entry of the relocated package. */
export default {
  activate(host) {
    host.views('legacy.box', {
      mountDetail(container, resource) {
        const text = container.ownerDocument.createElement('p');
        text.className = 'legacy-box-text';
        text.textContent = `Box ${resource.data.boxId ?? ''}`;
        container.append(text);
        return { update() {}, dispose() { text.remove(); } };
      },
    });
  },
};
