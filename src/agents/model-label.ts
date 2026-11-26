/** Presentation only: the stored IDs never change. A Claude ID such as `claude-opus-5-5` (or one with a
 * release date) reads as `opus 5.5`; anything else stays as the CLI names it. */
export function shortModelName(id: string) {
  const claude = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[[^\]]+\])?$/);
  if (!claude) return id;
  const [, family, major, minor, variant] = claude;
  return [family, minor ? `${major}.${minor}` : major, variant].filter(Boolean).join(' ');
}

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** The provider, model and effort an agent session runs on now (AGENT-04b). `currentModel` and `currentEffort` are what
 * the CLI last reported; before it reports, the model chosen at launch stands in. `native` launched no model of its own. */
export function agentModelLabel(data: Record<string, unknown>) {
  const current = text(data.currentModel), launched = text(data.model);
  const model = current ? shortModelName(current) : launched !== 'native' ? launched : undefined;
  return [text(data.provider), [model, text(data.currentEffort)].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
}
