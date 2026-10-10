import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const id = z.string().min(1).max(200);
const text = z.string().max(10000);
export const itemSchema = z.object({
  id, parentId: id.nullable(), text, completed: z.boolean(),
}).strict();
export type Item = z.infer<typeof itemSchema>;
export const outlineSchema = z.object({
  revision: z.number().int().nonnegative(), items: z.array(itemSchema).max(5000),
}).strict();
export type Outline = z.infer<typeof outlineSchema>;

// Completion flows down from completed parents and up from complete child sets.
// Derive it from saved flags on every read, so implicit completion is reversible.
export function completedIds(items: Item[]): Set<string> {
  const byId = new Map(items.map(item => [item.id, item]));
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    if (item.parentId === null) continue;
    const group = groups.get(item.parentId) ?? [];
    group.push(item);
    groups.set(item.parentId, group);
  }
  const result = new Set<string>();
  const remaining = new Map([...groups].map(([id, children]) => [id, children.length]));
  const pending = items.filter(item => item.completed);
  while (pending.length) {
    const item = pending.pop()!;
    if (result.has(item.id)) continue;
    result.add(item.id);
    pending.push(...(groups.get(item.id) ?? []));
    if (item.parentId !== null) {
      const count = (remaining.get(item.parentId) ?? 0) - 1;
      remaining.set(item.parentId, count);
      const parent = byId.get(item.parentId);
      if (count === 0 && parent) pending.push(parent);
    }
  }
  return result;
}

export const taskViewSchema = outlineSchema.extend({
  items: z.array(itemSchema.extend({ effectiveCompleted: z.boolean() })),
});
export function taskView(outline: Outline, status: "all" | "open" | "completed" = "all") {
  const completed = completedIds(outline.items);
  return { revision: outline.revision, items: outline.items
    .map(item => ({ ...item, effectiveCompleted: completed.has(item.id) }))
    .filter(item => status === "all" || item.effectiveCompleted === (status === "completed")) };
}

// Array order determines sibling order. Moving an item carries its whole subtree.
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), text, parentId: id.nullable(), afterId: id.optional() }).strict(),
  z.object({ type: z.literal("update"), id, text: text.optional(), completed: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("move"), id, parentId: id.nullable(), afterId: id.nullable() }).strict(),
  z.object({ type: z.literal("delete"), id, deleteChildren: z.boolean() }).strict(),
]);
export type Action = z.infer<typeof actionSchema>;
export const changeSchema = z.object({ expectedRevision: z.number().int().nonnegative(), action: actionSchema }).strict();
const taskReference = z.union([id, z.object({ ref: id }).strict()]);
export const batchActionSchema = z.discriminatedUnion("type", [
  actionSchema.options[0].extend({ tempId: id.optional(), parentId: taskReference.nullable(), afterId: taskReference.optional() }),
  actionSchema.options[1].extend({ id: taskReference }),
  actionSchema.options[2].extend({ id: taskReference, parentId: taskReference.nullable(), afterId: taskReference.nullable() }),
  actionSchema.options[3].extend({ id: taskReference }),
]);
export type BatchAction = z.infer<typeof batchActionSchema>;
export const batchSchema = z.object({
  expectedRevision: z.number().int().nonnegative(), actions: z.array(batchActionSchema).min(1).max(100),
}).strict();
export const batchResultSchema = taskViewSchema.extend({ createdIds: z.record(z.string(), id) });
export const getOutline = defineRpc({ name: "outline.get", input: z.object({ workspaceId: id }), output: outlineSchema });
export const changeOutline = defineRpc({ name: "outline.change", input: changeSchema.extend({ workspaceId: id }), output: outlineSchema });

export function children(items: Item[], parentId: string | null) {
  return items.filter(item => item.parentId === parentId);
}

export function descendants(items: Item[], id: string): Set<string> {
  const result = new Set<string>();
  const pending = [id];
  while (pending.length) {
    const parent = pending.pop()!;
    for (const child of children(items, parent)) {
      if (!result.has(child.id)) { result.add(child.id); pending.push(child.id); }
    }
  }
  return result;
}
