import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, isMissing, TaskStore } from "./store";

const bindingSchema = z.object({ cwd: z.string(), agentId: z.string().nullable(), workspaceId: z.string().nullable() }).strict();
type Binding = z.infer<typeof bindingSchema>;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export class WorkspaceBindings {
  private constructor(private store: TaskStore, private bindings: Record<string, Binding>) {}
  static async load(store: TaskStore) {
    let bindings: Record<string, Binding> = {};
    try { bindings = z.record(z.string(), bindingSchema).parse(JSON.parse(await readFile(join(store.directory, "mcp-bindings.json"), "utf8"))); }
    catch (error) { if (!isMissing(error)) throw error; }
    return new WorkspaceBindings(store, bindings);
  }
  private async update(key: string, binding: Binding) {
    const next = { ...this.bindings, [key]: binding };
    await atomicWrite(join(this.store.directory, "mcp-bindings.json"), JSON.stringify(next));
    this.bindings = next;
  }
  async issue(cwd: string) {
    const canonical = await realpath(cwd);
    return this.store.exclusive("bindings", async () => {
      const token = randomBytes(32).toString("base64url");
      await this.update(digest(token), { cwd: canonical, agentId: null, workspaceId: null });
      return token;
    });
  }
  owns(token: string) { return Object.hasOwn(this.bindings, digest(token)); }
  async bind(token: string, agentId: string, workspaceId: string, cwd: string) {
    const canonical = await realpath(cwd);
    await this.store.exclusive("bindings", async () => {
      const key = digest(token);
      const existing = this.bindings[key];
      if (!existing || existing.cwd !== canonical) throw new Error("Flowtasks token does not match this directory.");
      if ((existing.agentId && existing.agentId !== agentId) || (existing.workspaceId && existing.workspaceId !== workspaceId)) throw new Error("Flowtasks token belongs to another agent or workspace.");
      await this.update(key, { cwd: canonical, agentId, workspaceId });
    });
  }
  async resume(agentId: string, workspaceId: string) {
    const binding = Object.values(this.bindings).find(binding => binding.agentId === agentId);
    if (binding && binding.workspaceId !== workspaceId) throw new Error("Flowtasks token cannot move to another workspace.");
  }
  resolve(token: string) {
    const binding = this.bindings[digest(token)];
    return binding?.agentId && binding.workspaceId ? binding.workspaceId : null;
  }
}
