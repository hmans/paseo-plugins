# Workspace workflow

A Paseo plugin that gives each workspace a saved state and a set of prompt actions. Define the workflow in YAML. Actions appear directly as composer pills. Click one to send its prompt to that agent. The agent can then request an allowed state transition.

## Try it

Requires Paseo 0.11.2 or later and an agent provider that supports HTTP MCP servers. No external service or API key is required. Agents use MCP tools; they do not need shell or file access to change workflow state.

```sh
npm install
npm run typecheck
npm test
paseo plugin install /absolute/path/to/this/plugin
```

Plugins must be enabled on the target daemon. This plugin's installation ID is `paseoplugintest`.

1. Add `.paseo/workflow.yaml` to the workspace checkout. This project includes a Planning → Implementing → Reviewing → Done example.
2. Create a new agent in that workspace after the plugin is running. Its composer shows a branch icon and the current state, such as **Planning**.
3. Select an action pill to send its prompt directly. Actions are disabled while that agent is running or initializing, or while a prompt is being sent. The state pill still opens the full prompts, condition explanations, and command trust controls.
4. The agent receives exactly the configured prompt. Its injected MCP tools let it read and change the workspace state.

Use `/workflow` or **Open workspace workflow** in the Command Center to open the actions in an agent panel.

Agents created before MCP injection was installed need to be replaced with a new agent. The same applies if the workflow file was added after the agent was created. Paseo's current plugin API can inject MCP configuration on creation, but cannot add it to an existing agent. The UI explains this and disables its prompt actions. Creating a new agent in the same workspace preserves the workflow state.

## Define a workflow

```yaml
initial: planning

states:
  planning:
    label: Planning
    actions:
      - label: Write a plan
        prompt: |
          Write a plan for the task we discussed.
          After the user agrees, transition to implementing.
    transitions: [implementing]

  implementing:
    label: Implementing
    actions:
      - label: Implement the plan
        prompt: |
          Implement the agreed plan and run the relevant checks.
          Report the result to the user.
    transitions: []
```

