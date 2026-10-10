import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "./store";
import { batchSchema, children, type BatchAction } from "../shared/tasks";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "questlog-batch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new TaskStore(directory);
}
const create = (text: string, tempId?: string): BatchAction => ({ type: "create", parentId: null, text, ...(tempId ? { tempId } : {}) });

test("batch builds a nested plan with temporary references and one persisted revision", async t => {
  const store = await fixture(t);
  const result = await store.batch("w", 0, [
    create("Plan", "plan"),
    { type: "create", parentId: { ref: "plan" }, text: "First", tempId: "first" },
    { type: "create", parentId: { ref: "plan" }, afterId: { ref: "first" }, text: "Second", tempId: "second" },
    { type: "create", parentId: { ref: "first" }, text: "Nested", tempId: "nested" },
    { type: "update", id: { ref: "first" }, text: "Revised", completed: true },
    { type: "move", id: { ref: "second" }, parentId: { ref: "plan" }, afterId: null },
  ]);
  assert.equal(result.revision, 1);
  assert.deepEqual(children(result.items, result.createdIds.plan).map(item => item.text), ["Second", "Revised"]);
  assert.equal(result.items.find(item => item.id === result.createdIds.nested)?.completed, false);
  const saved = await new TaskStore(store.directory).read("w");
  assert.deepEqual(saved, { revision: 1, items: result.items });
  assert.deepEqual(await store.read("other"), { revision: 0, items: [] });
  const revised = await store.batch("w", 1, [
    { type: "update", id: result.createdIds.plan, text: "Updated plan" },
    { type: "delete", id: result.createdIds.first, deleteChildren: true },
  ]);
  assert.equal(revised.revision, 2);
  assert.equal(revised.items.length, 2);
  assert.deepEqual(revised.createdIds, {});
});

test("late failure leaves persisted bytes unchanged", async t => {
  const store = await fixture(t);
  await store.change("w", 0, { type: "create", parentId: null, text: "Existing" });
  const [file] = await readdir(join(store.directory, "outlines"));
  const path = join(store.directory, "outlines", file);
  const before = await readFile(path, "utf8");
  const invalidBatches: BatchAction[][] = [
    [create("Parent", "p"), { type: "create", parentId: { ref: "p" }, text: "Child" }, { type: "delete", id: { ref: "p" }, deleteChildren: false }],
    [create("Parent", "p"), { type: "create", parentId: { ref: "p" }, text: "Child", tempId: "c" }, { type: "move", id: { ref: "p" }, parentId: { ref: "c" }, afterId: null }],
    [create("One", "same"), create("Two", "same")],
    [create("One"), { type: "update", id: { ref: "missing" }, text: "No" }],
    [{ type: "create", parentId: { ref: "later" }, text: "Child" }, create("Parent", "later")],
    [create("Gone", "gone"), { type: "delete", id: { ref: "gone" }, deleteChildren: true }, { type: "update", id: { ref: "gone" }, text: "No" }],
    [create("One", "one"), { type: "create", parentId: { ref: "one" }, afterId: { ref: "one" }, text: "Invalid sibling" }],
  ];
  for (const actions of invalidBatches) {
    await assert.rejects(store.batch("w", 1, actions), /Batch action .*No changes were saved/);
    assert.equal(await readFile(path, "utf8"), before);
  }
  await assert.rejects(store.batch("w", 0, [create("Stale")]), /outline changed/);
  assert.equal(await readFile(path, "utf8"), before);
});

test("batch and single edits share the same revision lock", async t => {
  const store = await fixture(t);
  const results = await Promise.allSettled([
    store.batch("w", 0, [create("One"), create("Two")]),
    store.change("w", 0, { type: "create", parentId: null, text: "Concurrent" }),
    store.batch("w", 0, [create("Other batch")]),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await store.read("w")).revision, 1);
});

test("batch schema rejects empty, oversized and malformed batches", async t => {
  const store = await fixture(t);
  await assert.rejects(store.batch("w", 0, []));
  await assert.rejects(store.batch("w", 0, Array.from({ length: 101 }, () => create("Too many"))));
  await assert.rejects(store.batch("w", 0, [create("Valid"), create("x".repeat(10001))]));
  assert.equal(batchSchema.safeParse({ expectedRevision: 0, actions: [{ type: "create", text: "X", parentId: { ref: "a", extra: true } }] }).success, false);
  assert.deepEqual(await store.read("w"), { revision: 0, items: [] });
});
