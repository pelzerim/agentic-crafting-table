/** Platform-neutral definitions entry: a type whose id predates the package namespace. */
export default {
  definitions: [{
    id: 'legacy.box', apiVersion: 1, schemaVersion: 1, name: 'Legacy box', icon: 'server',
    preferredView: 'inspector', creation: { label: 'Add legacy box' },
    fields: { boxId: { label: 'Box ID', kind: 'text', required: true } },
    validateData: data => typeof data.boxId === 'string' && data.boxId.length > 0,
  }],
};
