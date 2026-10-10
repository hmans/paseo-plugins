import assert from "node:assert/strict";
import { test } from "node:test";
import { outlineView, type ViewOptions } from "../shared/view";
import type { Item } from "../shared/tasks";

const task = (id: string, parentId: string | null, text = id, completed = false): Item => ({ id, parentId, text, completed });
const items = [task("root", null, "Feature"), task("first", "root", "Build"), task("nested", "first", "Verify search"),
  task("done", "root", "Old check", true), task("inherited", "done", "Search closed"), task("other", null, "Other work")];
const options: ViewOptions = { search: "", hideCompleted: false, collapsed: new Set() };
const visible = (changes: Partial<ViewOptions>, source = items) => outlineView(source, { ...options, ...changes }).visible.map(({ item }) => item.id);

test("search keeps ancestor context and temporarily reveals collapsed matches", () => {
  const collapsed = new Set(["root", "first"]);
  assert.deepEqual(visible({ search: "  VERIFY SEARCH  ", collapsed }), ["root", "first", "nested"]);
  assert.deepEqual([...collapsed], ["root", "first"]);
  assert.deepEqual(visible({ collapsed }), ["root", "other"]);
  assert.deepEqual(visible({ search: "Feature" }), ["root"]);
  assert.deepEqual(visible({ search: "missing" }), []);
  assert.deepEqual(visible({ search: "Other" }), ["other"]);
});

test("hide completed uses inherited completion and preserves unfinished siblings", () => {
  assert.deepEqual(visible({ hideCompleted: true }), ["root", "first", "nested", "other"]);
  assert.deepEqual(visible({ hideCompleted: true, search: "search" }), ["root", "first", "nested"]);
  assert.deepEqual(visible({ hideCompleted: true, search: "Old check" }), []);
  const reopened = items.map(item => item.id === "done" ? { ...item, completed: false } : item);
  assert.ok(visible({ hideCompleted: true }, reopened).includes("inherited"));
});

test("search matches descriptions and keeps ancestor context", () => {
  const described = items.map(item => item.id === "nested" ? { ...item, description: "Check keyboard accessibility" } : item);
  assert.deepEqual(visible({ search: "KEYBOARD", collapsed: new Set(["root"]) }, described), ["root", "first", "nested"]);
});

test("editing keeps the current row visible until blur without changing the shared outline", () => {
  const before = JSON.stringify(items);
  assert.deepEqual(visible({ search: "missing", editingId: "nested" }), ["root", "first", "nested"]);
  assert.deepEqual(visible({ search: "missing", editingId: null }), []);
  assert.equal(JSON.stringify(items), before);
});

test("views handle empty outlines, reordered records and deep nesting", () => {
  assert.deepEqual(visible({}, []), []);
  assert.deepEqual(visible({ search: "Verify" }, [...items].reverse()), ["root", "first", "nested"]);
  const deep = Array.from({ length: 5000 }, (_, index) => task(String(index), index ? String(index - 1) : null));
  const view = outlineView(deep, { ...options, search: "4999" });
  assert.equal(view.visible.length, 5000);
  assert.equal(view.visible.at(-1)?.depth, 4999);
});
