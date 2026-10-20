import { defineResourcePlugin } from '../../define.ts';
import { defaultArtifactTitle, parseClaudeArtifactUrl } from './url.ts';

export const claudeArtifact = defineResourcePlugin({
  settingsHelp: 'Keep a private Claude artifact, such as an architecture overview or flow diagram, next to the work it explains. Add its claude.ai link with From URL; agents on the table add the ones they publish. The page opens in your browser, where you are signed in to Claude.',
  id: 'claude.artifact', apiVersion: 1, schemaVersion: 2,
  name: 'Claude artifact', icon: 'workflow', preferredView: 'focus',
  context: { parentField: 'sourcePrId', fields: ['headSha', 'artifactId', 'url'] },
  view: { width: 460, height: 300 },
  webLink: { label: 'Open on claude.ai', template: '{url}' },
  mapSizes: { defaultSize: 'small', sizes: {
    small: { width: 150, height: 48, summaryLines: 0, description: "Artifact title and progress/attention." },
    medium: { width: 240, height: 96, summaryLines: 2, description: "Title and saved generation status/summary." },
  } },
  appearance: { tone: 'copper', shape: 'artifact', size: 'small' },
  creation: { label: 'Add Claude artifact', shortLabel: 'Artifact', action: 'resource.attach', mode: 'url', urlPlaceholder: 'https://claude.ai/code/artifact/…' },
  // Records saved before the URL existed carry only the artifact id and provenance.
  providerIdentity: data => {
    const parsed = parseClaudeArtifactUrl(data.url);
    return parsed ? `${parsed.kind}:${parsed.id}` : undefined;
  },
  matchInput(input) {
    const parsed = parseClaudeArtifactUrl(input);
    return parsed ? { title: defaultArtifactTitle(parsed.id), data: { url: parsed.url, artifactId: parsed.id } } : undefined;
  },
  validateData: data => data.url === undefined || parseClaudeArtifactUrl(data.url)?.id === data.artifactId,
  migrations: [{ fromVersion: 1, toVersion: 2, migrate: data => data }],
  fields: {
    url: { label: 'Artifact URL', kind: 'url' },
    artifactId: { label: 'Artifact ID', kind: 'text', required: true },
    sourcePrId: { label: 'Source PR ID', kind: 'text' },
    headSha: { label: 'Head revision', kind: 'text' },
    sessionId: { label: 'Session ID', kind: 'text' },
  },
});
