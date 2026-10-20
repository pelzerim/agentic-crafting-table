/** A provider-free item type that connects to one item only, with three map sizes. */
import { defineResourcePlugin } from '../../src/resource-plugins/define.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';

export const singlePartner = defineResourcePlugin({
  id: 'fixture.device', apiVersion: 1, schemaVersion: 1,
  name: 'Device', icon: 'server', preferredView: 'inspector',
  mapSizes: { defaultSize: 'medium', sizes: {
    small: { width: 48, height: 48, summaryLines: 0, iconOnly: true, description: 'Device badge.' },
    medium: { width: 220, height: 84, summaryLines: 1, description: 'Device name and state.' },
    large: { width: 280, height: 112, summaryLines: 2, description: 'Device name with more detail.' },
  } },
  appearance: { tone: 'blue', shape: 'server', size: 'medium', width: 220 },
  relationships: { cardinality: 'one' },
  fields: { deviceId: { label: 'Device ID', kind: 'text', required: true } },
  creation: { label: 'Add device' },
});

/** The bundled registry plus `singlePartner`. */
export const registryWithSinglePartner = () => createResourcePluginRegistry([singlePartner]);
