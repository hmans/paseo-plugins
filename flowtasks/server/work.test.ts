import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { taskPrompt } from "../shared/work";
import { TaskStore } from "./store";
import { WorkspaceBindings } from "./bindings";
import { taskDispatcher } from "./work";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "flowtasks-work-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new TaskStore(directory);
  const outline = await store.change("workspace", 0, { type: "create", parentId: null, text: "Build the button" });
  const bindings = await WorkspaceBindings.load(store);
  const token = await bindings.issue(directory);
  await bindings.bind(token, "agent", "workspace", directory);
  const sent: string[] = [];
  const current = { agent: { workspaceId: "workspace", status: "idle", archivedAt: null as string | null } };
  const agent = { refresh: async () => current, send: async (prompt: string) => { sent.push(prompt); } };
  const context = { paseo: {
    workspaces: { ref: () => ({ refresh: async () => ({}) }) },
    agents: { ref: () => agent },
  } } as unknown as PluginHandlerContext;
  return { store, bindings, sent, current, agent, context, dispatch: taskDispatcher(store, async () => bindings),
    input: { workspaceId: "workspace", agentId: "agent", taskId: outline.items[0].id, expectedRevision: outline.revision } };
}

test("prompt identifies the selected task and leaves context retrieval to Flowtasks", () => {
  const item = (id: string, parentId: string | null, completed = false) => ({ id, parentId, completed, text: id });
  const prompt = taskPrompt({ revision: 3, items: [item("parent", null), item("selected", "parent", true), item("other", "parent"), item("child", "selected")] }, "selected");
  assert.match(prompt, /Work on this Flowtasks task: selected/);
  assert.match(prompt, /Task ID: selected/);
  assert.match(prompt, /flowtasks_get/);
  assert.match(prompt, /flowtasks_change/);
  assert.doesNotMatch(prompt, /parent|other|child|\{/);
  assert.throws(() => taskPrompt({ revision: 0, items: [] }, "missing"), /deleted/);
  assert.throws(() => taskPrompt({ revision: 0, items: [{ ...item("blank", null), text: "  " }] }, "blank"), /description/);
});

test("dispatch sends the saved task and leaves completion unchanged", async t => {
  const f = await fixture(t);
  const before = await f.store.read("workspace");
  assert.deepEqual(await f.dispatch(f.input, f.context), { sent: true });
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /Build the button/);
  assert.match(f.sent[0], /flowtasks_get/);
  assert.deepEqual(await f.store.read("workspace"), before);
});

test("dispatch rejects stale revisions, missing tasks, and agents without workspace tools", async t => {
  const f = await fixture(t);
  await assert.rejects(f.dispatch({ ...f.input, expectedRevision: 0 }, f.context), /tasks changed/);
  await assert.rejects(f.dispatch({ ...f.input, taskId: "deleted" }, f.context), /deleted/);
  await assert.rejects(f.dispatch({ ...f.input, agentId: "old-agent" }, f.context), /load the Flowtasks tools/);
  await assert.rejects(f.dispatch({ ...f.input, workspaceId: "other" }, f.context), /load the Flowtasks tools/);
  assert.equal(f.sent.length, 0);
});

test("dispatch rechecks workspace, archive state, and readiness", async t => {
  const f = await fixture(t);
  f.current.agent.workspaceId = "other";
  await assert.rejects(f.dispatch(f.input, f.context), /no longer available/);
  f.current.agent.workspaceId = "workspace";
  f.current.agent.archivedAt = "now";
  await assert.rejects(f.dispatch(f.input, f.context), /no longer available/);
  f.current.agent.archivedAt = null;
  for (const status of ["running", "initializing", "closed", "error"]) {
    f.current.agent.status = status;
    await assert.rejects(f.dispatch(f.input, f.context), /idle agent/);
  }
  assert.equal(f.sent.length, 0);
});

test("simultaneous dispatches cannot send twice; a failed send releases the guard", async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.dispatch(f.input, f.context), f.dispatch(f.input, f.context)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(f.sent.length, 1);
  f.agent.send = async () => { throw new Error("Disconnected"); };
  await assert.rejects(f.dispatch(f.input, f.context), /Disconnected/);
  f.agent.send = async (prompt: string) => { f.sent.push(prompt); };
  await f.dispatch(f.input, f.context);
  assert.equal(f.sent.length, 2);
});

test("large branches do not inflate the prompt", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 7; i++) {
    const outline = await f.store.change("workspace", f.input.expectedRevision, { type: "create", parentId: f.input.taskId, text: "x".repeat(10000) });
    f.input.expectedRevision = outline.revision;
  }
  await f.dispatch(f.input, f.context);
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0].length < 300);
});
