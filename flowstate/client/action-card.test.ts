import assert from "node:assert/strict";
import { test } from "node:test";
import { actionMessage, parseActionCard } from "../shared/action-card";

test("action messages retain labels, icons and exact multiline prompts for history", () => {
  const action = { label: 'Review "changes"', icon: "ScanEye", prompt: "Check this.\n\nThen test. 🧪\n" };
  assert.deepEqual(parseActionCard(actionMessage(action)), action);
  assert.equal(parseActionCard(actionMessage({ ...action, icon: undefined }))?.icon, "Send");
});

test("unrelated, malformed, truncated and appended messages keep native rendering", () => {
  const message = actionMessage({ label: "Plan", prompt: "Write a plan." });
  for (const text of ["Write a plan.", "Flowstate action (v1): {}\n\nHello", message.slice(0, -1), message + "extra", "Quote: " + message]) {
    assert.equal(parseActionCard(text), undefined);
  }
});
