import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { startBridge } from "./bridge";
import { assertCurrent, parseWorkflow, requireReady, WorkflowStore } from "./store";
import type { ReadyWorkflow } from "../shared/workflow";

const fixture = `initial: planning
states:
  planning:
    actions:
      - label: Plan
        prompt: Write a plan.
    transitions: [implementing]
  implementing:
    actions:
      - label: Implement
        prompt: Implement the plan.
    transitions: [planning]
`;

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "paseo-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  await mkdir(join(cwd, ".paseo"), { recursive: true });
  const file = join(cwd, ".paseo", "workflow.yaml");
  await writeFile(file, fixture);
  const store = new WorkflowStore(join(root, "data"));
  return { root, cwd, file, store };
}

function expected(snapshot: ReadyWorkflow, target: string) {
  return { target, expectedState: snapshot.state, expectedRevision: snapshot.revision, definitionVersion: snapshot.definitionVersion };
}

test("validates YAML, state references, nonempty actions, and unique labels", () => {
  assert.equal(parseWorkflow(fixture).initial, "planning");
  assert.throws(() => parseWorkflow(fixture.replace("initial: planning", "initial: unknown")), /Initial state/);
  assert.throws(() => parseWorkflow(fixture.replace("transitions: [implementing]", "transitions: [unknown]")), /Unknown state/);
  assert.throws(() => parseWorkflow(fixture.replace("Write a plan.", '""')), /Too small/);
  assert.throws(() => parseWorkflow(fixture.replace("    transitions: [implementing]", "      - label: Plan\n        prompt: Duplicate\n    transitions: [implementing]")), /unique/);
  assert.throws(() => parseWorkflow("initial: planning\ninitial: other"), /unique/);
  assert.throws(() => parseWorkflow("initial: &x planning\nstates: *x"), /alias/i);
  assert.throws(() => parseWorkflow(fixture + "unknown: true\n"), /Unrecognized/);
});

test("initializes once, isolates workspaces, and preserves state across a new store", async t => {
  const { cwd, store } = await setup(t);
  const initial = requireReady(await store.inspect("one", cwd));
  const again = requireReady(await store.inspect("one", cwd));
  assert.equal(initial.revision, again.revision);
  await store.transition("one", cwd, expected(initial, "implementing"));
  const restarted = new WorkflowStore(store.directory);
  assert.equal(requireReady(await restarted.inspect("one", cwd)).state, "implementing");
  assert.equal(requireReady(await restarted.inspect("two", cwd)).state, "planning");
});

