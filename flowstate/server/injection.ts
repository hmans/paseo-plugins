import type { PluginServerContext, PluginHookContext } from "@getpaseo/plugin/server";
import type { startWorkflowMcp } from "./mcp";

export const MCP_NAME = "flowstate";
export const TOKEN_ENV = "PASEO_FLOWSTATE_BOOTSTRAP_TOKEN";

const AGENT_GUIDANCE = "Flowstate provides optional workspace workflows. Use workflow_validate after creating or editing .paseo/flowstate.yml and fix validation errors before declaring setup complete. At the start of substantive work, read workflow_get_state. If it reports missing, continue normal work without creating a workflow unless asked. If ready, keep the state aligned with the actual stage as work progresses. Follow the configured transitions and criteria; move to the completion state only after verifying the agreed work. Routine questions, checks, and commits do not need a new workflow cycle. A clear user request is enough to proceed with routine work; do not add approval steps just for tracking. State is shared: read before transitions, use the returned revision and definitionVersion, and reassess conflicts. Use the tools, not saved state files.";

export function registerMcpInjection(server: PluginServerContext, ready: ReturnType<typeof startWorkflowMcp>, observeContext?: (context: PluginHookContext) => void) {
  server.before("agent.create", async ({ request }, context) => {
    observeContext?.(context);
    const mcp = await ready;
    const previous = request.config.mcpServers?.[MCP_NAME];
    if (previous && !(previous.type === "http" && previous.url === mcp.url && mcp.bindings.owns(previous.headers?.Authorization?.replace(/^Bearer /, "") ?? ""))) {
      throw new Error(`An unrelated MCP server already uses the name "${MCP_NAME}".`);
    }
    const token = await mcp.bindings.issue(request.config.cwd);
    const systemPrompt = request.config.systemPrompt ?? "";
    return {
      ...request,
      env: { ...request.env, [TOKEN_ENV]: token },
      config: {
        ...request.config,
        systemPrompt: systemPrompt.includes(AGENT_GUIDANCE) ? systemPrompt : [systemPrompt, AGENT_GUIDANCE].filter(Boolean).join("\n\n"),
        mcpServers: {
          ...request.config.mcpServers,
          [MCP_NAME]: { type: "http" as const, url: mcp.url, headers: { Authorization: `Bearer ${token}` } },
        },
      },
    };
  });

  server.before("agent.session_open", async ({ request }, context) => {
    observeContext?.(context);
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
