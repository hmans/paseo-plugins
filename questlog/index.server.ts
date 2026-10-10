import type { PluginServerContext, PluginHandlerContext } from "@getpaseo/plugin/server";
import { taskDirectory } from "./server/directory";
import { getOutline, changeOutline } from "./shared/tasks";
import { message, TaskStore } from "./server/store";
import { startTaskMcp } from "./server/mcp";
import { registerMcpInjection } from "./server/injection";
import { workOnTask } from "./shared/work";
import { taskDispatcher } from "./server/work";

export default function contribute(server: PluginServerContext) {
  const directory = taskDirectory();
  const store = new TaskStore(directory);
  const mcp = startTaskMcp(store);
  void mcp.catch(error => console.error("Questlog MCP failed:", message(error)));
  registerMcpInjection(server, mcp);
  server.handle(workOnTask, taskDispatcher(store, async () => (await mcp).bindings));
  async function requireWorkspace(workspaceId: string, { paseo }: PluginHandlerContext) {
    if (!await paseo.workspaces.ref(workspaceId).refresh()) throw new Error("Workspace is unavailable.");
  }
  server.handle(getOutline, async ({ workspaceId }, context) => {
    await requireWorkspace(workspaceId, context);
    return store.read(workspaceId);
  });
  server.handle(changeOutline, async ({ workspaceId, expectedRevision, action }, context) => {
    await requireWorkspace(workspaceId, context);
    return store.change(workspaceId, expectedRevision, action);
  });
  return async () => { await (await mcp.catch(() => null))?.close(); };
}