test("rejects illegal, concurrent, stale, and ABA transitions without losing state", async t => {
  const { cwd, store } = await setup(t);
  const initial = requireReady(await store.inspect("one", cwd));
  await assert.rejects(store.transition("one", cwd, expected(initial, "unknown")), /not allowed/);
  const results = await Promise.allSettled([
    store.transition("one", cwd, expected(initial, "implementing")),
    store.transition("one", cwd, expected(initial, "implementing")),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const next = requireReady(await store.inspect("one", cwd));
  await store.transition("one", cwd, expected(next, "planning"));
  await assert.rejects(store.transition("one", cwd, expected(initial, "implementing")), /workflow changed/);
  assert.equal(requireReady(await store.inspect("one", cwd)).state, "planning");
});

test("detects live definition edits and preserves state when YAML is missing or invalid", async t => {
  const { cwd, store, file } = await setup(t);
  const initial = requireReady(await store.inspect("one", cwd));
  await writeFile(file, fixture.replace("Write a plan.", "Write a better plan."));
  await assert.rejects(store.transition("one", cwd, expected(initial, "implementing")), /workflow changed/);
  const changed = requireReady(await store.inspect("one", cwd));
  assert.throws(() => assertCurrent(changed, expected(initial, "implementing")), /workflow changed/);
  await writeFile(file, "states: [broken");
  assert.equal((await store.inspect("one", cwd)).status, "error");
  await rm(file);
  assert.equal((await store.inspect("one", cwd)).status, "missing");
  await writeFile(file, fixture);
  assert.equal(requireReady(await store.inspect("one", cwd)).revision, initial.revision);
});

test("does not silently reset removed states or corrupt saved data", async t => {
  const { cwd, store, file } = await setup(t);
  const initial = requireReady(await store.inspect("one", cwd));
  await store.transition("one", cwd, expected(initial, "implementing"));
  await writeFile(file, fixture.replaceAll("implementing", "building"));
  const snapshot = await store.inspect("one", cwd);
  assert.equal(snapshot.status, "error");
  if (snapshot.status === "error") assert.match(snapshot.message, /Saved state "implementing"/);
  const [stateFile] = await readdir(store.directory);
  await writeFile(join(store.directory, stateFile), "broken json");
  await writeFile(file, fixture);
  assert.equal((await store.inspect("one", cwd)).status, "error");
  assert.equal(await readFile(join(store.directory, stateFile), "utf8"), "broken json");
});

test("command bridge enforces bindings and transitions, and existing commands survive reload", async t => {
  const { cwd, store } = await setup(t);
  let bridge = await startBridge(store);
  try {
    const binding = bridge.binding("one", cwd);
    const run = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, [bridge.cliPath, binding, ...args])).stdout);
    const initial = await run("get") as ReadyWorkflow;
    const response = await fetch(bridge.url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ binding: `${binding}x`, command: "get" }),
    });
    assert.equal(response.status, 400);
    const originRequest = await fetch(bridge.url, { method: "POST", headers: { Origin: "https://example.com" }, body: "{}" });
    assert.equal(originRequest.status, 403);
    await assert.rejects(run("transition", "unknown", initial.state, initial.revision, initial.definitionVersion), /not allowed/);
    const next = await run("transition", "implementing", initial.state, initial.revision, initial.definitionVersion);
    assert.equal(next.state, "implementing");
    await bridge.close();
    bridge = await startBridge(new WorkflowStore(store.directory));
    assert.equal((await run("get")).state, "implementing");
    const command = bridge.instructions(next, cwd).split("\n").find(line => line.startsWith("Read current state: "))!.slice("Read current state: ".length);
    const shellResult = await promisify(execFile)("/bin/sh", ["-c", command]);
    assert.equal(JSON.parse(shellResult.stdout).state, "implementing");
  } finally { await bridge.close(); }
});

test("action RPC sends only to the selected agent and rejects busy or stale requests", async t => {
  const { cwd, store } = await setup(t);
  const previous = process.env.PASEO_WORKFLOW_DATA_DIR;
  process.env.PASEO_WORKFLOW_DATA_DIR = store.directory;
  const handlers = new Map<string, (input: any, context: any) => Promise<any>>();
  const cleanup = contribute({ handle: (contract: { name: string }, handler: any) => handlers.set(contract.name, handler) } as unknown as PluginServerContext);
  let status = "idle";
  let workspaceId = "one";
  const sent: { agentId: string; text: string }[] = [];
  const context = { paseo: {
    workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: cwd }) }) },
    agents: { ref: (agentId: string) => ({ refresh: async () => ({ agent: { workspaceId, status } }), send: async (text: string) => { sent.push({ agentId, text }); } }) },
  } };
  try {
    const snapshot = await handlers.get("workflow.get")!({ workspaceId: "one" }, context) as ReadyWorkflow;
    const input = { workspaceId: "one", agentId: "selected-agent", action: "Plan", ...expected(snapshot, "implementing") };
    await handlers.get("workflow.run-action")!(input, context);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].agentId, "selected-agent");
    assert.match(sent[0].text, /^Write a plan\.\n\nWorkspace workflow instructions:/);
    assert.equal(requireReady(await store.inspect("one", cwd)).state, "planning");
    status = "running";
    await assert.rejects(handlers.get("workflow.run-action")!(input, context), /Wait for this agent/);
    status = "idle";
    workspaceId = "other";
    await assert.rejects(handlers.get("workflow.run-action")!(input, context), /not in this workspace/);
    workspaceId = "one";
    await store.transition("one", cwd, expected(snapshot, "implementing"));
    await assert.rejects(handlers.get("workflow.run-action")!(input, context), /workflow changed/);
    assert.equal(sent.length, 1);
  } finally {
    await cleanup();
    if (previous === undefined) delete process.env.PASEO_WORKFLOW_DATA_DIR;
    else process.env.PASEO_WORKFLOW_DATA_DIR = previous;
  }
});
