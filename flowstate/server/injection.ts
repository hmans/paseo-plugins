import type { PluginServerContext } from "@getpaseo/plugin/server";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { isMissing } from "./store";
import type { startWorkflowMcp } from "./mcp";

export const MCP_NAME = "flowstate";
export const TOKEN_ENV = "PASEO_FLOWSTATE_BOOTSTRAP_TOKEN";

export function registerMcpInjection(server: PluginServerContext, ready: ReturnType<typeof startWorkflowMcp>) {
  server.before("agent.create", async ({ request }) => {
    try { await access(join(request.config.cwd, ".paseo", "flowstate.yml")); }
    catch (error) { if (isMissing(error)) return; throw error; }
    const mcp = await ready;
    const previous = request.config.mcpServers?.[MCP_NAME];
    if (previous && !(previous.type === "http" && previous.url === mcp.url && mcp.bindings.owns(previous.headers?.Authorization?.replace(/^Bearer /, "") ?? ""))) {
      throw new Error(`An unrelated MCP server already uses the name "${MCP_NAME}".`);
    }
    const token = await mcp.bindings.issue(request.config.cwd);
    return {
      ...request,
      env: { ...request.env, [TOKEN_ENV]: token },
      config: {
        ...request.config,
        mcpServers: {
          ...request.config.mcpServers,
          [MCP_NAME]: { type: "http" as const, url: mcp.url, headers: { Authorization: `Bearer ${token}` } },
        },
      },
    };
  });

  server.before("agent.session_open", async ({ request }) => {
    if (request.purpose !== "interactive" || !request.workspaceId) return;
    const token = request.env[TOKEN_ENV];
    // A plugin startup failure must not prevent unrelated agents from opening.
    const mcp = token ? await ready : await ready.catch(() => null);
    if (!mcp) return;
    if (token) {
      await mcp.bindings.bind(token, request.agentId, request.workspaceId, request.cwd);
      // The provider only needs the MCP authorization header. Do not pass the bootstrap token to its environment.
      const env = { ...request.env };
      delete env[TOKEN_ENV];
      return { ...request, env };
    }
    await mcp.bindings.resume(request.agentId, request.workspaceId, request.cwd);
  });
}
