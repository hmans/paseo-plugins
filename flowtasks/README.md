# Flowtasks

A workspace task outline for Paseo, shared by people and agents.

## Install

From this directory:

```sh
npm ci
paseo plugin install .
```

Requires Paseo 0.11.2 or later. Open **Flowtasks** from the workspace panel menu, **Open Flowtasks** in Command Center, or `/flowtasks`.

## Edit tasks

Click task text to edit it. Text saves after a short pause, on blur, and before structural changes.

| Desktop shortcut | Action |
| --- | --- |
| Enter | Add an empty sibling task |
| Shift+Enter | Add a line break |
| Tab / Shift+Tab | Indent / outdent |
| Up / Down | Focus the previous / next visible task |
| Command+Enter / Ctrl+Enter | Toggle completion |
| Backspace on an empty task | Delete it if it has no children |

Use the circle beside a task to toggle completion and the chevron to collapse its children. Children inherit completion from a completed ancestor: their text is struck through and they count toward progress, but only explicitly completed tasks show a green checkmark. Each task keeps its own completion flag, so reopening a parent restores unfinished descendants. Moving a task changes which ancestors it inherits completion from.

Drag the checkbox circle beside a task to move it with its children. Clicking the circle without dragging toggles completion. Drop near the top or bottom of another row to place it before or after that task; drop in the middle to nest it inside. A line marks insertion points and a highlighted row marks nesting. The outline scrolls when you hold the drag near its top or bottom edge. Concurrent changes to the task order cancel the move so you can review the new order.

## Agent tools

Use the play button beside a task to **Work on this now**. Flowtasks saves pending edits, sends the task text and ID to the most recently used agent in this workspace, and opens that agent. The prompt asks the agent to read Flowtasks for context and subtasks and mark verified work complete.

These prompts appear as compact task cards in the conversation. Select **Details** to see the original message, including the task ID and instructions. The agent still receives the full prompt.

Paseo's public plugin API does not expose tab-focus history. Flowtasks selects the agent with the latest user-message timestamp; if no agent has received a message, it uses the newest agent. The play buttons fade and stay disabled while that agent is busy or unavailable, then become available when it is idle. The receiving agent must have the Flowtasks tools; agents created before plugin installation need to be replaced.

The plugin injects an HTTP MCP server into newly created agents. `flowtasks_get` reads the outline; `flowtasks_change` creates, updates, moves, or deletes a task. Each change must include the revision returned by the last read. A conflict requires a fresh read and review before another attempt.

Use `flowtasks_batch` to apply 1–100 actions together. It checks `expectedRevision` once, validates the ordered actions in memory, then saves once and increments the revision once. If any action fails, no changes are saved. Actions follow the same rules as `flowtasks_change`, including explicit branch deletion and the 5,000-task limit at each step.

Create actions can assign a `tempId`. Later actions can reference it with `{ "ref": "name" }` in `id`, `parentId`, or `afterId`. String values refer to saved task IDs. Temporary IDs must be unique within the batch; forward references are not supported. The result includes the full outline and a `createdIds` map, including IDs of tasks deleted later in the same batch.

```json
{
  "expectedRevision": 12,
  "actions": [
    { "type": "create", "tempId": "plan", "parentId": null, "text": "Build the feature" },
    { "type": "create", "tempId": "implementation", "parentId": { "ref": "plan" }, "text": "Implement it" },
    { "type": "create", "parentId": { "ref": "plan" }, "afterId": { "ref": "implementation" }, "text": "Verify it" }
  ]
}
```

`flowtasks_get` accepts `status: "open"` to exclude both explicitly and implicitly completed tasks, or `status: "completed"` to return them. The default is `"all"`. MCP results include each task's saved `completed` flag and derived `effectiveCompleted` value. Completing or reopening a task never changes its descendants' saved flags.

The MCP endpoint listens on daemon loopback. Each agent receives a token bound to its workspace; tool inputs cannot select another workspace. Agents created before installation do not receive the tools.

## Storage

Each workspace has a JSON file in `$PASEO_HOME/flowtasks/outlines`, with `~/.paseo` as the default Paseo home. `PASEO_FLOWTASKS_DATA_DIR` overrides the Flowtasks data directory. Filenames are SHA-256 hashes of workspace IDs. Files contain a revision and ordered task records with IDs, parent IDs, text, and completion flags.

The server serializes writes per workspace and saves through an atomic rename. MCP bindings and the endpoint port are also persisted so agent connections can survive plugin reloads. Files are local to the daemon; there is no Git sync, backup, or undo history. Closing the app during a failed save can lose unsaved text.

## Develop

```sh
npm ci
npm run typecheck
npm test
paseo plugin reload flowtasks
```
