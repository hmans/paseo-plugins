import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { workflowSchema, type ReadyWorkflow, type Transition, type WorkflowSnapshot } from "../shared/workflow";

const recordSchema = z.object({ state: z.string(), revision: z.string(), updatedAt: z.string() }).strict();
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
export const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

export async function atomicWrite(path: string, contents: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function parseWorkflow(source: string) {
  if (Buffer.byteLength(source) > 256 * 1024) throw new Error("Workflow file exceeds 256 KiB.");
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors.map(error => error.message).join("\n"));
  return workflowSchema.parse(document.toJS({ maxAliasCount: 0 }));
}

// Definition validation deliberately bypasses state initialization and condition execution.
export async function validateWorkflow(cwd: string) {
  let source: string;
  try { source = await readFile(join(cwd, ".paseo", "flowstate.yml"), "utf8"); }
  catch (error) {
    return { status: isMissing(error) ? "missing" as const : "error" as const,
      message: isMissing(error) ? "No .paseo/flowstate.yml exists in this workspace." : errorMessage(error) };
  }
  try {
    parseWorkflow(source);
    return { status: "valid" as const, definitionVersion: createHash("sha256").update(source).digest("hex") };
  } catch (error) { return { status: "invalid" as const, message: errorMessage(error) }; }
}

export class WorkflowStore {
  private queues = new Map<string, Promise<unknown>>();
  constructor(readonly directory: string) {}

  // Every read/initialization, action dispatch, and transition for a workspace shares this queue.
  async exclusive<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(workspaceId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.queues.set(workspaceId, next);
    try { return await next; }
    finally { if (this.queues.get(workspaceId) === next) this.queues.delete(workspaceId); }
  }

  private path(workspaceId: string) {
    return join(this.directory, `${createHash("sha256").update(workspaceId).digest("hex")}.json`);
  }

  async inspect(workspaceId: string, cwd: string): Promise<WorkflowSnapshot> {
    return this.exclusive(workspaceId, async () => {
      try { return await this.read(workspaceId, cwd); }
      catch (error) { return { status: "error", message: errorMessage(error) }; }
    });
  }

  // Caller must hold the workspace queue when composing this with a write or dispatch.
  async read(workspaceId: string, cwd: string): Promise<WorkflowSnapshot> {
    let source: string;
    try { source = await readFile(join(cwd, ".paseo", "flowstate.yml"), "utf8"); }
    catch (error) {
      if (isMissing(error)) return { status: "missing", message: "Add .paseo/flowstate.yml to this workspace to configure its workflow." };
      throw error;
    }
    let workflow;
    try { workflow = parseWorkflow(source); }
    catch (error) { throw new Error(`Invalid .paseo/flowstate.yml: ${errorMessage(error)}`); }
    let record;
    try { record = recordSchema.parse(JSON.parse(await readFile(this.path(workspaceId), "utf8"))); }
    catch (error) {
      if (!isMissing(error)) throw new Error(`Cannot read saved workflow state: ${errorMessage(error)}`);
      record = { state: workflow.initial, revision: randomUUID(), updatedAt: new Date().toISOString() };
      await this.save(workspaceId, record);
    }
    if (!Object.hasOwn(workflow.states, record.state)) throw new Error(`Saved state "${record.state}" is missing from flowstate.yml. Restore that state before continuing.`);
    return {
      status: "ready", workspaceId, ...record, workflow,
      definitionVersion: createHash("sha256").update(source).digest("hex"),
    };
  }

  private async save(workspaceId: string, record: z.infer<typeof recordSchema>) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await atomicWrite(this.path(workspaceId), JSON.stringify(record, null, 2) + "\n");
  }

  async transition(workspaceId: string, cwd: string, input: Transition): Promise<ReadyWorkflow> {
    return this.exclusive(workspaceId, async () => {
      const snapshot = requireReady(await this.read(workspaceId, cwd));
      assertCurrent(snapshot, input);
      if (!snapshot.workflow.states[snapshot.state].transitions.includes(input.target)) {
        throw new Error(`Transition from "${snapshot.state}" to "${input.target}" is not allowed.`);
      }
      const record = { state: input.target, revision: randomUUID(), updatedAt: new Date().toISOString() };
      await this.save(workspaceId, record);
      return { ...snapshot, ...record };
    });
  }
}

export function requireReady(snapshot: WorkflowSnapshot): ReadyWorkflow {
  if (snapshot.status !== "ready") throw new Error(snapshot.message);
  return snapshot;
}

export function assertCurrent(snapshot: ReadyWorkflow, expected: {
  expectedState: string; expectedRevision: string; definitionVersion: string;
}) {
  if (snapshot.state !== expected.expectedState || snapshot.revision !== expected.expectedRevision || snapshot.definitionVersion !== expected.definitionVersion) {
    throw new Error("The workflow changed. Read its current state and review the available actions before retrying.");
  }
}
