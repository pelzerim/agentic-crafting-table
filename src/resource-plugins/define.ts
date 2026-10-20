import type { JsonObject, ResourceFields, ResourcePluginDefinition } from './types.ts';

/** Copy defaults once when creating a draft/launch; never overwrite explicit input. */
export function fieldDefaults(fields: ResourceFields = {}, project?: { workingDirectory?: string }, input: JsonObject = {}): JsonObject {
  const data = { ...input };
  for (const [key, field] of Object.entries(fields)) {
    if (data[key] !== undefined) continue;
    const value = (field.fromProject ? project?.[field.fromProject] || undefined : undefined) ?? field.default;
    if (value !== undefined) data[key] = typeof value === 'object' ? [...value] : value;
  }
  return data;
}

/** The owning creator resolves inherited fields when freezing its launch, not
 * during transport validation: a retry must not read a new project directory. */
export function validateCreationFields(fields: ResourceFields, data: JsonObject): boolean {
  return validateFields(Object.fromEntries(Object.entries(fields).map(([key, field]) =>
    [key, field.fromProject && data[key] === undefined ? { ...field, required: false } : field])), data);
}

/** A small declarative form vocabulary, not an arbitrary schema execution engine. */
export function validateFields(fields: ResourceFields, data: JsonObject): boolean {
  return Object.entries(fields).every(([key, field]) => {
    const value = Object.hasOwn(data, key) ? data[key] : undefined;
    if (value === undefined) return !field.required;
    if (field.kind === 'boolean') return typeof value === 'boolean';
    if (field.kind === 'multiselect') return Array.isArray(value) && new Set(value).size === value.length
      && value.every(entry => typeof entry === 'string' && field.options?.includes(entry));
    if (field.kind === 'number') return typeof value === 'number' && Number.isFinite(value)
      && (!field.integer || Number.isSafeInteger(value))
      && (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max);
    if (typeof value !== 'string' || (field.required && !value.trim())) return false;
    if (field.kind === 'select' && !field.optionsSource && !field.options?.includes(value)) return false;
    if (field.pattern && !new RegExp(field.pattern).test(value)) return false;
    if (field.kind === 'url' && value) {
      try { if (!['https:', 'http:'].includes(new URL(value).protocol)) return false; }
      catch { return false; }
    }
    return true;
  });
}

/** JSON Schema is data, so neither UI nor MCP needs provider branches. */
export function fieldsSchema(fields: ResourceFields): JsonObject {
  return {
    type: 'object', additionalProperties: true,
    required: Object.entries(fields).filter(([, f]) => f.required).map(([key]) => key),
    properties: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, {
      type: field.kind === 'number' ? field.integer ? 'integer' : 'number' : field.kind === 'boolean' ? 'boolean' : field.kind === 'multiselect' ? 'array' : 'string',
      title: field.label,
      ...(field.kind === 'multiselect' ? { items: { type: 'string', enum: [...field.options ?? []] }, uniqueItems: true } : {}),
      ...(field.description ? { description: field.description } : {}),
      ...(field.kind === 'select' && !field.optionsSource ? { enum: [...field.options!] } : {}),
      ...(field.kind === 'url' ? { format: 'uri', pattern: '^https?://' } : {}),
      ...(field.required && ['text', 'url', 'select'].includes(field.kind) ? { minLength: 1 } : {}),
      ...(field.pattern ? { pattern: field.pattern } : {}),
      ...(field.min !== undefined ? { minimum: field.min } : {}),
      ...(field.max !== undefined ? { maximum: field.max } : {}),
    }])),
  };
}

export function defineResourcePlugin(
  definition: Omit<ResourcePluginDefinition, 'validateData' | 'fields'> & {
    fields: ResourceFields;
    validateData?: ResourcePluginDefinition['validateData'];
  },
): ResourcePluginDefinition {
  const { validateData, ...metadata } = definition;
  for (const field of Object.values(definition.fields)) {
    if (field.kind === 'multiselect') throw new Error('Multiselect fields are for settings sections');
    if (field.kind === 'select' && !field.optionsSource && !field.options?.length) throw new Error('Select fields need options');
    if (field.pattern) new RegExp(field.pattern);
  }
  return { ...metadata, validateData: data => validateFields(definition.fields, data) && (!validateData || validateData(data)) };
}

/** Fills a plugin's web link template from item data. Every part must be a present,
 * non-empty string or number and is encoded, except a template that is a single field,
 * which holds a whole URL. The result must stay an https URL. */
export function webLinkUrl(template: string | readonly string[], data: JsonObject): string | undefined {
  if (typeof template !== 'string') return template.map(each => webLinkUrl(each, data)).find(Boolean);
  let missing = false;
  const whole = /^\{[A-Za-z]\w*\}$/.test(template);
  const url = template.replace(/\{([A-Za-z][\w]*)\}/g, (_, field: string) => {
    const value = data[field];
    if ((typeof value !== 'string' || !value) && typeof value !== 'number') { missing = true; return ''; }
    return whole ? String(value) : encodeURIComponent(String(value));
  });
  if (missing) return undefined;
  try { return new URL(url).protocol === 'https:' ? url : undefined; } catch { return undefined; }
}
