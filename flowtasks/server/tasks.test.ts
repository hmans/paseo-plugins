import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { children, completedIds, taskView, type Outline } from "../shared/tasks";
import { TaskStore } from "./store";
import { startTaskMcp } from "./mcp";
import { WorkspaceBindings } from "./bindings";
import { registerMcpInjection } from "./injection";
import type { PluginServerContext } from "@getpaseo/plugin/server";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "flowtasks-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new TaskStore(directory);
}
const create = (text: string, parentId: string | null = null) => ({ type: "create" as const, text, parentId });

test("nested moves preserve children and sibling order; cycles and invalid positions fail", async t => {
  const store = await fixture(t);
  let state = await store.change("w", 0, create("First"));
  const a = state.items[0].id;
  state = await store.change("w", state.revision, create("Second"));
  const b = state.items[1].id;
  state = await store.change("w", state.revision, create("Child", a));
  const child = state.items[2].id;
  state = await store.change("w", state.revision, { type: "move", id: a, parentId: b, afterId: null });
  assert.equal(state.items.find(item => item.id === child)?.parentId, a);
  await assert.rejects(store.change("w", state.revision, { type: "move", id: b, parentId: child, afterId: null }), /cannot be moved/);
  await assert.rejects(store.change("w", state.revision, { type: "move", id: child, parentId: null, afterId: a }), /sibling/);
  state = await store.change("w", state.revision, { type: "move", id: a, parentId: null, afterId: b });
  assert.deepEqual(children(state.items, null).map(item => item.text), ["Second", "First"]);
  state = await store.change("w", state.revision, { type: "move", id: a, parentId: null, afterId: null });
  assert.deepEqual(children(state.items, null).map(item => item.text), ["First", "Second"]);
});

test("completion preserves children and branch deletion is explicit", async t => {
  const store = await fixture(t);
  let state = await store.change("w", 0, create("Parent"));
  const id = state.items[0].id;
  state = await store.change("w", 1, create("Child", id));
  state = await store.change("w", 2, { type: "update", id, completed: true });
  assert.equal(state.items[1].completed, false);
  assert.equal(completedIds(state.items).size, 2);
  assert.equal(state.items[0].completed, true);
  await assert.rejects(store.change("w", 3, { type: "delete", id, deleteChildren: false }), /children/);
  state = await store.change("w", 3, { type: "delete", id, deleteChildren: true });
  assert.deepEqual(state.items, []);
});

test("inherited completion is reversible and follows moves without changing saved flags", async t => {
  const store = await fixture(t);
  let state = await store.change("w", 0, create("Root"));
  const root = state.items[0].id;
  state = await store.change("w", state.revision, create("Parent", root));
  const parent = state.items[1].id;
  state = await store.change("w", state.revision, create("Child", parent));
  const child = state.items[2].id;
  state = await store.change("w", state.revision, create("Grandchild", child));
  state = await store.change("w", state.revision, create("Sibling", root));
  const grandchild = state.items[3].id;
  state = await store.change("w", state.revision, { type: "update", id: grandchild, completed: true });
  const revision = state.revision;
  state = await store.change("w", revision, { type: "update", id: parent, completed: true });
  assert.equal(state.revision, revision + 1);
  assert.deepEqual(state.items.map(item => item.completed), [false, true, false, true, false]);
  assert.deepEqual(taskView(state).items.map(item => item.effectiveCompleted), [false, true, true, true, false]);
  assert.deepEqual(taskView(state, "open").items.map(item => item.text), ["Root", "Sibling"]);
  assert.deepEqual(await new TaskStore(store.directory).read("w"), state);
  state = await store.change("w", state.revision, { type: "update", id: parent, completed: false });
  assert.deepEqual(state.items.map(item => item.completed), [false, false, false, true, false]);
  // The explicit grandchild keeps Child and Parent implicitly complete.
  assert.deepEqual(taskView(state, "open").items.map(item => item.text), ["Root", "Sibling"]);
  state = await store.change("w", state.revision, { type: "update", id: child, completed: false });
  state = await store.change("w", state.revision, { type: "update", id: parent, text: "Renamed" });
  assert.deepEqual(state.items.map(item => item.completed), [false, false, false, true, false]);
  state = await store.change("w", state.revision, { type: "update", id: parent, completed: true });
  state = await store.change("w", state.revision, create("New child", parent));
  state = await store.change("w", state.revision, { type: "update", id: parent, completed: true });
  assert.deepEqual(state.items.map(item => item.completed), [false, true, false, true, false, false]);
  assert.equal(completedIds(state.items).size, 4);
  state = await store.change("w", state.revision, { type: "move", id: child, parentId: root, afterId: null });
  assert.equal(completedIds(state.items).has(child), true);
  assert.equal(completedIds(state.items).has(grandchild), true);
  assert.equal(taskView(state, "completed").items.length, 4);
});

