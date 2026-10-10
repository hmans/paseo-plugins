import { evaluatePullRequest, type PullRequestRuntime } from "./pr-conditions";
import { prConditions } from "../shared/pr-conditions";
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
  assert.deepEqual(builtinConditions, ["git.dirty", ...prConditions]);
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
  const read = async (reader?: () => Promise<PullRequestRuntime>) => (await conditions.results(snapshot, root, false, undefined, reader)).actionConditions.Act;
  assert.equal((await read(async () => ({ pullRequest: { state: "MERGED", isMerged: true } }))).value, "true");
  assert.equal((await read(async () => ({ pullRequest: null }))).value, "false");
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

test("PR conditions distinguish every SDK status and preserve unknown data", () => {
  const base = { state: "OPEN", isMerged: false };
  const check = (name: string, patch = {}) => evaluatePullRequest(`github.pr.${name}`, { pullRequest: { ...base, ...patch } }).value;
  assert.equal(check("exists"), "true");
  assert.equal(check("open"), "true");
  assert.equal(check("closed"), "false");
  assert.equal(check("closed", { state: "CLOSED" }), "true");
  assert.equal(check("closed", { state: "CLOSED", isMerged: true }), "false");
  assert.equal(check("merged", { state: "MERGED", isMerged: true }), "true");
  for (const isDraft of [true, false]) assert.equal(check("draft", { isDraft }), String(isDraft));
  assert.equal(check("draft"), "unknown");
  for (const mergeable of ["MERGEABLE", "CONFLICTING", "UNKNOWN"] as const) {
    assert.equal(check("mergeable", { mergeable }), mergeable === "UNKNOWN" ? "unknown" : String(mergeable === "MERGEABLE"));
    assert.equal(check("conflicting", { mergeable }), mergeable === "UNKNOWN" ? "unknown" : String(mergeable === "CONFLICTING"));
  }
  for (const status of ["success", "pending", "failure", "none"]) {
    for (const target of ["success", "pending", "failure", "none"]) {
      assert.equal(check(`checks.${target}`, { checksStatus: status }), String(status === target));
    }
  }
  for (const status of ["approved", "pending", "changes_requested"]) {
    for (const target of ["approved", "pending", "changes_requested"]) {
      assert.equal(check(`review.${target}`, { reviewDecision: status }), String(status === target));
    }
  }
  assert.equal(check("checks.success"), "unknown");
  assert.equal(check("review.approved", { reviewDecision: null }), "unknown");
  for (const name of prConditions) {
    assert.equal(evaluatePullRequest(name, { pullRequest: null }).value, "false");
    for (const runtime of [undefined, null, {}, { featuresEnabled: false, pullRequest: base }, { error: { message: "offline" }, pullRequest: base }]) {
      assert.equal(evaluatePullRequest(name, runtime).value, "unknown");
    }
  }
});

test("PR composites use one snapshot per evaluation and re-read on dispatch", async t => {
  const root = await mkdtemp(join(tmpdir(), "workflow-pr-composite-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".paseo"));
  const when = { all: ["github.pr.open", { not: "github.pr.draft" }, "github.pr.mergeable", "github.pr.checks.success", "github.pr.review.approved"] };
  await writeFile(join(root, ".paseo/flowstate.yml"), definition(when));
  const store = new WorkflowStore(join(root, "data"));
  const snapshot = requireReady(await store.inspect("one", root));
  const conditions = new Conditions(store.directory);
  t.after(() => conditions.close());
  let runtime: PullRequestRuntime = { pullRequest: { state: "OPEN", isMerged: false, isDraft: false, mergeable: "MERGEABLE", checksStatus: "success", reviewDecision: "approved" } };
  let reads = 0;
  const reader = async () => { reads++; return runtime; };
  assert.equal((await conditions.results(snapshot, root, false, undefined, reader)).actionConditions.Act.value, "true");
  assert.equal(reads, 1);
  runtime.pullRequest!.checksStatus = "failure";
  assert.equal((await conditions.results(snapshot, root, true, "Act", reader)).actionConditions.Act.value, "false");
  assert.equal(reads, 2);
  runtime = { pullRequest: null };
  assert.equal((await conditions.results(snapshot, root, false, undefined, reader)).actionConditions.Act.value, "false");
  assert.equal(reads, 3);
});

test("repository workflow validates and gates merging on conservative PR checks", async () => {
  const workflow = parseWorkflow(await readFile(new URL("../../.paseo/flowstate.yml", import.meta.url), "utf8"));
  const merge = workflow.states.done.actions.find(action => action.label === "Merge PR")!;
  assert.ok(merge.when);
  const ready: PullRequestRuntime = { pullRequest: { state: "OPEN", isMerged: false, isDraft: false, mergeable: "MERGEABLE", checksStatus: "success", reviewDecision: "approved" } };
  assert.equal((await evaluate(merge.when!, async name => evaluatePullRequest(name, ready))).value, "true");
  for (const patch of [{ isDraft: true }, { mergeable: "CONFLICTING" as const }, { checksStatus: "pending" as const }, { checksStatus: "none" as const }, { reviewDecision: "changes_requested" as const }]) {
    assert.equal((await evaluate(merge.when!, async name => evaluatePullRequest(name, { pullRequest: { ...ready.pullRequest!, ...patch } }))).value, "false");
  }
});
