# Flowstate

A Paseo plugin that gives each workspace a saved state and a set of actions. Define the workflow in YAML. Actions appear directly as composer pills. Click one to send a prompt to the agent or run a supported Paseo operation. Agents can request allowed state transitions.

## Try it

Requires Paseo 0.11.2 or later and an agent provider that supports HTTP MCP servers. No external service or API key is required. Agents use MCP tools; they do not need shell or file access to change workflow state.

```sh
cd flowstate
npm install
npm run typecheck
npm test
paseo plugin install .
```

Or install directly from GitHub:

```sh
paseo plugin add git:hmans/paseo-plugins:flowstate
```

Plugins must be enabled on the target daemon. This plugin's installation ID is `flowstate`.

1. In a workspace without a workflow, open **Set up workflow** and choose **Set up workflow** in the setup card. The agent receives a bundled authoring guide and a complete Planning → Implementing → Reviewing → Done example to adapt to your project. New agents receive workflow tools before the file exists. The setup prompt requires `workflow_validate` and correction of any errors before reporting success. Older agents without the tool need to be replaced to finish validation. You can also add `.paseo/flowstate.yml` manually. The repository root includes a Planning → Implementing → Reviewing → Done example in [`.paseo/flowstate.yml`](../.paseo/flowstate.yml).
2. Create a new agent in that workspace after the plugin is running. Its composer shows a branch icon and the current state, such as **Planning**.
3. Select an action pill to send its prompt or run its operation directly. Actions are disabled while that agent is running or initializing, or while an action is being dispatched. The state pill opens action descriptions, condition explanations, and command trust controls.
4. The agent receives exactly the configured prompt. Its injected MCP tools let it read and change the workspace state.

Setup requests appear as a compact Flowstate card in the conversation. Expand **Details** to read the full instructions; the agent still receives the complete prompt.

Click the current state pill to open compact action buttons, condition explanations, command trust controls, and **Change state** buttons for the allowed next states. Hover over an action button on desktop or web to read its full prompt or operation description. The same text is available as an accessibility hint. State changes do not send a prompt and remain available while the agent is running. There is no separate agent panel or slash command. Command Center actions are deferred until Paseo can filter them by the focused workspace and agent.

