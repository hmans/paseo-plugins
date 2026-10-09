import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Conditions, evaluate, runCheck } from "./conditions";
import { parseWorkflow, requireReady, WorkflowStore } from "./store";
import { builtinConditions, type ConditionExpression, type ConditionResult } from "../shared/workflow";

const definition = (when: ConditionExpression = "git.dirty", conditions = {}) => JSON.stringify({
  initial: "working", conditions,
  states: { working: { actions: [{ label: "Act", prompt: "Do the work", when }], transitions: [] } },
});

test("condition schemas reject unknown references, reserved names, and invalid expressions", () => {
  assert.doesNotThrow(() => parseWorkflow(definition()));
  assert.throws(() => parseWorkflow(definition("typo")), /Unknown condition/);
  assert.throws(() => parseWorkflow(definition("git.dirty", { "git.dirty": { command: ["true"] } })));
  assert.throws(() => parseWorkflow(definition({ all: [] })));
  assert.throws(() => parseWorkflow(definition("project.test", { "project.test": { command: [], timeout: "no" } })));
  assert.throws(() => parseWorkflow(definition("project.test", { "project.test": { command: ["node", "bad\0argument"] } })), /null bytes/);
});

test("all, any, and not use three-valued logic and short circuit", async () => {
  const results: Record<string, ConditionResult> = { yes: { value: "true" }, no: { value: "false" }, unknown: { value: "unknown", message: "Offline" } };
  const resolve = async (name: string) => { assert.notEqual(name, "never"); return results[name]; };
  assert.equal((await evaluate({ not: "unknown" }, resolve)).value, "unknown");
  assert.equal((await evaluate({ not: "no" }, resolve)).value, "true");
  assert.equal((await evaluate({ all: ["unknown", "no", "never"] }, resolve)).value, "false");
  assert.equal((await evaluate({ any: ["unknown", "yes", "never"] }, resolve)).value, "true");
  assert.equal((await evaluate({ all: ["yes", "unknown"] }, resolve)).message, "Offline");
});

test("Git conditions observe untracked, staged, clean, and non-repository workspaces", async t => {
  const root = await mkdtemp(join(tmpdir(), "workflow-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "repo");
  await mkdir(join(cwd, ".paseo"), { recursive: true });
  await writeFile(join(cwd, ".paseo/flowstate.yml"), definition());
  execFileSync("git", ["init", "-q", cwd]);
  const store = new WorkflowStore(join(root, "data"));
  const snapshot = requireReady(await store.inspect("one", cwd));
  const conditions = new Conditions(store.directory);
  const read = async (path = cwd) => (await conditions.results(snapshot, path, true)).actionConditions.Act.value;
  assert.deepEqual(builtinConditions, ["git.dirty", "github.pr.merged"]);
  assert.equal(await read(), "true");
  execFileSync("git", ["add", "."], { cwd });
  assert.equal(await read(), "true");
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd });
  assert.equal(await read(), "false");
  await writeFile(join(cwd, ".paseo/flowstate.yml"), definition() + "\n");
  assert.equal(await read(), "true");
  assert.equal(await read(root), "unknown");
});

test("custom checks require trust, share cached work, recheck on dispatch, and invalidate trust", async t => {
  const root = await mkdtemp(join(tmpdir(), "workflow-commands-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".paseo"));
  const counter = join(root, "counter");
  const script = `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x'); setTimeout(() => process.exit(0), 40)`;
  const config = { "project.check": { command: [process.execPath, "-e", script], interval: "60s", timeout: "2s" } };
  await writeFile(join(root, ".paseo/flowstate.yml"), definition("project.check", config));
  const store = new WorkflowStore(join(root, "data"));
  const snapshot = requireReady(await store.inspect("one", root));
  const conditions = new Conditions(store.directory);
  assert.equal((await conditions.results(snapshot, root)).actionConditions.Act.value, "unknown");
  await assert.rejects(readFile(counter));
  await conditions.trust(snapshot, root, true);
  const results = await Promise.all([conditions.results(snapshot, root), conditions.results(snapshot, root)]);
  assert.ok(results.every(result => result.actionConditions.Act.value === "true"));
  assert.equal(await readFile(counter, "utf8"), "x");
  await conditions.results(snapshot, root);
  assert.equal(await readFile(counter, "utf8"), "x");
  await conditions.results(snapshot, root, true, "Act");
  assert.equal(await readFile(counter, "utf8"), "xx");
  assert.equal(await new Conditions(store.directory).trusted(snapshot, root), true);
  assert.equal(await conditions.trusted({ ...snapshot, workspaceId: "two" }, root), false);
  const changed = { ...snapshot, workflow: parseWorkflow(definition("project.check", { "project.check": { ...config["project.check"], command: ["different"] } })) };
  assert.equal(await conditions.trusted(changed, root), false);
  await conditions.trust(snapshot, root, false);
  assert.equal((await conditions.results(snapshot, root, true)).actionConditions.Act.value, "unknown");
  assert.equal(await readFile(counter, "utf8"), "xx");
});

test("merged PR checks read each time and fail closed when workspace data is unavailable", async t => {
  const root = await mkdtemp(join(tmpdir(), "workflow-pr-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".paseo"));
  await writeFile(join(root, ".paseo/flowstate.yml"), definition("github.pr.merged"));
  const store = new WorkflowStore(join(root, "data"));
  const snapshot = requireReady(await store.inspect("one", root));
  const conditions = new Conditions(store.directory);
  t.after(() => conditions.close());
  const read = async (reader?: () => Promise<boolean>) => (await conditions.results(snapshot, root, false, undefined, reader)).actionConditions.Act;
  assert.equal((await read(async () => true)).value, "true");
  assert.equal((await read(async () => false)).value, "false");
  assert.equal((await read(async () => { throw new Error("Offline"); })).value, "unknown");
  assert.equal((await read()).value, "unknown");
});

test("command failures, timeout, output limits, and exit codes are bounded", async () => {
  const run = (code: string, timeout = 2000) => runCheck([process.execPath, "-e", code], tmpdir(), timeout);
  assert.equal((await run("process.exit(1)")).code, 1);
  assert.equal((await run("process.exit(2)")).code, 2);
  assert.match((await run("setInterval(() => {}, 1000)", 50)).error!, /timed out/);
  assert.match((await run("process.stdout.write('x'.repeat(100000))")).error!, /64 KiB/);
  assert.match((await runCheck(["/nonexistent/workflow-check"], tmpdir(), 1000)).error!, /Cannot run/);
  const controller = new AbortController();
  const pending = runCheck([process.execPath, "-e", "setInterval(() => {}, 1000)"], tmpdir(), 10000, controller.signal);
  controller.abort();
  assert.match((await pending).error!, /stopped/);
});

test("custom exit codes map to false and unknown without exposing output", async t => {
  const root = await mkdtemp(join(tmpdir(), "workflow-exits-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".paseo"));
  const store = new WorkflowStore(join(root, "data"));
  const conditions = new Conditions(store.directory);
  for (const [code, result] of [[1, "false"], [2, "unknown"]] as const) {
    await writeFile(join(root, ".paseo/flowstate.yml"), definition("project.check", {
      "project.check": { command: [process.execPath, "-e", `console.error('private output'); process.exit(${code})`] },
    }));
    const snapshot = requireReady(await store.inspect("one", root));
    await conditions.trust(snapshot, root, true);
    const checked = (await conditions.results(snapshot, root, true)).actionConditions.Act;
    assert.equal(checked.value, result);
    assert.ok(!checked.message?.includes("private output"));
  }
});
