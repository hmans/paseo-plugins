import { z } from "zod";
import { setupPrompt } from "./setup";

export const setupCardSchema = z.object({ prompt: z.string() });

// Claim only the complete setup instructions we send, never a user's discussion
// of them, a partial message, or a prompt with extra instructions appended.
export function parseSetupCard(prompt: string) {
  return prompt === setupPrompt ? { prompt } : undefined;
}
