import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginButton } from "@getpaseo/plugin/client";
import type { ReadyWorkflow } from "../shared/workflow";
import { actionButtons, createActionPills } from "./action-pills";

const snapshot: ReadyWorkflow = {
  status: "ready", workspaceId: "one", state: "working", revision: "one", definitionVersion: "one", updatedAt: "now", toolsReady: true,
  workflow: { initial: "working", conditions: {}, actions: [], states: { working: { actions: [
    { label: "Review", prompt: "Review the work." },
    { label: "Commit", prompt: "Make a commit.", when: "git.dirty" },
  ], transitions: [] } } },
  actionConditions: { Commit: { value: "true" } },
};

test("action pills reflect conditions, availability, and direct dispatch", async () => {
  const sent: string[] = [];
  const dispatch = async (label: string) => { sent.push(label); };
  const buttons = actionButtons(snapshot, false, dispatch);
  assert.deepEqual(buttons.map(button => button.label), ["Review", "Commit"]);
  assert.ok(buttons.every(button => button.visible && !button.disabled));
  assert.equal(buttons[0].title, "Review the work.");
  assert.equal(buttons[0].icon, "Send");
  assert.equal(buttons[1].behavior.kind, "action");
  if (buttons[1].behavior.kind === "action") await buttons[1].behavior.onPress();
  assert.deepEqual(sent, ["Commit"]);
  assert.ok(actionButtons(snapshot, true, dispatch).every(button => button.disabled));
  assert.ok(actionButtons({ ...snapshot, toolsReady: false }, false, dispatch).every(button => button.disabled));
  const hidden = actionButtons({ ...snapshot, actionConditions: { Commit: { value: "false" } } }, false, dispatch);
  assert.equal(hidden[1].visible, false);
  const unknown = actionButtons({ ...snapshot, actionConditions: { Commit: { value: "unknown", message: "Check failed" } } }, false, dispatch);
  assert.equal(unknown[1].visible, true);
  assert.equal(unknown[1].disabled, true);
  assert.match(unknown[1].title, /Check failed/);
  assert.equal(actionButtons({ ...snapshot, actionConditions: undefined }, false, dispatch)[1].disabled, true);
  assert.deepEqual(actionButtons({ status: "error", message: "Offline" }, false, dispatch), []);
  assert.deepEqual(actionButtons(undefined, false, dispatch), []);
});

test("action icons reach the host renderer and update with the configuration", () => {
  const configured = structuredClone(snapshot);
  configured.workflow.states.working.actions[1].icon = "GitCommitHorizontal";
  assert.equal(actionButtons(configured, false, async () => {})[1].icon, "GitCommitHorizontal");
  const names: string[] = [];
  actionButtons(configured, false, async () => {}, name => { names.push(name); return name; });
  assert.deepEqual(names, ["Send", "GitCommitHorizontal"]);
  configured.workflow.states.working.actions[1].icon = "ScanEye";
  assert.equal(actionButtons(configured, false, async () => {})[1].icon, "ScanEye");
});

test("common action pills follow local actions and remain in states without local actions", () => {
  const configured = structuredClone(snapshot);
  configured.workflow.actions = [{ label: "Common", prompt: "Common prompt", icon: "Plus", when: "git.dirty" }];
  configured.actionConditions = { Common: { value: "true" } };
  const buttons = () => actionButtons(configured, false, async () => {});
  assert.deepEqual(buttons().map(button => button.label), ["Review", "Commit", "Common"]);
  configured.workflow.states.working.actions = [];
  assert.deepEqual(buttons().map(button => button.label), ["Common"]);
  assert.equal(buttons()[0].icon, "Plus");
  configured.actionConditions.Common = { value: "false" };
  assert.equal(buttons()[0].visible, false);
});

test("pill registrations update, remove obsolete actions, and ignore late updates after cleanup", () => {
  const entries = new Map<string, PluginButton>();
  let additions = 0;
  let removals = 0;
  const pills = createActionPills((id, button) => {
    additions++;
    entries.set(id, button);
    return {
      update: patch => { entries.set(id, { ...entries.get(id)!, ...patch }); },
      remove: () => { removals++; entries.delete(id); },
    };
  });
  pills.update(actionButtons(snapshot, false, async () => {}));
  pills.update(actionButtons(snapshot, true, async () => {}));
  assert.equal(additions, 2);
  assert.ok([...entries.values()].every(button => button.disabled));
  const next = actionButtons(snapshot, false, async () => {}).slice(0, 1);
  next[0].label = "Next state action";
  pills.update(next);
  assert.equal(entries.size, 1);
  assert.equal(entries.get("workflow-action-0")?.label, "Next state action");
  pills.update([]);
  assert.equal(entries.size, 0);
  pills.update(next);
  pills.dispose();
  pills.dispose();
  pills.update(next);
  assert.equal(entries.size, 0);
  assert.equal(additions, 3);
  assert.equal(removals, 3);
});
