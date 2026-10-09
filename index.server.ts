import type { PluginServerContext, PluginHandlerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import { getWorkflow, runAction } from "./shared/workflow";
import { assertCurrent, errorMessage, requireReady, WorkflowStore } from "./server/store";
import { startBridge } from "./server/bridge";

export default function contribute(server: PluginServerContext) {
  const directory = process.env.PASEO_WORKFLOW_DATA_DIR ?? join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "workspace-workflow");
  const store = new WorkflowStore(directory);
  const bridge = startBridge(store);
  void bridge.catch(error => console.error("Workflow bridge failed:", errorMessage(error)));

  async function workspaceDirectory(workspaceId: string, { paseo }: PluginHandlerContext) {
    const workspace = await paseo.workspaces.ref(workspaceId).refresh();
    if (!workspace) throw new Error("Workspace is unavailable.");
    return workspace.workspaceDirectory;
  }

  server.handle(getWorkflow, async ({ workspaceId }, context) => {
    try {
      const cwd = await workspaceDirectory(workspaceId, context);
      await bridge;
      return await store.inspect(workspaceId, cwd);
    } catch (error) { return { status: "error" as const, message: errorMessage(error) }; }
  });

  server.handle(runAction, async (input, context) => {
    const cwd = await workspaceDirectory(input.workspaceId, context);
    const agent = context.paseo.agents.ref(input.agentId);
    const commands = await bridge;
    return store.exclusive(input.workspaceId, async () => {
      const current = await agent.refresh();
      if (!current || current.agent.workspaceId !== input.workspaceId) throw new Error("The selected agent is not in this workspace.");
      if (current.agent.status === "running" || current.agent.status === "initializing") throw new Error("Wait for this agent to finish before sending a workflow action.");
      const snapshot = requireReady(await store.read(input.workspaceId, cwd));
      assertCurrent(snapshot, input);
      const action = snapshot.workflow.states[snapshot.state].actions.find(action => action.label === input.action);
      if (!action) throw new Error("This action is no longer available. Refresh the workflow.");
      await agent.send(`${action.prompt}\n\n${commands.instructions(snapshot, cwd)}`);
      return { sent: true as const };
    });
  });

  return async () => { await (await bridge).close(); };
}
