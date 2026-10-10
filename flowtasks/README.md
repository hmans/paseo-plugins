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

Use the circle beside a task to toggle completion and the chevron to collapse its children. The small toolbar provides add, indent, and outdent controls on touch devices. Completing a parent does not complete its children.

Drag the checkbox circle beside a task to move it with its children. Clicking the circle without dragging toggles completion. Drop near the top or bottom of another row to place it before or after that task; drop in the middle to nest it inside. A line marks insertion points and a highlighted row marks nesting. The outline scrolls when you hold the drag near its top or bottom edge. Concurrent changes to the task order cancel the move so you can review the new order.

## Agent tools

The plugin injects an HTTP MCP server into newly created agents. `flowtasks_get` reads the outline; `flowtasks_change` creates, updates, moves, or deletes a task. Each change must include the revision returned by the last read. A conflict requires a fresh read and review before another attempt.

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
