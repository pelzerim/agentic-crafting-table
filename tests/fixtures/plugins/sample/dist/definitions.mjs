/** Platform-neutral definitions entry of the sample package. */
const fields = { text: { label: 'Text', kind: 'text', required: true } };
const validText = data => typeof data.text === 'string' && data.text.trim().length > 0;

export default {
  definitions: [{
    id: 'sample.card', apiVersion: 1, schemaVersion: 1, name: 'Sample card', icon: 'note',
    preferredView: 'inspector', creation: { label: 'Add sample card' }, fields,
    validateData: validText,
  }],
  runtimeOperations: [{ id: 'sample.echo', description: 'Returns its arguments.', agentPolicy: 'humanOnly' }],
  agentGuide: [{ id: 'sample.guide', text: 'Sample cards hold one line of text.' }],
};
