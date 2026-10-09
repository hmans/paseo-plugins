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
import { readySchema, type ReadyWorkflow } from "../shared/workflow";

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
  let service = await startWorkflowMcp(store);
  const client = new Client({ name: "workflow-test", version: "1.0.0" });
  try {
    const token = await service.bindings.issue(cwd);
    assert.equal((await fetch(service.url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" })).status, 403);
    await service.bindings.bind(token, "agent-one", "one", cwd);
    await assert.rejects(service.bindings.bind(token, "agent-two", "two", cwd), /another agent or workspace/);
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ["workflow_get_state", "workflow_transition"]);
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
    const request = { config: { provider: "codex", cwd, title: "Keep title", mcpServers: { existing: existingMcp }, providerOptions: { keep: true } }, env: { KEEP: "yes" } };
    const injected = await hooks.get("agent.create")!({ request });
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
    assert.equal(await hooks.get("agent.create")!({ request: { config: { cwd: root }, env: {} } }), undefined);
    await assert.rejects(hooks.get("agent.create")!({ request: { config: { ...request.config, mcpServers: { [MCP_NAME]: existingMcp } } } }), /unrelated MCP server/);
    const cloned = await hooks.get("agent.create")!({ request: injected });
    assert.notEqual(cloned.env[TOKEN_ENV], injected.env[TOKEN_ENV]);
  } finally { await service.close(); }
});

test("action RPC sends only to the selected agent and rejects busy or stale requests", async t => {
  const { cwd, store, file } = await setup(t);
  const previous = process.env.PASEO_WORKFLOW_DATA_DIR;
  process.env.PASEO_WORKFLOW_DATA_DIR = store.directory;
  const handlers = new Map<string, (input: any, context: any) => Promise<any>>();
  const hooks = new Map<string, (input: any) => Promise<any>>();
  const cleanup = contribute({
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
    assert.equal(sent[0].text, "Write a plan.");
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
    await writeFile(file, fixture.replace("prompt: Implement the plan.", "prompt: Implement the plan.\n        when: project.check") + `conditions:\n  project.check:\n    command: ${JSON.stringify([process.execPath, "-e", "process.exit(1)"])}\n`);
    const conditional = await handlers.get("workflow.get")!({ workspaceId: "one", agentId: "selected-agent" }, context) as ReadyWorkflow;
    assert.equal(conditional.actionConditions?.Implement.value, "unknown");
    await assert.rejects(handlers.get("workflow.command-trust")!({ workspaceId: "one", definitionVersion: "stale", trusted: true }, context), /Workflow changed/);
    await handlers.get("workflow.command-trust")!({ workspaceId: "one", definitionVersion: conditional.definitionVersion, trusted: true }, context);
    const conditionalInput = { workspaceId: "one", agentId: "selected-agent", action: "Implement", ...expected(conditional, "planning") };
    await assert.rejects(handlers.get("workflow.run-action")!(conditionalInput, context), /condition is no longer met/);
    assert.equal(sent.length, 1);
  } finally {
    await cleanup();
    if (previous === undefined) delete process.env.PASEO_WORKFLOW_DATA_DIR;
    else process.env.PASEO_WORKFLOW_DATA_DIR = previous;
  }
});
