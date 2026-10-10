import assert from "node:assert/strict";
import { test } from "node:test";
import { setupPrompt } from "../shared/setup";
import { parseSetupCard, setupCardSchema } from "../shared/setup-card";

test("setup cards preserve the full sent prompt and leave other messages alone", () => {
  assert.deepEqual(setupCardSchema.parse(parseSetupCard(setupPrompt)), { prompt: setupPrompt });
  for (const message of ["", "Set up a Flowstate workflow", setupPrompt.slice(0, -20), `Explain this: ${setupPrompt}`, `${setupPrompt}\nAlso deploy it.`]) {
    assert.equal(parseSetupCard(message), undefined);
  }
});
