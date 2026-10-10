import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startWorkflowMcp } from "./mcp";
import { MCP_NAME, TOKEN_ENV, registerMcpInjection } from "./injection";
import { assertCurrent, parseWorkflow, requireReady, WorkflowStore } from "./store";
import { parseActionCard } from "../shared/action-card";
import { exampleWorkflow, setupPrompt } from "../shared/setup";
import { readySchema, snapshotSchema, validationSchema, type ReadyWorkflow } from "../shared/workflow";

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
  const file = join(cwd, ".paseo", "flowstate.yml");
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

test("accepts optional state and action icons and rejects invalid name formats", () => {
  const configured = fixture.replace("  planning:\n", "  planning:\n    icon: NotebookPen\n").replace("      - label: Plan", "      - label: Plan\n        icon: GitCommitHorizontal");
  const workflow = parseWorkflow(configured);
  assert.equal(workflow.states.planning.icon, "NotebookPen");
  assert.equal(workflow.states.planning.actions[0].icon, "GitCommitHorizontal");
  assert.equal(parseWorkflow(fixture).states.planning.icon, undefined);
  for (const invalid of ['""', '"git-commit"', '"/tmp/icon.svg"', '"<svg>"']) {
    assert.throws(() => parseWorkflow(configured.replace("GitCommitHorizontal", invalid)), /PascalCase/);
    assert.throws(() => parseWorkflow(configured.replace("NotebookPen", invalid)), /PascalCase/);
  }
});

test("actions require exactly one supported operation or prompt", () => {
  const workflow = (action: unknown) => JSON.stringify({ initial: "done", states: { done: { actions: [action] } } });
  assert.doesNotThrow(() => parseWorkflow(workflow({ label: "Archive", operation: "workspace.archive" })));
  for (const action of [
    { label: "Archive" },
    { label: "Archive", operation: "workspace.delete" },
    { label: "Archive", operation: "workspace.archive", prompt: "Archive" },
  ]) assert.throws(() => parseWorkflow(workflow(action)));
});

