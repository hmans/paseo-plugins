import { createHash, randomBytes } from "node:crypto";
import { realpath, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, isMissing, WorkflowStore } from "./store";

const bindingSchema = z.object({
  cwd: z.string(),
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
}).strict();
type Binding = z.infer<typeof bindingSchema>;
export type BoundWorkspace = Binding & { agentId: string; workspaceId: string };
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export class WorkspaceBindings {
  private constructor(private store: WorkflowStore, private bindings: Record<string, Binding>) {}

  static async load(store: WorkflowStore) {
    let bindings: Record<string, Binding> = {};
    try { bindings = z.record(z.string(), bindingSchema).parse(JSON.parse(await readFile(join(store.directory, "mcp-bindings.json"), "utf8"))); }
    catch (error) { if (!isMissing(error)) throw error; }
    return new WorkspaceBindings(store, bindings);
  }

  private async update(key: string, value: Binding) {
    const next = { ...this.bindings, [key]: value };
    await atomicWrite(join(this.store.directory, "mcp-bindings.json"), JSON.stringify(next, null, 2) + "\n");
    this.bindings = next;
  }

  async issue(cwd: string) {
    const canonical = await realpath(cwd);
    return this.store.exclusive("mcp-bindings", async () => {
      const token = randomBytes(32).toString("base64url");
      await this.update(digest(token), { cwd: canonical, agentId: null, workspaceId: null });
      return token;
    });
  }

  owns(token: string) { return Object.hasOwn(this.bindings, digest(token)); }

  async bind(token: string, agentId: string, workspaceId: string, cwd: string) {
    const canonical = await realpath(cwd);
    await this.store.exclusive("mcp-bindings", async () => {
      const key = digest(token);
      const existing = this.bindings[key];
      if (!existing || existing.cwd !== canonical) throw new Error("Workflow MCP binding does not match this agent's directory.");
      if ((existing.agentId && existing.agentId !== agentId) || (existing.workspaceId && existing.workspaceId !== workspaceId)) {
        throw new Error("Workflow MCP binding already belongs to another agent or workspace.");
      }
      await this.update(key, { cwd: canonical, agentId, workspaceId });
    });
  }

  async resume(agentId: string, workspaceId: string, cwd: string) {
    const existing = Object.entries(this.bindings).find(([, binding]) => binding.agentId === agentId);
    if (!existing) return;
    const [key] = existing;
    const canonical = await realpath(cwd);
    await this.store.exclusive("mcp-bindings", async () => {
      if (this.bindings[key].workspaceId !== workspaceId) throw new Error("Workflow MCP binding cannot move to another workspace.");
      await this.update(key, { agentId, workspaceId, cwd: canonical });
    });
  }

  resolve(token: string): BoundWorkspace | null {
    const binding = this.bindings[digest(token)];
    return binding?.agentId && binding.workspaceId ? binding as BoundWorkspace : null;
  }

  hasAgent(agentId: string, workspaceId: string) {
    return Object.values(this.bindings).some(binding => binding.agentId === agentId && binding.workspaceId === workspaceId);
  }
}