test("concurrent writes reject stale revisions; workspaces and reloads retain independent state", async t => {
  const store = await fixture(t);
  const results = await Promise.allSettled([store.change("w", 0, create("One")), store.change("w", 0, create("Two"))]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.deepEqual(await store.read("other"), { revision: 0, items: [] });
  assert.deepEqual(await new TaskStore(store.directory).read("w"), await store.read("w"));
  await store.change("w", 1, create("Next"));
  assert.equal((await store.read("w")).items.length, 2);
});

test("invalid input and corrupt saved state are not overwritten", async t => {
  const store = await fixture(t);
  await assert.rejects(store.change("w", 0, create("x".repeat(10001))));
  await store.change("w", 0, create("Valid"));
  const [file] = await readdir(join(store.directory, "outlines"));
  await writeFile(join(store.directory, "outlines", file), "broken");
  await assert.rejects(store.read("w"));
  await assert.rejects(store.change("w", 1, create("Do not overwrite")));
});

test("inline editing supports empty siblings and preserves whitespace", async t => {
  const store = await fixture(t);
  let state = await store.change("w", 0, create("First"));
  const first = state.items[0].id;
  state = await store.change("w", 1, create("Last"));
  state = await store.change("w", 2, { ...create(""), afterId: first });
  assert.deepEqual(children(state.items, null).map(item => item.text), ["First", "", "Last"]);
  const blank = state.items[1].id;
  state = await store.change("w", 3, { type: "update", id: blank, text: "  A task\nwith a second line " });
  assert.equal(state.items[1].text, "  A task\nwith a second line ");
});

test("saved notes migrate to tasks without losing text, identity or nesting", async t => {
  const store = await fixture(t);
  const state = await store.change("w", 0, create("An old note"));
  const [file] = await readdir(join(store.directory, "outlines"));
  const path = join(store.directory, "outlines", file);
  await writeFile(path, JSON.stringify({ ...state, items: state.items.map(item => ({ ...item, kind: "note" })) }));
  assert.deepEqual(await store.read("w"), state);
  await store.change("w", 1, { type: "update", id: state.items[0].id, completed: true });
  assert.equal(JSON.parse(await readFile(path, "utf8")).items[0].kind, undefined);
});

test("bindings reject unbound, unknown and cross-workspace tokens and survive reload", async t => {
  const store = await fixture(t);
  const bindings = await WorkspaceBindings.load(store);
  const token = await bindings.issue(store.directory);
  assert.equal(bindings.resolve(token), null);
  assert.equal(bindings.resolve("unknown"), null);
  await bindings.bind(token, "agent", "workspace", store.directory);
  await assert.rejects(bindings.bind(token, "other", "workspace", store.directory), /another agent/);
  await assert.rejects(bindings.bind(token, "agent", "other", store.directory), /another agent/);
  await assert.rejects(bindings.resume("agent", "other"), /another workspace/);
  assert.equal((await WorkspaceBindings.load(store)).resolve(token), "workspace");
});

test("HTTP MCP lists tools, updates the bound workspace, reports conflicts, rejects unauthorized requests and restarts", async t => {
  const store = await fixture(t);
  let service = await startTaskMcp(store);
  t.after(async () => { await service.close(); });
  const token = await service.bindings.issue(store.directory);
  assert.equal((await fetch(service.url, { method: "POST" })).status, 403);
  assert.equal((await fetch(service.url, { method: "POST", headers: { Authorization: `Bearer ${token}` } })).status, 403);
  await service.bindings.bind(token, "agent", "w", store.directory);
  assert.equal((await fetch(service.url, { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: "https://example.com" } })).status, 403);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["flowtasks_get", "flowtasks_change", "flowtasks_batch"]);
  const read = await client.callTool({ name: "flowtasks_get", arguments: {} });
  assert.deepEqual(read.structuredContent, { revision: 0, items: [] });
  const change = await client.callTool({ name: "flowtasks_change", arguments: { expectedRevision: 0, action: create("From MCP") } });
  assert.equal((change.structuredContent as Outline).items[0].text, "From MCP");
  const conflict = await client.callTool({ name: "flowtasks_change", arguments: { expectedRevision: 0, action: create("Stale") } });
  assert.equal(conflict.isError, true);
  const escape = await client.callTool({ name: "flowtasks_get", arguments: { workspaceId: "other" } });
  assert.equal(escape.isError, true);
  assert.equal((await store.read("other")).items.length, 0);
  let outline = await store.read("w");
  const parent = outline.items[0].id;
  outline = await store.change("w", outline.revision, create("Inherited child", parent));
  const done = await client.callTool({ name: "flowtasks_change", arguments: {
    expectedRevision: outline.revision, action: { type: "update", id: parent, completed: true },
  } });
  assert.equal(done.isError, undefined);
  const closed = done.structuredContent as ReturnType<typeof taskView>;
  assert.equal(closed.items[1].completed, false);
  assert.equal(closed.items[1].effectiveCompleted, true);
  const open = await client.callTool({ name: "flowtasks_get", arguments: { status: "open" } });
  assert.deepEqual(open.structuredContent, { revision: closed.revision, items: [] });
  const completed = await client.callTool({ name: "flowtasks_get", arguments: { status: "completed" } });
  assert.equal((completed.structuredContent as Outline).items.length, 2);
  const batch = await client.callTool({ name: "flowtasks_batch", arguments: { expectedRevision: closed.revision, actions: [
    { type: "create", parentId: null, text: "Batch parent", tempId: "p" },
    { type: "create", parentId: { ref: "p" }, text: "Batch child", tempId: "c" },
  ] } });
  assert.equal(batch.isError, undefined);
  const batched = batch.structuredContent as ReturnType<typeof taskView> & { createdIds: Record<string, string> };
  assert.equal(batched.revision, closed.revision + 1);
  assert.equal(batched.items.find(item => item.id === batched.createdIds.c)?.parentId, batched.createdIds.p);
  const failedBatch = await client.callTool({ name: "flowtasks_batch", arguments: { expectedRevision: batched.revision, actions: [
    { type: "update", id: batched.createdIds.p, text: "Do not save" },
    { type: "delete", id: batched.createdIds.p, deleteChildren: false },
  ] } });
  assert.equal(failedBatch.isError, true);
  assert.equal((await store.read("w")).revision, batched.revision);
  assert.equal((await store.read("w")).items.find(item => item.id === batched.createdIds.p)?.text, "Batch parent");
  await client.close();
  const url = service.url;
  await service.close();
  service = await startTaskMcp(new TaskStore(store.directory));
  assert.equal(service.url, url);
  assert.equal(service.bindings.resolve(token), "w");
});

