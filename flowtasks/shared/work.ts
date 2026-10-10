import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { Outline } from "./tasks";
import { taskPromptInstructions, taskPromptPrefix } from "./task-card";

export const workOnTask = defineRpc({
  name: "outline.work",
  input: z.object({ workspaceId: z.string().min(1), agentId: z.string().min(1), taskId: z.string().min(1), expectedRevision: z.number().int().nonnegative() }),
  output: z.object({ sent: z.literal(true) }),
});

export function taskPrompt(outline: Outline, taskId: string): string {
  const task = outline.items.find(item => item.id === taskId);
  if (!task) throw new Error("This task was deleted. Reload tasks.");
  if (!task.text.trim()) throw new Error("Give this task a description before starting work.");
  return [
    `${taskPromptPrefix}${task.text}`,
    `Task ID: ${task.id}`,
    taskPromptInstructions,
  ].join("\n\n");
}
