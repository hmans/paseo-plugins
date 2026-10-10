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

// Array order determines sibling order. Moving an item carries its whole subtree.
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), text, parentId: id.nullable(), afterId: id.optional() }).strict(),
  z.object({ type: z.literal("update"), id, text: text.optional(), completed: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("move"), id, parentId: id.nullable(), afterId: id.nullable() }).strict(),
  z.object({ type: z.literal("delete"), id, deleteChildren: z.boolean() }).strict(),
]);
export type Action = z.infer<typeof actionSchema>;
export const changeSchema = z.object({ expectedRevision: z.number().int().nonnegative(), action: actionSchema }).strict();
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
