# Flowtasks

A workspace task outline for Paseo, shared by people and agents.

## Install

From this directory:

```sh
npm ci
paseo plugin install .
```

Requires Paseo 0.11.2 or later. Open **Flowtasks** from the workspace panel menu or **Open Flowtasks** in Command Center.

## Edit tasks

Each task has a title and an optional description. Keep titles short and put supporting details in the description, shown below the title in smaller, muted text. Click either field to edit it. Both save after a short pause, on blur, and before structural changes. Descriptions support multiple lines; the shortcuts below apply to titles.

Empty descriptions stay hidden until you press Shift+Enter in the title. In a description, Up on the first line returns to its title; Down on the last line moves to the next visible task's title. Within the description, arrow keys move through the text normally. An empty description hides again when you leave it.

| Desktop shortcut | Action |
| --- | --- |
| Enter | Add an empty sibling task |
| Shift+Enter | Open and focus the description |
| Tab / Shift+Tab | Indent / outdent |
| Up / Down | Focus the previous / next visible task |
| Command+Enter / Ctrl+Enter | Toggle completion |
| Backspace on an empty task | Delete it if it has no children |

Use the circle beside a task to toggle completion and the chevron to collapse its children. Tasks are implicitly complete when an ancestor is complete or all their children are complete, recursively. Tasks without children are not complete automatically. Implicitly completed tasks are struck through and count toward progress, but only explicitly completed tasks show a green checkmark. Each task keeps its own saved flag. Reopening a child makes implicit parents unfinished again unless another completed ancestor still applies. Adding, moving, or deleting children recalculates implicit completion.

Drag the checkbox circle beside a task to move it with its children. Clicking the circle without dragging toggles completion. Drop near the top or bottom of another row to place it before or after that task; drop in the middle to nest it inside. A line marks insertion points and a highlighted row marks nesting. The outline scrolls when you hold the drag near its top or bottom edge. Concurrent changes to the task order cancel the move so you can review the new order.

## Filtering

Use **Search tasks** to search titles and descriptions, with ancestor tasks retained for context. Search temporarily reveals matches inside collapsed branches; clearing it restores the collapse choices. **Hide completed** hides both explicitly and implicitly completed tasks and keeps unfinished tasks visible.

Use the search field's clear button to clear search, and the **Hide completed** switch to toggle the completion filter. Progress always covers the whole workspace. These settings are local to the open panel and reset when it closes; they do not change the shared outline or another agent's view.

Reordering with drag or Tab is available in the unfiltered view. Adding a task clears search and the completion filter so the new row is visible.

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
    { "type": "create", "tempId": "plan", "parentId": null, "text": "Build the feature", "description": "Include implementation and verification tasks." },
    { "type": "create", "tempId": "implementation", "parentId": { "ref": "plan" }, "text": "Implement it" },
    { "type": "create", "parentId": { "ref": "plan" }, "afterId": { "ref": "implementation" }, "text": "Verify it" }
  ]
}
```

`flowtasks_get` accepts `status: "open"` to exclude both explicitly and implicitly completed tasks, or `status: "completed"` to return them. The default is `"all"`. MCP results include each task's saved `completed` flag and derived `effectiveCompleted` value. Completing or reopening a task never changes its descendants' saved flags.

The MCP endpoint listens on daemon loopback. Each agent receives a token bound to its workspace; tool inputs cannot select another workspace. Agents created before installation do not receive the tools.

The `text` field holds the short title for compatibility with existing tasks and agents. Use `description` for details in create or update actions, including batches. Omit it to preserve the existing description on update, or send an empty string to clear it. Existing tasks keep their full text as the title.

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
