import { useMutation, useQuery } from "@tanstack/react-query";
import { useAgent, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { workOnTask } from "../shared/work";
import { lastUsedAgent } from "../shared/agent-selection";

export function useWorkOnTask(workspaceId: string) {
  const paseo = usePaseo();
  const send = useRpc(workOnTask);
  async function getTarget() {
    const agents = [];
    let cursor: string | undefined;
    do {
      const page = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 100, ...(cursor ? { cursor } : {}) } });
      agents.push(...page.entries.map(({ agent }) => agent));
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return lastUsedAgent(agents, workspaceId) ?? null;
  }
  const target = useQuery({
    queryKey: ["flowtasks-target-agent", workspaceId], queryFn: getTarget,
    refetchInterval: 2000, retry: false,
  });
  const status = useAgent(target.data?.id ?? "", agent => agent.status);
  const mutation = useMutation({
    retry: false,
    mutationFn: async ({ taskId, expectedRevision }: { taskId: string; expectedRevision: number }) => {
      const agent = await getTarget();
      if (!agent) throw new Error("Open an agent in this workspace before starting a task.");
      // The agent can become busy between rendering the button and clicking it.
      if (agent.status !== "idle") return null;
      await send({ workspaceId, agentId: agent.id, taskId, expectedRevision });
      return agent.id;
    },
    onSettled: () => { void target.refetch(); },
  });
  return { ...mutation, canWork: !target.isError && !!target.data && (status ?? target.data.status) === "idle" };
}