- `initial` must name a defined state.
- State IDs start with a lowercase letter and contain lowercase letters, numbers, underscores, or hyphens.
- Each state has one or more actions. Each action needs a nonempty `label` and `prompt`. Action labels must be unique within that state.
- `label` on a state is optional; the UI uses the state ID when it is absent.
- `icon` on a state or action is an optional PascalCase [Lucide icon name](https://lucide.dev/icons/), such as `ScanEye` or `GitCommitHorizontal`. State icons appear in the state pill; action icons appear in both action pills and the expanded list. Defaults are `GitBranch` for states and `Send` for actions. Paseo supplies the icon set: unknown names render no icon, while invalid name formats produce a configuration error. Image paths and SVG markup are not supported.
- `transitions` lists the allowed destination state IDs. An omitted or empty list makes the state terminal.
- Unknown fields, duplicate YAML keys, and YAML aliases are rejected. The file size limit is 256 KiB.

The plugin reads the definition from the workspace's own directory, including its worktree. Commit it to share it with the project. Saving a valid edit updates an open workflow UI within about two seconds; a plugin reload is not needed for YAML changes.

## Conditional actions

Add `when` to an action to make its availability depend on workspace checks. Actions without `when` are always available when the agent is ready. A false condition hides the action. An unknown result disables it and shows an explanation. Conditions do not change the saved workflow state.

```yaml
conditions:
  project.tests_pass:
    command: ["./scripts/check-tests"]
    interval: 60s
    timeout: 10s

# Inside a state's actions list:
# - label: Make a commit
#   when: git.dirty
#   prompt: Review the changes and make a commit.
# - label: Finish
#   when:
#     all:
#       - project.tests_pass
#       - not: git.dirty
#   prompt: Summarize the completed work.
```

`git.dirty` is the first built-in condition. It checks for staged, unstaged, and untracked changes in the workspace checkout, including submodule changes. Ignored files do not count. Git errors produce an unknown result. Results are cached for two seconds. GitHub conditions are not included yet.

Use a condition name, `{ all: [...] }`, `{ any: [...] }`, or `{ not: ... }` in `when`. Lists must be nonempty; expressions can nest up to 20 levels. `not` preserves unknown. A false member decides `all`, and a true member decides `any`; otherwise an unknown member makes the result unknown.

Custom condition names must start with `project.`. Commands use an argument array, run in the workspace directory on the daemon machine, and receive its environment. No shell is added. Use an executable script or an explicit interpreter when needed. Exit 0 means true, exit 1 means false, and other exits, missing executables, or timeouts mean unknown. Command output is not displayed.

Custom commands do not run until you select **Trust these commands in this workspace** in the workflow UI. Review the listed commands and their scripts first: they run automatically with the daemon's filesystem, network, and credential access, outside agent tool approvals. Trust covers future edits to scripts and their dependencies. Changing a custom command definition requires trust again. Trust is scoped to the workspace ID and canonical directory, persists outside the checkout, and can be revoked in the same UI. Revocation prevents subsequent checks; it does not undo or cancel a command already running.

`interval` defaults to `60s`; `timeout` defaults to `10s`. Durations accept positive integers with `ms`, `s`, or `m`. Cache intervals are capped at one hour. An evaluation has a 20-second command budget; a command's timeout is capped by the remaining budget. The plugin allows four checks at once and 64 KiB of combined output per command. Busy and failed checks return unknown and are retried after two seconds. POSIX timeout cleanup terminates the process group; on Windows it terminates the direct process. Checks should be read-only and must not start background services.

Checks run on demand when the UI reads the workflow and when an action is dispatched. Agents in the same workspace share cached results. Dispatch bypasses cached results and rechecks the selected action, then verifies that the workflow definition and revision still match. External state can change after a check, so the prompted agent must still verify the situation before acting.

## State and transitions

All agents in a workspace share one state. Different workspace IDs have separate state, even when they use the same directory. The first read saves the initial state. Clicking a prompt does not change it.

The injected MCP server exposes two tools:

| Tool | Behavior |
| --- | --- |
| `workflow_get_state` | Returns the current state, workflow definition, revision, and definition version. Takes no arguments. |
| `workflow_transition` | Takes `target`, `expectedState`, `expectedRevision`, and `definitionVersion`. Validates and saves an allowed transition. |

Paseo supplies the workspace identity when the agent session opens. Tool calls cannot choose another workspace or provide a file path. Agents in different workspaces remain separate even if those workspaces use the same directory.

Before a transition, the agent reads the current state and supplies the target, expected state, revision, and definition version. The backend checks the allowed transition and rejects stale requests. Requests within a workspace are serialized. The plugin validates the transition graph; the agent and user decide whether the task's completion criteria are met.

State survives plugin reloads and daemon restarts. State and MCP binding records are stored outside the checkout in `$PASEO_HOME/workspace-workflow`, defaulting to `~/.paseo/workspace-workflow`. Set `PASEO_WORKFLOW_DATA_DIR` in the daemon environment to choose another directory before creating agents. Run only one plugin installation per data directory.

The MCP server listens on daemon loopback. Each injected configuration contains a separate authorization token; only its hash is stored in the binding records. The server keeps its assigned port across reloads and restarts so saved agent configurations keep working. If another process occupies that port, startup fails rather than silently changing the URL. Paseo's normal MCP tool permission rules apply; the plugin does not auto-approve transitions.

The built-in workflow and Git checks make no external network calls. Trusted custom commands can use the network. State, trust, and binding files remain after uninstalling the plugin. The old shell-command interface is no longer served.

If a definition is invalid, or its saved state has been removed, actions stop and the UI shows an error. Restore the missing state or correct the YAML. The plugin does not silently reset saved state. It also preserves unreadable state files so they can be recovered.

## Develop

```sh
npm run typecheck
npm test
paseo plugin reload paseoplugintest
paseo plugin ls
paseo plugin logs paseoplugintest
```

The tests cover configuration validation, persistence, workspace isolation, stale and concurrent transitions, MCP discovery and tool calls through the official MCP client, reconnection after reload, creation/session hooks, and action dispatch. UI code uses React Native, Paseo theme colors, and compact layout spacing. Desktop UI has been checked in Paseo; native mobile verification remains to be done.
