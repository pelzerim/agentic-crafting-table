import type { JsonObject, ResourceFields } from '../../types.ts';
import { fieldDefaults } from '../../define.ts';

const PACKAGE_ID = 'workspace.text';

export const textFileSettingFields = {
  saveAutomatically: { label: 'Save automatically', kind: 'boolean', default: true,
    description: 'Edits are saved a moment after typing stops and when the item closes, over a change on disk too. Off: only ⌘S saves, and closing an item with unsaved edits asks first.' },
} satisfies ResourceFields;

const object = (value: unknown): JsonObject | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;

/** The text file settings out of the app's settings; a setting no one saved has its field's default. */
export function textFileSettings(preferences: JsonObject) {
  const values = fieldDefaults(textFileSettingFields, undefined, object(object(preferences.plugins)?.[PACKAGE_ID]) ?? {});
  return { saveAutomatically: values.saveAutomatically === true };
}