test("validates common actions, collisions, and states without local actions", () => {
  const common = { label: "Commit", prompt: "Commit the changes.", when: "git.dirty" };
  const workflow = { initial: "one", actions: [common], states: { one: {}, two: { actions: [] } } };
  assert.equal(parseWorkflow(JSON.stringify(workflow)).states.one.actions.length, 0);
  assert.equal(parseWorkflow(JSON.stringify(workflow)).actions.length, 1);
  assert.throws(() => parseWorkflow(JSON.stringify({ ...workflow, actions: [common, common] })), /unique/);
  assert.throws(() => parseWorkflow(JSON.stringify({ ...workflow, states: { one: { actions: [common] } } })), /unique/);
  assert.throws(() => parseWorkflow(JSON.stringify({ ...workflow, actions: [{ ...common, when: "unknown" }] })), /Unknown condition/);
  assert.deepEqual(parseWorkflow(fixture).actions, []);
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

test("MCP discovers tools, scopes calls, rejects stale transitions, and reconnects after reload", async t => {
  const { cwd, store } = await setup(t);
  const transitions: string[] = [];
  let service = await startWorkflowMcp(store, async (scope, _input, snapshot) => { transitions.push(`${scope.agentId}:${snapshot.state}`); });
  const client = new Client({ name: "workflow-test", version: "1.0.0" });
  try {
    const token = await service.bindings.issue(cwd);
    assert.equal((await fetch(service.url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" })).status, 403);
    await service.bindings.bind(token, "agent-one", "one", cwd);
    await assert.rejects(service.bindings.bind(token, "agent-two", "two", cwd), /another agent or workspace/);
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ["workflow_get_state", "workflow_transition", "workflow_validate"]);
    const read = async () => readySchema.parse((await client.callTool({ name: "workflow_get_state", arguments: {} })).structuredContent);
    const initial = await read();
    assert.equal(initial.workspaceId, "one");
    const invalid = await client.callTool({ name: "workflow_transition", arguments: expected(initial, "unknown") });
    assert.equal(invalid.isError, true);
    const crossWorkspace = await client.callTool({ name: "workflow_transition", arguments: { ...expected(initial, "implementing"), workspaceId: "two" } });
    assert.equal(crossWorkspace.isError, true);
    const next = readySchema.parse((await client.callTool({ name: "workflow_transition", arguments: expected(initial, "implementing") })).structuredContent);
    assert.equal(next.state, "implementing");
    assert.equal((await client.callTool({ name: "workflow_transition", arguments: expected(initial, "implementing") })).isError, true);
    assert.deepEqual(transitions, ["agent-one:implementing"]);
    assert.equal(requireReady(await store.inspect("two", cwd)).state, "planning");
    assert.equal((await fetch(service.url, { method: "POST", body: "{}" })).status, 403);
    assert.equal((await fetch(service.url, { method: "POST", headers: { Origin: "https://example.com", Authorization: `Bearer ${token}` }, body: "{}" })).status, 403);
    const originalUrl = service.url;
    await service.close();
    service = await startWorkflowMcp(new WorkflowStore(store.directory));
    assert.equal(service.url, originalUrl);
    assert.equal((await read()).state, "implementing");
    assert.equal(service.bindings.hasAgent("agent-one", "one"), true);
  } finally { await client.close(); await service.close(); }
});

test("injection preserves configuration, binds actual workspace IDs, and supports resume", async t => {
  const { cwd, store, root } = await setup(t);
  const service = await startWorkflowMcp(store);
  const hooks = new Map<string, (input: any) => Promise<any>>();
  registerMcpInjection({ before: (name: string, handler: any) => { hooks.set(name, handler); return () => {}; } } as unknown as PluginServerContext, Promise.resolve(service));
  try {
    const existingMcp = { type: "http", url: "https://example.com/mcp" };
    const request = { config: { provider: "codex", cwd, title: "Keep title", systemPrompt: "Keep existing instructions.", mcpServers: { existing: existingMcp }, providerOptions: { keep: true } }, env: { KEEP: "yes" } };
    const injected = await hooks.get("agent.create")!({ request });
    assert.ok(injected.config.systemPrompt.startsWith(request.config.systemPrompt + "\n\n"));
    assert.match(injected.config.systemPrompt, /workflow_get_state/);
    assert.equal(request.config.systemPrompt, "Keep existing instructions.");
    const withoutPrompt = await hooks.get("agent.create")!({ request: { config: { provider: "codex", cwd } } });
    assert.ok(withoutPrompt.config.systemPrompt.startsWith("Flowstate"));
    assert.deepEqual(injected.config.mcpServers.existing, existingMcp);
    assert.deepEqual(injected.config.providerOptions, request.config.providerOptions);
    assert.equal(injected.config.cwd, cwd);
    assert.equal(injected.env.KEEP, "yes");
    const mcp = injected.config.mcpServers[MCP_NAME];
    assert.equal(mcp.type, "http");
    assert.equal(mcp.url, service.url);
    assert.equal(mcp.headers.Authorization, `Bearer ${injected.env[TOKEN_ENV]}`);
    assert.equal(service.bindings.resolve(injected.env[TOKEN_ENV]), null);
    const opened = await hooks.get("agent.session_open")!({ request: { agentId: "new-agent", workspaceId: "one", cwd, purpose: "interactive", reason: "create", env: injected.env } });
    assert.equal(opened.env[TOKEN_ENV], undefined);
    assert.equal(opened.env.KEEP, "yes");
    assert.equal(service.bindings.hasAgent("new-agent", "one"), true);
    await hooks.get("agent.session_open")!({ request: { agentId: "new-agent", workspaceId: "one", cwd, purpose: "interactive", reason: "resume", env: {} } });
    assert.equal(service.bindings.hasAgent("new-agent", "one"), true);
    await assert.rejects(hooks.get("agent.session_open")!({ request: { agentId: "new-agent", workspaceId: "two", cwd, purpose: "interactive", env: {} } }), /cannot move/);
    const second = await hooks.get("agent.create")!({ request });
    await hooks.get("agent.session_open")!({ request: { agentId: "second-agent", workspaceId: "two", cwd, purpose: "interactive", env: second.env } });
    assert.equal(service.bindings.resolve(second.env[TOKEN_ENV])?.workspaceId, "two");
    assert.equal(service.bindings.resolve(injected.env[TOKEN_ENV])?.workspaceId, "one");
    assert.ok((await hooks.get("agent.create")!({ request: { config: { cwd: root }, env: {} } })).config.mcpServers[MCP_NAME]);
    await assert.rejects(hooks.get("agent.create")!({ request: { config: { ...request.config, mcpServers: { [MCP_NAME]: existingMcp } } } }), /unrelated MCP server/);
    const cloned = await hooks.get("agent.create")!({ request: injected });
    assert.notEqual(cloned.env[TOKEN_ENV], injected.env[TOKEN_ENV]);
    assert.equal(cloned.config.systemPrompt, injected.config.systemPrompt);
  } finally { await service.close(); }
});

test("manual transitions validate state and ownership and publish only committed changes", async t => {
  const { cwd, store } = await setup(t);
  const previous = process.env.PASEO_FLOWSTATE_DATA_DIR;
  process.env.PASEO_FLOWSTATE_DATA_DIR = store.directory;
  const handlers = new Map<string, (input: any, context: any) => Promise<any>>();
  const hooks = new Map<string, (input: any, context: any) => Promise<any>>();
  const cleanup = contribute({
    handle: (contract: { name: string }, handler: any) => handlers.set(contract.name, handler),
    before: (name: string, handler: any) => { hooks.set(name, handler); return () => {}; }, on: () => () => {},
  } as unknown as PluginServerContext);
  let workspaceId = "one";
  let failPublication = false;
  const rows: any[] = [];
  const context = { paseo: {
    workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: cwd }) }) },
    agents: { ref: (id: string) => ({
      refresh: async () => ({ agent: { workspaceId, status: "running" } }),
      timeline: { append: async (row: any) => {
        if (failPublication) throw new Error("Timeline unavailable");
        rows.push({ id, row });
      } },
    }) },
  } };
  try {
    const initial = requireReady(await store.inspect("one", cwd));
    const input = { workspaceId: "one", agentId: "selected", ...expected(initial, "implementing") };
    const transition = handlers.get("workflow.transition")!;
    workspaceId = "other";
    await assert.rejects(transition(input, context), /not in this workspace/);
    workspaceId = "one";
    await assert.rejects(transition({ ...input, target: "unknown" }, context), /not allowed/);
    assert.equal(rows.length, 0);
    const next = await transition(input, context);
    assert.equal(next.state, "implementing");
    assert.equal(rows[0].id, "selected");
    assert.equal(rows[0].row.id, `transition-${next.revision}`);
    assert.deepEqual(rows[0].row.data, { from: "planning", to: "implementing", actor: "user" });
    await assert.rejects(transition(input, context), /workflow changed/);
    assert.equal(rows.length, 1);
    failPublication = true;
    const originalError = console.error;
    const errors: unknown[] = [];
    console.error = (...args) => { errors.push(args); };
    try {
      const restored = await transition({ ...input, ...expected(next, "planning") }, context);
      assert.equal(restored.state, "planning");
      assert.equal(errors.length, 1);
    } finally { console.error = originalError; }
    assert.equal(requireReady(await store.inspect("one", cwd)).state, "planning");
    failPublication = false;
    const injected = await hooks.get("agent.create")!({ request: { config: { provider: "codex", cwd } } }, context);
    await hooks.get("agent.session_open")!({ request: {
      agentId: "selected", workspaceId: "one", cwd, purpose: "interactive", env: injected.env,
    } }, context);
    const client = new Client({ name: "timeline-test", version: "1.0.0" });
    try {
      const config = injected.config.mcpServers[MCP_NAME];
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
      const current = requireReady(await store.inspect("one", cwd));
      const response = await client.callTool({ name: "workflow_transition", arguments: expected(current, "implementing") });
      assert.notEqual(response.isError, true);
      assert.equal(rows.length, 2);
      assert.equal(rows[1].row.data.actor, "agent");
      assert.equal(rows[1].id, "selected");
    } finally { await client.close(); }
  } finally {
    await cleanup();
    if (previous === undefined) delete process.env.PASEO_FLOWSTATE_DATA_DIR;
    else process.env.PASEO_FLOWSTATE_DATA_DIR = previous;
  }
});

