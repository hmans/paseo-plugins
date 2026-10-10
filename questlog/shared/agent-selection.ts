type Agent = {
  id: string; workspaceId?: string | null; archivedAt?: string | null;
  lastUserMessageAt: string | null; createdAt: string;
};

// The public SDK has no tab-focus history. Prefer the last conversation the user
// sent a message to, rather than updatedAt (which includes background activity).
export function lastUsedAgent<T extends Agent>(agents: T[], workspaceId: string): T | undefined {
  const candidates = agents.filter(agent => agent.workspaceId === workspaceId && !agent.archivedAt);
  const timestamp = (value: string | null) => value ? Date.parse(value) || 0 : 0;
  return candidates.sort((a, b) =>
    timestamp(b.lastUserMessageAt) - timestamp(a.lastUserMessageAt)
    || timestamp(b.createdAt) - timestamp(a.createdAt)
    || a.id.localeCompare(b.id))[0];
}
