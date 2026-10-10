import { useMutation } from "@tanstack/react-query";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { workOnTask } from "../shared/work";
import { lastUsedAgent } from "../shared/agent-selection";

export function useWorkOnTask(workspaceId: string) {
  const paseo = usePaseo();
  const send = useRpc(workOnTask);
  return useMutation({
    retry: false,
    mutationFn: async ({ taskId, expectedRevision }: { taskId: string; expectedRevision: number }) => {
      const agents = [];
      let cursor: string | undefined;
      do {
        const page = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 100, ...(cursor ? { cursor } : {}) } });
        agents.push(...page.entries.map(({ agent }) => agent));
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);
      const agent = lastUsedAgent(agents, workspaceId);
      if (!agent) throw new Error("Open an agent in this workspace before starting a task.");
      if (agent.status !== "idle") throw new Error("The most recently used agent is not idle. Wait for it to finish before starting this task.");
      await send({ workspaceId, agentId: agent.id, taskId, expectedRevision });
      return agent.id;
    },
  });
}
