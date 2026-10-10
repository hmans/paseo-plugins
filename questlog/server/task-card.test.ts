import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTaskCard } from "../shared/task-card";
import { taskPrompt } from "../shared/work";

function prompt(text: string) {
  return taskPrompt({ revision: 0, items: [{ id: "task-123", parentId: null, text, completed: false }] }, "task-123");
}

test("task cards preserve the original prompt and multiline task text", () => {
  const text = "Build the button\n\nTask ID: part of the task description\nKeep this text.";
  const original = prompt(text);
  assert.deepEqual(parseTaskCard(original), { taskId: "task-123", text, prompt: original });
});

test("unrelated, partial and edited messages retain the normal renderer", () => {
  const original = prompt("Build the button");
  for (const message of ["Hello", "Work on this Questlog task: some idea", original.slice(0, -1),
    `Please explain this:\n${original}`, `${original}\nAnd do something else`,
    original.replace("Task ID: task-123", "Task ID: "), original.replace("Task ID: task-123", "Task ID: two words")]) {
    assert.equal(parseTaskCard(message), undefined);
  }
});
