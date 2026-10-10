import { z } from "zod";

export const taskPromptPrefix = "Work on this Flowtasks task: ";
export const taskPromptInstructions = "Read flowtasks_get for context and subtasks. Focus on this task and mark verified work complete with flowtasks_change.";
export const taskCardSchema = z.object({
  taskId: z.string().min(1).max(200),
  text: z.string().min(1).max(10000),
  prompt: z.string(),
});

// Only claim the complete prompt format emitted by Flowtasks. Other messages
// retain Paseo's normal renderer, including partial or edited prompts.
export function parseTaskCard(prompt: string): z.output<typeof taskCardSchema> | undefined {
  const suffix = `\n\n${taskPromptInstructions}`;
  if (!prompt.startsWith(taskPromptPrefix) || !prompt.endsWith(suffix)) return;
  const body = prompt.slice(taskPromptPrefix.length, -suffix.length);
  const divider = "\n\nTask ID: ";
  const index = body.lastIndexOf(divider);
  if (index < 0) return;
  const text = body.slice(0, index);
  const taskId = body.slice(index + divider.length);
  if (!text.trim() || /\s/.test(taskId)) return;
  const result = taskCardSchema.safeParse({ taskId, text, prompt });
  return result.success ? result.data : undefined;
}
