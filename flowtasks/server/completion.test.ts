import assert from "node:assert/strict";
import { test } from "node:test";
import { completedIds, taskView, type Item } from "../shared/tasks";

const task = (id: string, parentId: string | null, completed = false): Item => ({ id, parentId, completed, text: id });

test("all children complete their ancestors recursively without changing saved flags", () => {
  const items = [task("root", null), task("branch", "root"), task("a", "branch", true), task("b", "branch", true), task("c", "root", true)];
  const before = JSON.stringify(items);
  assert.equal(completedIds(items).size, 5);
  assert.deepEqual(taskView({ revision: 1, items }, "open").items, []);
  assert.equal(JSON.stringify(items), before);
  const reopened = items.map(item => item.id === "b" ? { ...item, completed: false } : item);
  assert.deepEqual([...completedIds(reopened)].sort(), ["a", "c"]);
  assert.deepEqual(taskView({ revision: 2, items: reopened }, "open").items.map(item => item.id), ["root", "branch", "b"]);
  assert.equal(completedIds([...items, task("new", "root")]).has("root"), false);
});

test("empty child sets stay open and completed siblings cannot close unfinished siblings", () => {
  assert.equal(completedIds([task("leaf", null)]).size, 0);
  assert.deepEqual([...completedIds([task("root", null), task("done", "root", true), task("open", "root")])], ["done"]);
  assert.equal(completedIds([task("root", null), task("child", "root", true)]).has("root"), true);
});

test("explicit parent completion still flows down; deep trees work without recursion", () => {
  assert.equal(completedIds([task("root", null, true), task("child", "root"), task("leaf", "child")]).size, 3);
  const deep = Array.from({ length: 5000 }, (_, i) => task(String(i), i ? String(i - 1) : null, i === 4999));
  assert.equal(completedIds(deep.reverse()).size, 5000);
});
