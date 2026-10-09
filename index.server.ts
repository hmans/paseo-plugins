import type { PluginServerContext, PluginHandlerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import { getWorkflow, runAction, setCommandTrust, workflowActions } from "./shared/workflow";
import { Conditions } from "./server/conditions";
import { assertCurrent, errorMessage, requireReady, WorkflowStore } from "./server/store";
import { startWorkflowMcp } from "./server/mcp";
import { registerMcpInjection } from "./server/injection";
import { operationHandlers } from "./server/operations";

export default function contribute(server: PluginServerContext) {
  const directory = process.env.PASEO_WORKFLOW_DATA_DIR ?? join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "workspace-workflow");
  const store = new WorkflowStore(directory);
  const conditions = new Conditions(directory);
  const mcp = startWorkflowMcp(store);
  void mcp.catch(error => console.error("Workflow MCP failed:", errorMessage(error)));
  registerMcpInjection(server, mcp);

  async function workspaceDirectory(workspaceId: string, { paseo }: PluginHandlerContext) {
    const workspace = await paseo.workspaces.ref(workspaceId).refresh();
    if (!workspace) throw new Error("Workspace is unavailable.");
    return workspace.workspaceDirectory;
  }

  function readPullRequestMerged(workspaceId: string, { paseo }: PluginHandlerContext) {
    return async () => {
      const workspace = await paseo.workspaces.ref(workspaceId).refresh();
      if (!workspace) throw new Error("Workspace is unavailable.");
      return workspace.githubRuntime?.pullRequest?.isMerged === true;
    };
  }

  server.handle(getWorkflow, async ({ workspaceId, agentId }, context) => {
    try {
      const cwd = await workspaceDirectory(workspaceId, context);
      const service = await mcp.catch(() => null);
      const snapshot = await store.inspect(workspaceId, cwd);
      return snapshot.status === "ready"
        ? { ...snapshot, ...await conditions.results(snapshot, cwd, false, undefined, readPullRequestMerged(workspaceId, context)), toolsReady: agentId ? service?.bindings.hasAgent(agentId, workspaceId) ?? false : undefined }
        : snapshot;
    } catch (error) { return { status: "error" as const, message: errorMessage(error) }; }
  });

  server.handle(setCommandTrust, async (input, context) => {
    const cwd = await workspaceDirectory(input.workspaceId, context);
    return store.exclusive(input.workspaceId, async () => {
      const snapshot = requireReady(await store.read(input.workspaceId, cwd));
      if (snapshot.definitionVersion !== input.definitionVersion) throw new Error("Workflow changed. Review the commands again before trusting them.");
      await conditions.trust(snapshot, cwd, input.trusted);
      return { saved: true as const };
    });
  });

  server.handle(runAction, async (input, context) => {
    const cwd = await workspaceDirectory(input.workspaceId, context);
    const agent = context.paseo.agents.ref(input.agentId);
    return store.exclusive(input.workspaceId, async () => {
      const current = await agent.refresh();
      if (!current || current.agent.workspaceId !== input.workspaceId) throw new Error("The selected agent is not in this workspace.");
      if (current.agent.status === "running" || current.agent.status === "initializing") throw new Error("Wait for this agent to finish before sending a workflow action.");
      const snapshot = requireReady(await store.read(input.workspaceId, cwd));
      assertCurrent(snapshot, input);
      const action = workflowActions(snapshot.workflow, snapshot.state).find(action => action.label === input.action);
      if (!action) throw new Error("This action is no longer available. Refresh the workflow.");
      if ("prompt" in action && !(await mcp).bindings.hasAgent(input.agentId, input.workspaceId)) throw new Error("Create a new agent in this workspace to load the workflow MCP tools. Existing agents cannot receive the injected configuration.");
      const result = (await conditions.results(snapshot, cwd, true, action.label, readPullRequestMerged(input.workspaceId, context))).actionConditions[action.label];
      if (result.value !== "true") throw new Error(result.message ?? "This action's condition is no longer met.");
      // A command can take time or change the workflow file itself.
      assertCurrent(requireReady(await store.read(input.workspaceId, cwd)), input);
      const latest = await agent.refresh();
      if (!latest || latest.agent.workspaceId !== input.workspaceId) throw new Error("The selected agent is not in this workspace.");
      if (latest.agent.status === "running" || latest.agent.status === "initializing") throw new Error("Wait for this agent to finish before sending a workflow action.");
      if ("operation" in action) {
        await operationHandlers[action.operation](input.workspaceId, context);
        return { executed: true as const };
      }
      await agent.send(action.prompt);
      return { sent: true as const };
    });
  });

  return async () => { await conditions.close(); await (await mcp).close(); };
}