test("action RPC sends only to the selected agent and rejects busy or stale requests", async t => {
  const { cwd, store, file } = await setup(t);
  const previous = process.env.PASEO_FLOWSTATE_DATA_DIR;
  process.env.PASEO_FLOWSTATE_DATA_DIR = store.directory;
  const handlers = new Map<string, (input: any, context: any) => Promise<any>>();
  const hooks = new Map<string, (input: any) => Promise<any>>();
  const cleanup = contribute({
    on: () => () => {},
    handle: (contract: { name: string }, handler: any) => handlers.set(contract.name, handler),
    before: (name: string, handler: any) => { hooks.set(name, handler); return () => {}; },
  } as unknown as PluginServerContext);
  let status = "idle";
  let workspaceId = "one";
  const sent: { agentId: string; text: string }[] = [];
  const context = { paseo: {
    workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: cwd }) }) },
    agents: { ref: (agentId: string) => ({ refresh: async () => ({ agent: { workspaceId, status } }), send: async (text: string) => { sent.push({ agentId, text }); } }) },
  } };
  try {
    const before = await handlers.get("workflow.get")!({ workspaceId: "one", agentId: "selected-agent" }, context) as ReadyWorkflow;
    assert.equal(before.toolsReady, false);
    const initialInput = { workspaceId: "one", agentId: "selected-agent", action: "Plan", ...expected(before, "implementing") };
    await assert.rejects(handlers.get("workflow.run-action")!(initialInput, context), /Create a new agent/);
    const injected = await hooks.get("agent.create")!({ request: { config: { provider: "codex", cwd } } });
    await hooks.get("agent.session_open")!({ request: { agentId: "selected-agent", workspaceId: "one", cwd, purpose: "interactive", env: injected.env } });
    const snapshot = await handlers.get("workflow.get")!({ workspaceId: "one", agentId: "selected-agent" }, context) as ReadyWorkflow;
    assert.equal(snapshot.toolsReady, true);
    const input = { workspaceId: "one", agentId: "selected-agent", action: "Plan", ...expected(snapshot, "implementing") };
    await handlers.get("workflow.run-action")!(input, context);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].agentId, "selected-agent");
    assert.deepEqual(parseActionCard(sent[0].text), { label: "Plan", icon: "Send", prompt: "Write a plan." });
    assert.equal(requireReady(await store.inspect("one", cwd)).state, "planning");
    let refreshCount = 0;
    const becomingBusy = { paseo: { ...context.paseo, agents: { ref: () => ({
      refresh: async () => ({ agent: { workspaceId: "one", status: ++refreshCount === 1 ? "idle" : "running" } }),
      send: async () => { assert.fail("Must not dispatch after the agent becomes busy."); },
    }) } } };
    await assert.rejects(handlers.get("workflow.run-action")!(input, becomingBusy), /Wait for this agent/);
    assert.equal(refreshCount, 2);
    status = "running";
    await assert.rejects(handlers.get("workflow.run-action")!(input, context), /Wait for this agent/);
    status = "idle";
    workspaceId = "other";
    await assert.rejects(handlers.get("workflow.run-action")!(input, context), /not in this workspace/);
    workspaceId = "one";
    await store.transition("one", cwd, expected(snapshot, "implementing"));
    await assert.rejects(handlers.get("workflow.run-action")!(input, context), /workflow changed/);
    assert.equal(sent.length, 1);
    await writeFile(file, fixture + `actions:\n  - label: Conditional common\n    prompt: Conditional prompt.\n    when: project.check\n  - label: Common\n    prompt: Common prompt.\nconditions:\n  project.check:\n    command: ${JSON.stringify([process.execPath, "-e", "process.exit(1)"])}\n`);
    const conditional = await handlers.get("workflow.get")!({ workspaceId: "one", agentId: "selected-agent" }, context) as ReadyWorkflow;
    assert.equal(conditional.actionConditions?.["Conditional common"].value, "unknown");
    await assert.rejects(handlers.get("workflow.command-trust")!({ workspaceId: "one", definitionVersion: "stale", trusted: true }, context), /Workflow changed/);
    await handlers.get("workflow.command-trust")!({ workspaceId: "one", definitionVersion: conditional.definitionVersion, trusted: true }, context);
    const conditionalInput = { workspaceId: "one", agentId: "selected-agent", action: "Conditional common", ...expected(conditional, "planning") };
    await assert.rejects(handlers.get("workflow.run-action")!(conditionalInput, context), /condition is no longer met/);
    assert.equal(sent.length, 1);
    await handlers.get("workflow.run-action")!({ ...conditionalInput, action: "Common" }, context);
    assert.equal(sent[1].agentId, "selected-agent");
    assert.deepEqual(parseActionCard(sent[1].text), { label: "Common", icon: "Send", prompt: "Common prompt." });
    assert.equal(requireReady(await store.inspect("one", cwd)).state, "implementing");
  } finally {
    await cleanup();
    if (previous === undefined) delete process.env.PASEO_FLOWSTATE_DATA_DIR;
    else process.env.PASEO_FLOWSTATE_DATA_DIR = previous;
  }
});