Agents created before MCP injection was installed need to be replaced with a new agent. New agents receive the tools even when no workflow file exists yet. Paseo's current plugin API can inject MCP configuration on creation, but cannot add it to an existing agent. The UI explains this and disables its prompt actions. Creating a new agent in the same workspace preserves the workflow state.

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
- Each action needs a nonempty `label` and exactly one of `prompt` or `operation`. Prompts must be nonempty; operations must name a supported operation. Action labels must be unique within a state and must not collide with common action labels. A state's `actions` can be empty or omitted.
- `label` on a state is optional; the UI uses the state ID when it is absent.
- `icon` on a state or action is an optional PascalCase [Lucide icon name](https://lucide.dev/icons/), such as `ScanEye` or `GitCommitHorizontal`. State icons appear in the state pill; action icons appear in both action pills and the expanded list. Defaults are `GitBranch` for states, `Send` for prompts, and `Archive` for workspace archiving. Paseo supplies the icon set: unknown names render no icon, while invalid name formats produce a configuration error. Image paths and SVG markup are not supported.
- `transitions` lists the allowed destination state IDs. An omitted or empty list makes the state terminal.
- Unknown fields, duplicate YAML keys, and YAML aliases are rejected. The file size limit is 256 KiB.

The plugin reads the definition from the workspace's own directory, including its worktree. Commit it to share it with the project. Saving a valid edit updates an open workflow UI within about two seconds; a plugin reload is not needed for YAML changes.

## Use Questlog with this repository's workflow

The repository's [workflow configuration](../.paseo/flowstate.yml) coordinates the two plugins through prompts and MCP tools. Questlog holds tasks within the current workspace. Planning records agreed work; implementation and review use the same outline. Titles stay short, while descriptions hold requirements, acceptance criteria, and verification results.

The conversation defines the scope. A task started with Questlog's **Work on this now** supplies its ID; the workflow can use that task and its subtasks. Without a selected task or an agreed scope, the agent asks the user. There is no separate active-plan record or task-selection channel between the plugins. Unrelated tasks are retained and do not prevent the scoped work from reaching Done. Starting new work retains completed tasks; deletion requires an explicit request.

Implementation and review read the full outline, including completed tasks. `effectiveCompleted` can come from an ancestor or a complete set of children, so it is not proof of verification. Agents check the scoped descendants' requirements and reopen affected tasks and completed ancestors in scope when fixes are required.

Each plugin has its own revision checks. Agents read before writing and reassess conflicts. Task edits and workflow transitions are separate operations, not one transaction: save verified task updates first, then read the current workflow and request its transition. A failed transition does not roll back task edits.

Both plugins must be installed and their MCP tools available to the receiving agent. Prompts tell the agent to stop and report missing tools; Flowstate checks its own tool binding but does not detect Questlog availability. If needed, create a new agent after both plugins are installed. The plugins remain independently installable; only this repository's prompts require both.

This integration provides guidance, not completion enforcement. No native task condition or automatic selection transfer is needed for this workflow. Such APIs would be needed to disable actions based on task state or make transitions depend on task completion in the backend.

Verification of this configuration used live reads from both MCP servers in the same agent, including confirmation that Flowstate loaded the edited YAML. The isolated plugin tests cover revision conflicts, workspace/token isolation, missing Flowstate bindings, and implicit completion under completed parents. Missing Questlog handling and scope selection remain prompt instructions rather than backend checks.

## Common actions

Top-level `actions` are available in every state, after that state's own actions. They support the same icons, conditions, and dispatch checks. They do not automatically change the workflow state.

```yaml
initial: planning
actions:
  - label: Make a commit
    icon: GitCommitHorizontal
    when: git.dirty
    prompt: |
      Review the uncommitted changes and make a Conventional Commit.
      If the current branch has a configured upstream, push to it.
      Otherwise, leave the commit local.
states:
  planning:
    actions: []
    transitions: []
```

Common action labels must be unique. A collision with a state action is a configuration error; neither action overrides the other. Omit top-level `actions` if you only need state-specific actions.

## Paseo operations

Use `operation` to run a supported Paseo operation directly, without sending a prompt or requiring injected MCP tools. Operations can be state-specific or common actions and support the same `when` conditions and stale-state checks as prompts.

```yaml
# Inside a state's actions list:
- label: Archive workspace
  operation: workspace.archive
  when: github.pr.merged
```

`workspace.archive` is currently the only supported operation. It archives the workspace containing the action through Paseo's SDK. Paseo removes a managed worktree after its last workspace is archived. The action runs when clicked and reports SDK errors; it does not change the saved workflow state. Like prompt actions, it waits until the selected agent is neither running nor initializing. Other agents in the workspace are managed by Paseo's archive operation.

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

`git.dirty` checks for staged, unstaged, and untracked changes in the workspace checkout, including submodule changes. Ignored files do not count. Git errors produce an unknown result. Results are cached for two seconds.

`github.pr.merged` is true only when Paseo reports that the workspace's currently attached PR is merged. No attached PR, an open PR, or a PR closed without merging returns false and hides the action. The plugin reads the workspace through Paseo's SDK on each evaluation, including dispatch, without adding its own cache or making a separate GitHub request. Freshness follows Paseo's GitHub data. SDK read failures return unknown and disable the action.

Use a condition name, `{ all: [...] }`, `{ any: [...] }`, or `{ not: ... }` in `when`. Lists must be nonempty; expressions can nest up to 20 levels. `not` preserves unknown. A false member decides `all`, and a true member decides `any`; otherwise an unknown member makes the result unknown.

Custom condition names must start with `project.`. Commands use an argument array, run in the workspace directory on the daemon machine, and receive its environment. No shell is added. Use an executable script or an explicit interpreter when needed. Exit 0 means true, exit 1 means false, and other exits, missing executables, or timeouts mean unknown. Command output is not displayed.

Custom commands do not run until you select **Trust these commands in this workspace** in the workflow UI. Review the listed commands and their scripts first: they run automatically with the daemon's filesystem, network, and credential access, outside agent tool approvals. Trust covers future edits to scripts and their dependencies. Changing a custom command definition requires trust again. Trust is scoped to the workspace ID and canonical directory, persists outside the checkout, and can be revoked in the same UI. Revocation prevents subsequent checks; it does not undo or cancel a command already running.

`interval` defaults to `60s`; `timeout` defaults to `10s`. Durations accept positive integers with `ms`, `s`, or `m`. Cache intervals are capped at one hour. An evaluation has a 20-second command budget; a command's timeout is capped by the remaining budget. The plugin allows four checks at once and 64 KiB of combined output per command. Busy and failed checks return unknown and are retried after two seconds. POSIX timeout cleanup terminates the process group; on Windows it terminates the direct process. Checks should be read-only and must not start background services.

Checks run on demand when the UI reads the workflow and when an action is dispatched. Agents in the same workspace share cached results. Dispatch bypasses cached results and rechecks the selected action, then verifies that the workflow definition and revision still match. External state can change after a check, so the prompted agent must still verify the situation before acting.

## State and transitions

All agents in a workspace share one state. Different workspace IDs have separate state, even when they use the same directory. The first read saves the initial state. Clicking a prompt does not change it.

Users can select an allowed next state from the current state pill's popover without MCP tools. User and agent transitions use the same saved-state and revision checks. A concurrent change rejects a stale transition and requires a refresh.

Successful transitions add a Flowstate entry to the initiating agent's timeline showing the previous state, next state, and whether the user or agent made the change. These entries are display feedback, not the saved state or a durable audit log. Timeline publication is best effort; a publication error is logged without undoing the state change. After a plugin reload, an agent transition may wait for the next lifecycle callback or workflow read to obtain Paseo's connection before publishing its entry.

The injected MCP server exposes three tools:

| Tool | Behavior |
| --- | --- |
| `workflow_get_state` | Returns the current state, workflow definition, revision, and definition version, or a missing/error status. Takes no arguments. |
| `workflow_validate` | Validates the workspace YAML with the runtime parser and schema. Returns valid with a definition version, or invalid/missing/error with diagnostics. Takes no arguments. |
| `workflow_transition` | Takes `target`, `expectedState`, `expectedRevision`, and `definitionVersion`. Validates and saves an allowed transition. |

Validation does not initialize or change saved workflow state or run custom condition commands. It checks the definition only; use `workflow_get_state` to check compatibility with existing saved state. The setup prompt requires agents to fix validation errors and repeat until valid. This is agent guidance, not an enforced gate on file writes.

Paseo supplies the workspace identity when the agent session opens. Tool calls cannot choose another workspace or provide a file path. Agents in different workspaces remain separate even if those workspaces use the same directory.

Before a transition, the agent reads the current state and supplies the target, expected state, revision, and definition version. The backend checks the allowed transition and rejects stale requests. Requests within a workspace are serialized. The plugin validates the transition graph; the agent and user decide whether the task's completion criteria are met.

State survives plugin reloads and daemon restarts. State, command trust, and MCP binding records are stored outside the checkout in `$PASEO_HOME/flowstate`, defaulting to `~/.paseo/flowstate`. Set `PASEO_FLOWSTATE_DATA_DIR` in the daemon environment to choose another directory before creating agents. The MCP configuration key is `flowstate`. Run only one plugin installation per data directory.

When upgrading from workspace-workflow, rename `.paseo/workflow.yaml` to `.paseo/flowstate.yml`. With the plugin disabled, move the old `$PASEO_HOME/workspace-workflow` directory to `$PASEO_HOME/flowstate` to keep saved state, command trust, and MCP bindings. If you use a custom directory, replace `PASEO_WORKFLOW_DATA_DIR` with `PASEO_FLOWSTATE_DATA_DIR`. Old names are no longer read and data is not moved automatically. Create new agents after enabling Flowstate to use the new MCP configuration and bootstrap token names.

The MCP server listens on daemon loopback. Each injected configuration contains a separate authorization token; only its hash is stored in the binding records. The server keeps its assigned port across reloads and restarts so saved agent configurations keep working. If another process occupies that port, startup fails rather than silently changing the URL. Paseo's normal MCP tool permission rules apply; the plugin does not auto-approve transitions.

The built-in workflow and Git checks make no external network calls. Trusted custom commands can use the network. State, trust, and binding files remain after uninstalling the plugin. The old shell-command interface is no longer served.

If a definition is invalid, or its saved state has been removed, actions stop and the UI shows an error. Restore the missing state or correct the YAML. The plugin does not silently reset saved state. It also preserves unreadable state files so they can be recovered.

## Develop

```sh
npm run typecheck
npm test
paseo plugin reload flowstate
paseo plugin ls
paseo plugin logs flowstate
```

The tests cover configuration validation, persistence, workspace isolation, stale and concurrent transitions, MCP discovery and tool calls through the official MCP client, reconnection after reload, creation/session hooks, and action dispatch. UI code uses React Native, Paseo theme colors, and compact layout spacing. Desktop UI has been checked in Paseo; native mobile verification remains to be done.
