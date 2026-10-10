import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { taskDirectory } from "./directory";
import { TaskStore } from "./store";

test("rename preserves saved outlines, revisions and MCP state across reloads", async t => {
  const home = await mkdtemp(join(tmpdir(), "questlog-migration-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const legacy = join(home, "flowtasks");
  const original = await new TaskStore(legacy).change("workspace", 0, { type: "create", parentId: null, text: "Keep this task", description: "Keep these notes" });
  await writeFile(join(legacy, "mcp-bindings.json"), "{}");
  await writeFile(join(legacy, "mcp-port.json"), '{"port":12345}');
  const directory = taskDirectory({ PASEO_HOME: home });
  assert.equal(directory, join(home, "questlog"));
  assert.deepEqual(await new TaskStore(directory).read("workspace"), original);
  assert.equal(await readFile(join(directory, "mcp-bindings.json"), "utf8"), "{}");
  assert.equal(await readFile(join(directory, "mcp-port.json"), "utf8"), '{"port":12345}');
  assert.equal(taskDirectory({ PASEO_HOME: home }), directory);
  await assert.rejects(readFile(join(legacy, "mcp-bindings.json")), { code: "ENOENT" });
});

test("fresh installs and explicit data directories skip migration", async t => {
  const home = await mkdtemp(join(tmpdir(), "questlog-directory-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(taskDirectory({ PASEO_HOME: home }), join(home, "questlog"));
  await mkdir(join(home, "flowtasks"));
  assert.equal(taskDirectory({ PASEO_HOME: home, PASEO_FLOWTASKS_DATA_DIR: "/custom/legacy" }), "/custom/legacy");
  assert.equal(taskDirectory({ PASEO_HOME: home, PASEO_FLOWTASKS_DATA_DIR: "/custom/legacy", PASEO_QUESTLOG_DATA_DIR: "/custom/tasks" }), "/custom/tasks");
});

test("migration refuses to overwrite an existing destination", async t => {
  const home = await mkdtemp(join(tmpdir(), "questlog-conflict-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const name of ["flowtasks", "questlog"]) {
    await mkdir(join(home, name));
    await writeFile(join(home, name, "sentinel"), name);
  }
  assert.throws(() => taskDirectory({ PASEO_HOME: home }), /Both Questlog and legacy task data exist/);
  for (const name of ["flowtasks", "questlog"]) assert.equal(await readFile(join(home, name, "sentinel"), "utf8"), name);
});