test("archive actions use the selected workspace without MCP and retain dispatch checks", async t => {
  const { cwd, store, file } = await setup(t);
  await writeFile(file, fixture + "actions:\n  - label: Archive\n    operation: workspace.archive\n    when: github.pr.merged\n  - label: Conditional archive\n    operation: workspace.archive\n    when: git.dirty\n");
  const previous = process.env.PASEO_FLOWSTATE_DATA_DIR;
  process.env.PASEO_FLOWSTATE_DATA_DIR = store.directory;
  const handlers = new Map<string, (input: any, context: any) => Promise<any>>();
  const cleanup = contribute({
    on: () => () => {},
    handle: (contract: { name: string }, handler: any) => handlers.set(contract.name, handler),
    before: () => () => {},
  } as unknown as PluginServerContext);
  let status = "idle";
  let agentWorkspace = "one";
  let error: string | null = null;
  let archivedAt: string | null = "now";
  let pullRequest: { isMerged: boolean; state: string } | null = null;
  let failRefresh = false;
  const archived: string[] = [];
  const context = { paseo: {
    workspaces: { ref: (id: string) => ({
      refresh: async () => {
        if (failRefresh) throw new Error("Offline");
        return { workspaceDirectory: cwd, githubRuntime: { pullRequest } };
      },
      archive: async () => { archived.push(id); return { error, archivedAt }; },
    }) },
    agents: { ref: () => ({
      refresh: async () => ({ agent: { workspaceId: agentWorkspace, status } }),
      send: async () => assert.fail("Operations must not send a prompt."),
    }) },
  } };
  try {
    const snapshot = await handlers.get("workflow.get")!({ workspaceId: "one", agentId: "old-agent" }, context) as ReadyWorkflow;
    assert.equal(snapshot.toolsReady, false);
    const input = { workspaceId: "one", agentId: "old-agent", action: "Archive", ...expected(snapshot, "implementing") };
    const run = (patch = {}, ctx = context) => handlers.get("workflow.run-action")!({ ...input, ...patch }, ctx);
    assert.equal(snapshot.actionConditions?.Archive.value, "false");
    await assert.rejects(run(), /condition is no longer met/);
    for (const state of ["OPEN", "CLOSED"]) {
      pullRequest = { isMerged: false, state };
      await assert.rejects(run(), /condition is no longer met/);
    }
    pullRequest = { isMerged: true, state: "MERGED" };
    const merged = await handlers.get("workflow.get")!({ workspaceId: "one", agentId: "old-agent" }, context) as ReadyWorkflow;
    assert.equal(merged.actionConditions?.Archive.value, "true");
    // A changed attachment must invalidate the visible action at dispatch.
    pullRequest = { isMerged: false, state: "OPEN" };
    await assert.rejects(run(), /condition is no longer met/);
    pullRequest = { isMerged: true, state: "MERGED" };
    failRefresh = true;
    await assert.rejects(run(), /Offline/);
    failRefresh = false;
    await assert.rejects(run({ expectedRevision: "stale" }), /workflow changed/);
    await assert.rejects(run({ action: "Missing" }), /no longer available/);
    await assert.rejects(run({ action: "Conditional archive" }));
    status = "running";
    await assert.rejects(run(), /Wait for this agent/);
    status = "idle";
    agentWorkspace = "other";
    await assert.rejects(run(), /not in this workspace/);
    agentWorkspace = "one";
    assert.deepEqual(archived, []);
    assert.deepEqual(await run(), { executed: true });
    assert.deepEqual(archived, ["one"]);
    error = "Workspace cannot be archived";
    await assert.rejects(run(), /Workspace cannot be archived/);
    error = null;
    archivedAt = null;
    await assert.rejects(run(), /did not archive/);
    assert.equal(requireReady(await store.inspect("one", cwd)).revision, snapshot.revision);
  } finally {
    await cleanup();
    if (previous === undefined) delete process.env.PASEO_FLOWSTATE_DATA_DIR;
    else process.env.PASEO_FLOWSTATE_DATA_DIR = previous;
  }
});


