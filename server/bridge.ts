import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { transitionSchema, type ReadyWorkflow } from "../shared/workflow";
import { atomicWrite, errorMessage, isMissing, requireReady, WorkflowStore } from "./store";

// The installed helper reads the current endpoint each time, including after a reload.
const cliSource = String.raw`import { readFile } from "node:fs/promises";
const [binding, command, target, expectedState, expectedRevision, definitionVersion] = process.argv.slice(2);
try {
  if (!binding || !["get", "transition"].includes(command)) throw new Error("Usage: workflow.mjs <binding> get | transition <target> <expected-state> <revision> <definition-version>");
  const { url } = JSON.parse(await readFile(new URL("endpoint.json", import.meta.url), "utf8"));
  const input = command === "get" ? { binding, command } : { binding, command, transition: { target, expectedState, expectedRevision, definitionVersion } };
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Workflow command failed.");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
`;

const scopeSchema = z.object({ workspaceId: z.string().min(1), cwd: z.string().min(1) }).strict();
const requestSchema = z.discriminatedUnion("command", [
  z.object({ binding: z.string(), command: z.literal("get") }).strict(),
  z.object({ binding: z.string(), command: z.literal("transition"), transition: transitionSchema }).strict(),
]);

async function readBody(request: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error("Request exceeds 16 KiB.");
    chunks.push(Buffer.from(chunk));
  }
  return requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function startBridge(store: WorkflowStore) {
  await mkdir(store.directory, { recursive: true, mode: 0o700 });
  const keyPath = join(store.directory, "bridge-key");
  let secret: Buffer;
  try { secret = await readFile(keyPath); }
  catch (error) {
    if (!isMissing(error)) throw error;
    await atomicWrite(keyPath, randomBytes(32).toString("hex"));
    secret = await readFile(keyPath);
  }
  const signature = (value: string) => createHmac("sha256", secret).update(value).digest("hex");
  function authorize(binding: string) {
    const [payload, mac, extra] = binding.split(".");
    if (!payload || !mac || extra || !/^[a-f0-9]{64}$/.test(mac) || !timingSafeEqual(Buffer.from(mac), Buffer.from(signature(payload)))) {
      throw new Error("Invalid workspace binding. Run a workflow action to get current instructions.");
    }
    return scopeSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  }

  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    try {
      if (request.method !== "POST" || request.url !== "/workflow" || request.headers.origin || !/^127\.0\.0\.1:\d+$/.test(request.headers.host ?? "")) {
        response.writeHead(403).end(JSON.stringify({ error: "Use the workflow command from the daemon machine." }));
        return;
      }
      const input = await readBody(request);
      const { workspaceId, cwd } = authorize(input.binding);
      const result = input.command === "get"
        ? requireReady(await store.inspect(workspaceId, cwd))
        : await store.transition(workspaceId, cwd, input.transition);
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400).end(JSON.stringify({ error: errorMessage(error) }));
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Workflow bridge did not bind a TCP port.");
  const url = `http://127.0.0.1:${address.port}/workflow`;
  const cliPath = join(store.directory, "workflow.mjs");
  const endpointPath = join(store.directory, "endpoint.json");
  try {
    await atomicWrite(cliPath, cliSource);
    await atomicWrite(endpointPath, JSON.stringify({ url }));
  } catch (error) { server.close(); throw error; }

  return {
    url,
    cliPath,
    binding(workspaceId: string, cwd: string) {
      const payload = Buffer.from(JSON.stringify({ workspaceId, cwd })).toString("base64url");
      return `${payload}.${signature(payload)}`;
    },
    instructions(snapshot: ReadyWorkflow, cwd: string) {
      const command = `node ${quote(cliPath)} ${quote(this.binding(snapshot.workspaceId, cwd))}`;
      return [
        "Workspace workflow instructions:",
        `Current state: ${snapshot.state}. Allowed next states: ${snapshot.workflow.states[snapshot.state].transitions.join(", ") || "none"}.`,
        "Use the following commands on the daemon machine to read or change this workspace's state. Do not edit saved state files directly.",
        `Read current state: ${command} get`,
        `Transition: ${command} transition '<target>' '<expected-state>' '<revision>' '<definition-version>'`,
        "Before a transition, read the current state and use its state, revision, and definitionVersion in the transition command. Check that your work is still relevant if the state changed. Only transition when the task's criteria are met. A failed command does not change state.",
      ].join("\n");
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      try {
        if (JSON.parse(await readFile(endpointPath, "utf8")).url === url) await rm(endpointPath);
      } catch (error) { if (!isMissing(error)) throw error; }
    },
  };
}
