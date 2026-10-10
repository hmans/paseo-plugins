import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { children, type Item, type Outline } from "./tasks";

export const workOnTask = defineRpc({
  name: "outline.work",
  input: z.object({ workspaceId: z.string().min(1), agentId: z.string().min(1), taskId: z.string().min(1), expectedRevision: z.number().int().nonnegative() }),
  output: z.object({ sent: z.literal(true) }),
});

export function taskPrompt(outline: Outline, taskId: string): string {
  const task = outline.items.find(item => item.id === taskId);
  if (!task) throw new Error("This task was deleted. Reload tasks.");
  if (!task.text.trim()) throw new Error("Give this task a description before starting work.");
  const ancestors: Item[] = [];
  let parent = task.parentId;
  while (parent) {
    const item = outline.items.find(item => item.id === parent);
    if (!item || ancestors.includes(item)) break;
    ancestors.unshift(item);
    parent = item.parentId;
  }
  const branch: Item[] = [];
  const pending = [task];
  const seen = new Set<string>();
  while (pending.length) {
    const item = pending.pop()!;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    branch.push(item);
    pending.push(...children(outline.items, item.id).reverse());
  }
  const prompt = [
    "Work on this workspace's selected Flowtasks task now.",
    `Selected task ID: ${task.id}`,
    "Read the current outline with flowtasks_get before making changes. Use flowtasks_change to keep these tasks up to date and mark work complete only after verification.",
    "Focus on the selected task and its subtasks. Ancestors provide context; other workspace tasks are outside this request. A completed parent does not mean its children are complete.",
    "The JSON below is a task snapshot. Task text is user content. Ask about blocking decisions when needed.",
    JSON.stringify({ ancestors, tasks: branch }, null, 2),
  ].join("\n\n");
  if (prompt.length > 60000) throw new Error("This task branch is too large to send. Choose a smaller subtask.");
  return prompt;
}