test("setup prompt embeds a complete valid workflow with reachable stages and revision paths", () => {
  const embedded = setupPrompt.match(/```yaml\n([\s\S]*?)```/)?.[1];
  assert.equal(embedded, exampleWorkflow);
  const workflow = parseWorkflow(embedded!);
  const reached = new Set<string>();
  const visit = (id: string) => {
    if (reached.has(id)) return;
    reached.add(id);
    workflow.states[id].transitions.forEach(visit);
  };
  visit(workflow.initial);
  assert.deepEqual([...reached].sort(), Object.keys(workflow.states).sort());
  assert.ok(workflow.states.implementing.transitions.includes("planning"));
  assert.ok(workflow.states.reviewing.transitions.includes("implementing"));
  assert.ok(workflow.states.done.transitions.includes("planning"));
});

test("setup sends the bundled guide without MCP and rejects unavailable, busy and configured targets", async t => {
  const { cwd, store, file } = await setup(t);
  await rm(file);
  const previous = process.env.PASEO_FLOWSTATE_DATA_DIR;
  process.env.PASEO_FLOWSTATE_DATA_DIR = store.directory;
  const handlers = new Map<string, (input: any, context: any) => Promise<any>>();
  const cleanup = contribute({
    handle: (contract: { name: string }, handler: any) => handlers.set(contract.name, handler),
    before: () => () => {}, on: () => () => {},
  } as unknown as PluginServerContext);
  let status = "idle";
  let workspaceId = "one";
  let available = true;
  const sent: { agentId: string; text: string }[] = [];
  const context = { paseo: {
    workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: cwd }) }) },
    agents: { ref: (agentId: string) => ({
      refresh: async () => available ? { agent: { workspaceId, status } } : null,
      send: async (text: string) => { sent.push({ agentId, text }); },
    }) },
  } };
  try {
    const run = handlers.get("workflow.setup")!;
    const input = { workspaceId: "one", agentId: "selected" };
    assert.deepEqual(await run(input, context), { sent: true });
    assert.deepEqual(sent, [{ agentId: "selected", text: setupPrompt }]);
    assert.equal((await store.inspect("one", cwd)).status, "missing");
    for (const busy of ["running", "initializing"]) {
      status = busy;
      await assert.rejects(run(input, context), /Wait for this agent/);
    }
    status = "idle";
    workspaceId = "other";
    await assert.rejects(run(input, context), /not in this workspace/);
    workspaceId = "one";
    available = false;
    await assert.rejects(run(input, context), /not in this workspace/);
    available = true;
    await writeFile(file, fixture);
    await assert.rejects(run(input, context), /Workflow already exists/);
    await writeFile(file, "invalid: yaml");
    await assert.rejects(run(input, context), /Invalid .paseo/);
    assert.equal(sent.length, 1);
  } finally {
    await cleanup();
    if (previous === undefined) delete process.env.PASEO_FLOWSTATE_DATA_DIR;
    else process.env.PASEO_FLOWSTATE_DATA_DIR = previous;
  }
});


