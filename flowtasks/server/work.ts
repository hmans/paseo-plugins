import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import { taskPrompt, workOnTask } from "../shared/work";
import type { TaskStore } from "./store";
import type { WorkspaceBindings } from "./bindings";

export function taskDispatcher(store: TaskStore, bindings: () => Promise<Pick<WorkspaceBindings, "hasAgent">>) {
  const sending = new Set<string>();
  return async (input: RpcInput<typeof workOnTask>, { paseo }: PluginHandlerContext) => {
    if (sending.has(input.agentId)) throw new Error("A task is already being sent to this agent.");
    sending.add(input.agentId);
    try {
      const workspace = await paseo.workspaces.ref(input.workspaceId).refresh();
      if (!workspace) throw new Error("Workspace is unavailable.");
      if (!(await bindings()).hasAgent(input.agentId, input.workspaceId)) throw new Error("Create a new agent in this workspace to load the Flowtasks tools.");
      const agent = paseo.agents.ref(input.agentId);
      return await store.exclusive(`outline:${input.workspaceId}`, async () => {
        const current = await agent.refresh();
        if (!current || current.agent.workspaceId !== input.workspaceId || current.agent.archivedAt) throw new Error("The selected agent is no longer available in this workspace.");
        if (current.agent.status !== "idle") throw new Error("Choose an idle agent before starting this task.");
        const outline = await store.read(input.workspaceId);
        if (outline.revision !== input.expectedRevision) throw new Error("The tasks changed. Review the outline and try again.");
        await agent.send(taskPrompt(outline, input.taskId));
        return { sent: true as const };
      });
    } finally { sending.delete(input.agentId); }
  };
}
