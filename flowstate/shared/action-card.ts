import { z } from "zod";

export const actionCardSchema = z.object({
  label: z.string().min(1),
  icon: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  prompt: z.string().min(1),
});
const headerSchema = actionCardSchema.omit({ prompt: true }).extend({ length: z.number().int().positive() }).strict();
const prefix = "Flowstate action (v1): ";

export function actionMessage(action: { label: string; icon?: string; prompt: string }) {
  return `${prefix}${JSON.stringify({ label: action.label, icon: action.icon ?? "Send", length: action.prompt.length })}\n\n${action.prompt}`;
}

// Persist the action's identity in its message, so history does not depend on
// the current workflow definition or a transient client-side lookup.
export function parseActionCard(message: string) {
  if (!message.startsWith(prefix)) return;
  const divider = message.indexOf("\n\n", prefix.length);
  if (divider < 0) return;
  try {
    const header = headerSchema.parse(JSON.parse(message.slice(prefix.length, divider)));
    const prompt = message.slice(divider + 2);
    if (prompt.length !== header.length) return;
    return actionCardSchema.parse({ label: header.label, icon: header.icon, prompt });
  } catch { return; }
}