test("agents created before YAML can validate, repair and use workflows without validation state writes", async t => {
  const { cwd, store, file } = await setup(t);
  await rm(file);
  const service = await startWorkflowMcp(store);
  const hooks = new Map<string, (input: any) => Promise<any>>();
  registerMcpInjection({ before: (name: string, handler: any) => { hooks.set(name, handler); return () => {}; } } as unknown as PluginServerContext, Promise.resolve(service));
  const client = new Client({ name: "setup-test", version: "1.0.0" });
  try {
    const injected = await hooks.get("agent.create")!({ request: { config: { cwd } } });
    await hooks.get("agent.session_open")!({ request: { agentId: "setup-agent", workspaceId: "one", cwd, purpose: "interactive", env: injected.env } });
    const config = injected.config.mcpServers[MCP_NAME];
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
    const before = (await readdir(store.directory)).sort();
    const validate = async () => {
      const result = await client.callTool({ name: "workflow_validate", arguments: {} });
      assert.notEqual(result.isError, true);
      return validationSchema.parse(result.structuredContent);
    };
    assert.equal((await validate()).status, "missing");
    assert.equal(snapshotSchema.parse((await client.callTool({ name: "workflow_get_state", arguments: {} })).structuredContent).status, "missing");
    for (const invalid of ["initial: [", fixture.replace("[implementing]", "[unknown]"), fixture + "extra: true\n", fixture + "initial: planning\n", "initial: &x planning\nstates: *x", "x".repeat(256 * 1024 + 1)]) {
      await writeFile(file, invalid);
      const result = await validate();
      assert.equal(result.status, "invalid");
      assert.ok(result.message);
    }
    for (const args of [{ workspaceId: "other" }, { path: "/tmp/other.yml" }]) {
      assert.equal((await client.callTool({ name: "workflow_validate", arguments: args })).isError, true);
    }
    await writeFile(file, exampleWorkflow);
    const valid = await validate();
    assert.equal(valid.status, "valid");
    assert.deepEqual((await readdir(store.directory)).sort(), before);
    const initial = readySchema.parse((await client.callTool({ name: "workflow_get_state", arguments: {} })).structuredContent);
    assert.equal(initial.definitionVersion, valid.definitionVersion);
    const next = readySchema.parse((await client.callTool({ name: "workflow_transition", arguments: expected(initial, "implementing") })).structuredContent);
    assert.equal(next.state, "implementing");
    const files = await readdir(store.directory);
    const contents = await Promise.all(files.map(name => readFile(join(store.directory, name), "utf8")));
    await validate();
    assert.deepEqual(await Promise.all(files.map(name => readFile(join(store.directory, name), "utf8"))), contents);
    await rm(file);
    await mkdir(file);
    assert.equal((await validate()).status, "error");
  } finally { await client.close(); await service.close(); }
});
