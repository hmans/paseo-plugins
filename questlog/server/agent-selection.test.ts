import assert from "node:assert/strict";
import { test } from "node:test";
import { lastUsedAgent } from "../shared/agent-selection";

const agent = (id: string, lastUserMessageAt: string | null, extra = {}) => ({
  id, workspaceId: "workspace", createdAt: "2026-10-01T00:00:00Z", lastUserMessageAt, status: "idle", ...extra,
});

test("choose the last user conversation within the exact workspace", () => {
  const agents = [
    agent("old", "2026-10-01T00:00:00Z", { updatedAt: "2026-10-10T00:00:00Z" }),
    agent("recent", "2026-10-05T00:00:00Z"),
    agent("other", "2026-10-09T00:00:00Z", { workspaceId: "other" }),
    agent("archived", "2026-10-09T00:00:00Z", { archivedAt: "2026-10-10T00:00:00Z" }),
  ];
  assert.equal(lastUsedAgent(agents, "workspace")?.id, "recent");
  assert.equal(lastUsedAgent(agents, "missing"), undefined);
  assert.equal(agents[0].id, "old");
});

test("do not switch to an older idle agent when the last used agent is busy", () => {
  assert.equal(lastUsedAgent([
    agent("idle", "2026-10-01T00:00:00Z"),
    agent("busy", "2026-10-05T00:00:00Z", { status: "running" }),
  ], "workspace")?.id, "busy");
});

test("prefer conversations with messages; use newest creation when none have messages", () => {
  const fresh = agent("fresh", null, { createdAt: "2026-10-10T00:00:00Z" });
  assert.equal(lastUsedAgent([fresh, agent("used", "2026-10-01T00:00:00Z")], "workspace")?.id, "used");
  assert.equal(lastUsedAgent([agent("old", null), fresh], "workspace")?.id, "fresh");
});
