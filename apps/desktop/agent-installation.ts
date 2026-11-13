/** Discovery only: never starts a CLI or claims that its account is signed in. */
export interface AgentInstallation { id: 'claude' | 'codex'; name: string; installed: boolean }
export function agentInstallation(claude: () => string | undefined, codex: () => string | undefined): AgentInstallation[] {
  return [{ id: 'claude', name: 'Claude', installed: Boolean(claude()) }, { id: 'codex', name: 'Codex', installed: Boolean(codex()) }];
}
