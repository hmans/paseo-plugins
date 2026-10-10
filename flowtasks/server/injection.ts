import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { startTaskMcp } from "./mcp";

const TOKEN_ENV = "PASEO_FLOWTASKS_BOOTSTRAP_TOKEN";
export function registerMcpInjection(server: PluginServerContext, ready: ReturnType<typeof startTaskMcp>) {
  server.before("agent.create", async ({ request }) => {
    const mcp = await ready;
    const previous = request.config.mcpServers?.flowtasks;
    if (previous && !(previous.type === "http" && previous.url === mcp.url && mcp.bindings.owns(previous.headers?.Authorization?.replace(/^Bearer /, "") ?? ""))) throw new Error('An unrelated MCP server already uses the name "flowtasks".');
    const token = await mcp.bindings.issue(request.config.cwd);
    return {
      ...request, env: { ...request.env, [TOKEN_ENV]: token },
      config: { ...request.config, mcpServers: { ...request.config.mcpServers, flowtasks: { type: "http" as const, url: mcp.url, headers: { Authorization: `Bearer ${token}` } } } },
    };
  });
  server.before("agent.session_open", async ({ request }) => {
    if (request.purpose !== "interactive" || !request.workspaceId) return;
    const token = request.env[TOKEN_ENV];
    const mcp = token ? await ready : await ready.catch(() => null);
    if (!mcp) return;
    if (token) {
      await mcp.bindings.bind(token, request.agentId, request.workspaceId, request.cwd);
      const env = { ...request.env };
      delete env[TOKEN_ENV];
      return { ...request, env };
    }
    await mcp.bindings.resume(request.agentId, request.workspaceId);
  });
}