test("creation hooks preserve other MCPs and bind the new token before interactive launch", async t => {
  const store = await fixture(t);
  const service = await startTaskMcp(store);
  t.after(() => service.close());
  const hooks = new Map<string, (input: any) => Promise<any>>();
  registerMcpInjection({ before: (name: string, handler: any) => hooks.set(name, handler) } as unknown as PluginServerContext, Promise.resolve(service));
  const request = { config: { cwd: store.directory, mcpServers: { other: { type: "http", url: "http://example.test" } } }, env: { EXISTING: "yes" } };
  const created = await hooks.get("agent.create")!({ request });
  assert.deepEqual(created.config.mcpServers.other, request.config.mcpServers.other);
  const token = created.env.PASEO_FLOWTASKS_BOOTSTRAP_TOKEN;
  assert.equal(service.bindings.resolve(token), null);
  const opened = await hooks.get("agent.session_open")!({ request: { purpose: "interactive", workspaceId: "w", agentId: "a", cwd: store.directory, env: created.env } });
  assert.equal(service.bindings.resolve(token), "w");
  assert.deepEqual(opened.env, { EXISTING: "yes" });
  await assert.rejects(hooks.get("agent.create")!({ request: { ...request, config: { ...request.config, mcpServers: { flowtasks: { type: "http", url: "http://other.test" } } } } }), /unrelated MCP/);
});
