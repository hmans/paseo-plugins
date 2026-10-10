import { z } from "zod";
import { setupPrompt } from "./setup";

export const setupCardSchema = z.object({ prompt: z.string() });

// Claim only the complete setup instructions we send, never a user's discussion
// of them, a partial message, or a prompt with extra instructions appended.
export function parseSetupCard(prompt: string) {
  const previousPrompt = setupPrompt.replace(
    "A prompt action sends its full prompt with an action header to the selected agent.",
    "A prompt action sends exactly its prompt to the selected agent.",
  );
  return prompt === setupPrompt || prompt === previousPrompt ? { prompt } : undefined;
}
