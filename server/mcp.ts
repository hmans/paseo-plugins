import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { readySchema, transitionSchema, type ReadyWorkflow } from "../shared/workflow";
import { atomicWrite, errorMessage, isMissing, requireReady, WorkflowStore } from "./store";
import { WorkspaceBindings, type BoundWorkspace } from "./bindings";

function createWorkflowMcp(store: WorkflowStore, scope: BoundWorkspace) {
  const mcp = new McpServer({ name: "workspace-workflow", version: "0.1.0" }, {
    instructions: "This workspace has a project workflow. Use workflow_get_state to read its state and available transitions. Use workflow_transition when the task's criteria are met. State is shared by all agents in this workspace. Do not edit saved state files.",
  });
  const result = async (operation: () => Promise<ReadyWorkflow>) => {
    try {
      const snapshot = await operation();
      return { content: [{ type: "text" as const, text: JSON.stringify(snapshot) }], structuredContent: snapshot };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: errorMessage(error) }] };
    }
  };
  mcp.registerTool("workflow_get_state", {
    title: "Read workspace workflow",
    description: "Read this agent's workspace state, configured prompts, allowed transitions, revision, and definitionVersion. No workspace ID or file path is needed. Read before requesting a transition.",
    inputSchema: z.object({}).strict(),
    outputSchema: readySchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => result(async () => requireReady(await store.inspect(scope.workspaceId, scope.cwd))));
  mcp.registerTool("workflow_transition", {
    title: "Change workspace workflow state",
    description: "Move this agent's workspace to an allowed next state after its task criteria are met. First call workflow_get_state. Supply that result's state as expectedState, revision as expectedRevision, and definitionVersion unchanged. If the workflow changed, read it again and reassess your work before retrying. This changes shared workflow state; it does not send prompts or start agents.",
    inputSchema: transitionSchema,
    outputSchema: readySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, input => result(() => store.transition(scope.workspaceId, scope.cwd, input)));
  return mcp;
}

export async function startWorkflowMcp(store: WorkflowStore) {
  await mkdir(store.directory, { recursive: true, mode: 0o700 });
  const bindings = await WorkspaceBindings.load(store);
  const portPath = join(store.directory, "mcp-port.json");
  let port = 0;
  try { port = z.object({ port: z.number().int().min(1024).max(65535) }).parse(JSON.parse(await readFile(portPath, "utf8"))).port; }
  catch (error) { if (!isMissing(error)) throw error; }
  const active = new Set<McpServer>();
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const fail = (status: number, message: string) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }));
    if (request.url !== "/mcp") { fail(404, "Not found."); return; }
    if (request.headers.origin || request.headers.host !== `127.0.0.1:${port}`) { fail(403, "Workflow MCP is only available on daemon loopback."); return; }
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const scope = bindings.resolve(token);
    if (!scope) { fail(403, "Workflow MCP is not bound to this agent's workspace."); return; }
    if (request.method !== "POST") { response.setHeader("Allow", "POST"); fail(405, "Use stateless MCP POST requests."); return; }

    const mcp = createWorkflowMcp(store, scope);
    active.add(mcp);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.once("close", () => {
      active.delete(mcp);
      void mcp.close().catch(error => console.error("Workflow MCP cleanup failed:", errorMessage(error)));
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      console.error("Workflow MCP request failed:", errorMessage(error));
      if (!response.headersSent) fail(500, "Workflow MCP request failed.");
      else response.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  }).catch(error => { throw new Error(`Cannot start workflow MCP on its saved port: ${errorMessage(error)}`); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Workflow MCP did not bind a TCP port.");
  port = address.port;
  const url = `http://127.0.0.1:${port}/mcp`;
  try { await atomicWrite(portPath, JSON.stringify({ port }) + "\n"); }
  catch (error) { server.close(); throw error; }
  return {
    url,
    bindings,
    async close() {
      await Promise.allSettled([...active].map(mcp => mcp.close()));
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
