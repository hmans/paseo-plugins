import assert from "node:assert/strict";
import { test } from "node:test";
import { dropAction, dropBoundary, dropTargetAt, structure } from "../shared/drag";
import { children, type Item } from "../shared/tasks";
import { applyAction } from "./store";

const items: Item[] = [
  { id: "a", parentId: null, text: "A", completed: false },
  { id: "child", parentId: "a", text: "Child", completed: false },
  { id: "b", parentId: null, text: "B", completed: false },
  { id: "c", parentId: null, text: "C", completed: false },
];

test("after one row and before the next use the exact same landing boundary", () => {
  const rows = [{ id: "a", top: 100, height: 26 }, { id: "b", top: 126, height: 52 }];
  assert.equal(dropBoundary(rows, { id: "a", position: "after" }), 126);
  assert.equal(dropBoundary(rows, { id: "b", position: "before" }), 126);
  assert.equal(dropBoundary(rows, { id: "b", position: "inside" }), null);
});

test("drop indicator resists small movement across zone and row boundaries", () => {
  const rows = [{ id: "a", top: 0, height: 26 }, { id: "b", top: 26, height: 26 }];
  const before = { id: "a", position: "before" as const };
  assert.deepEqual(dropTargetAt(rows, 8, before), before);
  assert.deepEqual(dropTargetAt(rows, 12, before), { id: "a", position: "inside" });
  const after = { id: "a", position: "after" as const };
  assert.deepEqual(dropTargetAt(rows, 28, after), after);
  assert.deepEqual(dropTargetAt(rows, 31, after), { id: "b", position: "before" });
  assert.equal(dropTargetAt(rows, 100, after), null);
  assert.equal(dropTargetAt([{ id: "hidden", top: 0, height: 0 }], 0, null), null);
});

test("drop before and after reorders siblings and carries descendants", () => {
  const action = dropAction(items, "a", { id: "c", position: "before" })!;
  const next = applyAction({ items, revision: 0 }, action);
  assert.deepEqual(children(next.items, null).map(item => item.id), ["b", "a", "c"]);
  assert.equal(next.items.find(item => item.id === "child")?.parentId, "a");
  const after = applyAction({ items, revision: 0 }, dropAction(items, "a", { id: "c", position: "after" })!);
  assert.deepEqual(children(after.items, null).map(item => item.id), ["b", "c", "a"]);
  const first = applyAction({ items, revision: 0 }, dropAction(items, "c", { id: "a", position: "before" })!);
  assert.deepEqual(children(first.items, null).map(item => item.id), ["c", "a", "b"]);
});

test("drop inside appends a child; drop beside root outdents", () => {
  assert.deepEqual(dropAction(items, "b", { id: "a", position: "inside" }), { type: "move", id: "b", parentId: "a", afterId: "child" });
  assert.deepEqual(dropAction(items, "child", { id: "b", position: "after" }), { type: "move", id: "child", parentId: null, afterId: "b" });
});

test("self, descendant and missing targets cannot accept a drop", () => {
  for (const position of ["before", "inside", "after"] as const) {
    assert.equal(dropAction(items, "a", { id: "a", position }), null);
    assert.equal(dropAction(items, "a", { id: "child", position }), null);
    assert.equal(dropAction(items, "a", { id: "deleted", position }), null);
  }
});

test("structural conflict check ignores text edits but detects nesting and order changes", () => {
  assert.equal(structure(items), structure(items.map(item => ({ ...item, text: "Edited", completed: true }))));
  assert.notEqual(structure(items), structure([...items].reverse()));
  assert.notEqual(structure(items), structure(items.map(item => item.id === "c" ? { ...item, parentId: "b" } : item)));
});
