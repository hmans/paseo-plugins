import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { startTaskMcp } from "./mcp";

const TOKEN_ENV = "PASEO_FLOWTASKS_BOOTSTRAP_TOKEN";
const AGENT_GUIDANCE = "Flowtasks is this workspace's shared task outline. At the start of substantive work, read flowtasks_get and reuse or add tasks for the agreed scope. Track meaningful outcomes, not every action: questions, reviews, checks, commits, and small follow-ups usually belong to the existing task, not new todos. Keep titles short and descriptions useful and concise. Update tasks when scope changes or work is verified complete; preserve unrelated and completed work. Use current revisions and reread on conflicts. Use the tools, not saved state files.";

export function registerMcpInjection(server: PluginServerContext, ready: ReturnType<typeof startTaskMcp>) {
  server.before("agent.create", async ({ request }) => {
    const mcp = await ready;
    const previous = request.config.mcpServers?.flowtasks;
    if (previous && !(previous.type === "http" && previous.url === mcp.url && mcp.bindings.owns(previous.headers?.Authorization?.replace(/^Bearer /, "") ?? ""))) throw new Error('An unrelated MCP server already uses the name "flowtasks".');
    const token = await mcp.bindings.issue(request.config.cwd);
    const systemPrompt = request.config.systemPrompt ?? "";
    return {
      ...request, env: { ...request.env, [TOKEN_ENV]: token },
      config: {
        ...request.config,
        systemPrompt: systemPrompt.includes(AGENT_GUIDANCE) ? systemPrompt : [systemPrompt, AGENT_GUIDANCE].filter(Boolean).join("\n\n"),
        mcpServers: { ...request.config.mcpServers, flowtasks: { type: "http" as const, url: mcp.url, headers: { Authorization: `Bearer ${token}` } } },
      },
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
