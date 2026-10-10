import type { PluginServerContext, PluginHandlerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import { getOutline, changeOutline } from "./shared/tasks";
import { message, TaskStore } from "./server/store";
import { startTaskMcp } from "./server/mcp";
import { registerMcpInjection } from "./server/injection";

export default function contribute(server: PluginServerContext) {
  const directory = process.env.PASEO_FLOWTASKS_DATA_DIR ?? join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "flowtasks");
  const store = new TaskStore(directory);
  const mcp = startTaskMcp(store);
  void mcp.catch(error => console.error("Flowtasks MCP failed:", message(error)));
  registerMcpInjection(server, mcp);
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
