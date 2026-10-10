import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { changeSchema, taskViewSchema, taskView, type Outline } from "../shared/tasks";
import { atomicWrite, isMissing, message, TaskStore } from "./store";
import { WorkspaceBindings } from "./bindings";

export function createTaskMcp(store: TaskStore, workspaceId: string) {
  const mcp = new McpServer({ name: "flowtasks", version: "0.1.0" }, {
    instructions: "Flowtasks is a shared workspace task outline. Read it with flowtasks_get. Use flowtasks_change to create, edit, complete, move, or delete tasks when requested. Read before changes and pass the current revision. On a conflict, read again and reassess; do not blindly retry. completed is the task's own saved flag; effectiveCompleted also includes completion inherited from ancestors. Use status open to list only effectively open tasks. Completing or reopening a parent never changes its children's saved flags. Never edit the saved files directly.",
  });
  const result = async (operation: () => Promise<Outline>, status: "all" | "open" | "completed" = "all") => {
    try {
      const outline = taskView(await operation(), status);
      return { content: [{ type: "text" as const, text: JSON.stringify(outline) }], structuredContent: outline };
    } catch (error) { return { isError: true, content: [{ type: "text" as const, text: message(error) }] }; }
  };
  mcp.registerTool("flowtasks_get", {
    description: "Read this workspace's outline and revision. Optional status: all (default), open, or completed. Open excludes tasks completed explicitly or through an ancestor. completed is the saved flag; effectiveCompleted includes ancestors. Array order determines sibling order; parentId defines nesting. The workspace is fixed by your agent's token.",
    inputSchema: z.object({ status: z.enum(["all", "open", "completed"]).optional() }).strict(), outputSchema: taskViewSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, input => result(() => store.read(workspaceId), input.status));
  mcp.registerTool("flowtasks_change", {
    description: "Change the shared outline using expectedRevision from flowtasks_get. Create appends under parentId (null for root), or follows afterId. Update changes text or the selected task's own completion flag; descendants inherit completion without changing their saved flags. Move carries children: afterId null places it first. Delete requires deleteChildren true to remove a branch. Returns the new outline with effectiveCompleted values. Each successful change increments revision.",
    inputSchema: changeSchema, outputSchema: taskViewSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, input => result(() => store.change(workspaceId, input.expectedRevision, input.action)));
  return mcp;
}

export async function startTaskMcp(store: TaskStore) {
  const bindings = await WorkspaceBindings.load(store);
  const portPath = join(store.directory, "mcp-port.json");
  let port = 0;
  try { port = z.object({ port: z.number().int().min(1024).max(65535) }).parse(JSON.parse(await readFile(portPath, "utf8"))).port; }
  catch (error) { if (!isMissing(error)) throw error; }
  const active = new Set<McpServer>();
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const fail = (status: number, text: string) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: text } }));
    if (request.url !== "/mcp") { fail(404, "Not found."); return; }
    if (request.headers.origin || request.headers.host !== `127.0.0.1:${port}`) { fail(403, "Flowtasks requires daemon loopback."); return; }
    const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const workspaceId = bindings.resolve(token);
    if (!workspaceId) { fail(403, "Flowtasks token is not bound to a workspace."); return; }
    if (request.method !== "POST") { response.setHeader("Allow", "POST"); fail(405, "Use MCP POST requests."); return; }
    const mcp = createTaskMcp(store, workspaceId);
    active.add(mcp);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.once("close", () => { active.delete(mcp); void mcp.close().catch(error => console.error("Flowtasks cleanup:", message(error))); });
    try { await mcp.connect(transport); await transport.handleRequest(request, response); }
    catch (error) {
      console.error("Flowtasks request:", message(error));
      if (!response.headersSent) fail(500, "Flowtasks request failed."); else response.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Flowtasks could not bind its MCP port.");
  port = address.port;
  try { await atomicWrite(portPath, JSON.stringify({ port })); }
  catch (error) { server.close(); throw error; }
  return {
    url: `http://127.0.0.1:${port}/mcp`, bindings,
    async close() {
      await Promise.allSettled([...active].map(mcp => mcp.close()));
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
