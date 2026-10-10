import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { actionSchema, batchSchema, descendants, outlineSchema, type Action, type BatchAction, type Outline } from "../shared/tasks";

export const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
export const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export async function atomicWrite(path: string, data: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, data, { mode: 0o600 }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}

export function applyAction(current: Outline, input: Action): Outline {
  const action = actionSchema.parse(input);
  const items = current.items.map(item => ({ ...item }));
  const requireItem = (id: string) => {
    const item = items.find(item => item.id === id);
    if (!item) throw new Error("Item no longer exists. Refresh the outline.");
    return item;
  };
  if (action.type === "create" || action.type === "move") {
    if (action.parentId) requireItem(action.parentId);
    if (action.afterId && requireItem(action.afterId).parentId !== action.parentId) throw new Error("The position must refer to a sibling.");
  }
  if (action.type === "create") {
    const item = { id: randomUUID(), parentId: action.parentId, text: action.text, completed: false };
    const index = action.afterId ? items.findIndex(item => item.id === action.afterId) + 1 : items.length;
    items.splice(index, 0, item);
  } else {
    const item = requireItem(action.id);
    if (action.type === "update") {
      if (action.text !== undefined) item.text = action.text;
      if (action.completed !== undefined) item.completed = action.completed;
    } else if (action.type === "move") {
      if (action.afterId === item.id || action.parentId === item.id || (action.parentId && descendants(items, item.id).has(action.parentId))) throw new Error("An item cannot be moved into itself or its children.");
      items.splice(items.indexOf(item), 1);
      item.parentId = action.parentId;
      const first = items.findIndex(sibling => sibling.parentId === action.parentId);
      const index = action.afterId ? items.findIndex(sibling => sibling.id === action.afterId) + 1 : first < 0 ? items.length : first;
      items.splice(index, 0, item);
    } else {
      const removed = descendants(items, item.id);
      if (removed.size && !action.deleteChildren) throw new Error("This item has children. Confirm deletion of the whole branch.");
      removed.add(item.id);
      return outlineSchema.parse({ revision: current.revision + 1, items: items.filter(item => !removed.has(item.id)) });
    }
  }
  return outlineSchema.parse({ revision: current.revision + 1, items });
}

export class TaskStore {
  private queues = new Map<string, Promise<unknown>>();
  constructor(readonly directory: string) {}
  private path(workspaceId: string) { return join(this.directory, "outlines", createHash("sha256").update(workspaceId).digest("hex") + ".json"); }
  async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.queues.set(key, next);
    try { return await next; }
    finally { if (this.queues.get(key) === next) this.queues.delete(key); }
  }
  async read(workspaceId: string): Promise<Outline> {
    try {
      // Read the first version without losing existing tasks or notes. All rows are tasks now.
      const saved = outlineSchema.extend({ items: z.array(outlineSchema.shape.items.element.extend({ kind: z.enum(["task", "note"]).optional() })).max(5000) })
        .parse(JSON.parse(await readFile(this.path(workspaceId), "utf8")));
      return outlineSchema.parse({ ...saved, items: saved.items.map(({ kind, ...item }) => item) });
    }
    catch (error) { if (isMissing(error)) return { revision: 0, items: [] }; throw error; }
  }
  async change(workspaceId: string, expectedRevision: number, action: Action) {
    return this.exclusive(`outline:${workspaceId}`, async () => {
      const current = await this.read(workspaceId);
      if (current.revision !== expectedRevision) throw new Error("The outline changed. Refresh and review it before trying again. Your edit was not saved.");
      const next = applyAction(current, action);
      await atomicWrite(this.path(workspaceId), JSON.stringify(next, null, 2) + "\n");
      return next;
    });
  }
  async batch(workspaceId: string, expectedRevision: number, actions: BatchAction[]) {
    const input = batchSchema.parse({ expectedRevision, actions });
    return this.exclusive(`outline:${workspaceId}`, async () => {
      const current = await this.read(workspaceId);
      if (current.revision !== input.expectedRevision) throw new Error("The outline changed. Refresh and review it before trying again. Your batch was not saved.");
      const created = new Map<string, string>();
      const resolve = (reference: string | { ref: string }) => {
        if (typeof reference === "string") return reference;
        const id = created.get(reference.ref);
        if (!id) throw new Error(`Unknown temporary reference: ${reference.ref}. Create the task before referencing it.`);
        return id;
      };
      let next = current;
      for (const [index, action] of input.actions.entries()) {
        try {
          let resolved: Action;
          if (action.type === "create") {
            if (action.tempId && created.has(action.tempId)) throw new Error(`Duplicate temporary ID: ${action.tempId}.`);
            resolved = { type: "create", text: action.text, parentId: action.parentId === null ? null : resolve(action.parentId),
              ...(action.afterId === undefined ? {} : { afterId: resolve(action.afterId) }) };
          } else if (action.type === "move") {
            resolved = { type: "move", id: resolve(action.id), parentId: action.parentId === null ? null : resolve(action.parentId),
              afterId: action.afterId === null ? null : resolve(action.afterId) };
          } else {
            resolved = { ...action, id: resolve(action.id) };
          }
          const previous = next;
          next = applyAction(next, resolved);
          if (action.type === "create" && action.tempId) {
            const previousIds = new Set(previous.items.map(item => item.id));
            created.set(action.tempId, next.items.find(item => !previousIds.has(item.id))!.id);
          }
        } catch (error) { throw new Error(`Batch action ${index + 1}: ${message(error)} No changes were saved.`); }
      }
      next = { ...next, revision: current.revision + 1 };
      await atomicWrite(this.path(workspaceId), JSON.stringify(next, null, 2) + "\n");
      return { ...next, createdIds: Object.fromEntries(created) };
    });
  }
}
