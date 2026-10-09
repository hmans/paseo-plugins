# Workspace workflow

A Paseo plugin that gives each workspace a saved state and a set of prompt actions. Define the workflow in YAML. Click an action to send its prompt to the agent whose composer you are using. The agent can then request an allowed state transition.

## Try it

Requires Paseo 0.11.2 or later, Node.js 18 or later on the daemon machine, and an agent that can run commands in a POSIX shell. No external service or API key is required.

```sh
npm install
npm run typecheck
npm test
paseo plugin install /absolute/path/to/this/plugin
```

Plugins must be enabled on the target daemon. This plugin's installation ID is `paseoplugintest`.

1. Add `.paseo/workflow.yaml` to the workspace checkout. This project includes a Planning → Implementing → Reviewing → Done example.
2. Open an agent. Its composer shows a branch icon and the current state, such as **Planning**.
3. Select the pill, then select a prompt. Actions are disabled while that agent is running or initializing.
4. The agent receives the configured prompt plus instructions for reading and changing the workspace state.

Use `/workflow` or **Open workspace workflow** in the Command Center to open the actions in an agent panel.

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
- `transitions` lists the allowed destination state IDs. An omitted or empty list makes the state terminal.
- Unknown fields, duplicate YAML keys, and YAML aliases are rejected. The file size limit is 256 KiB.

The plugin reads the definition from the workspace's own directory, including its worktree. Commit it to share it with the project. Saving a valid edit updates an open workflow UI within about two seconds; a plugin reload is not needed for YAML changes.

## State and transitions

All agents in a workspace share one state. Different workspace IDs have separate state, even when they use the same directory. The first read saves the initial state. Clicking a prompt does not change it.

The command interface supports `get` and `transition`. Each sent prompt includes complete commands bound to that workspace. Existing agents can use them immediately; this version does not inject an MCP server. The agent must have permission to run Node and reach loopback on the daemon machine. A sandbox that blocks those operations needs the user's normal permission flow.

Before a transition, the agent reads the current state and supplies the target, expected state, revision, and definition version. The backend checks the allowed transition and rejects stale requests. Requests within a workspace are serialized. The plugin validates the transition graph; the agent and user decide whether the task's completion criteria are met.

State survives plugin reloads and daemon restarts. State and the command helper are stored outside the checkout in `$PASEO_HOME/workspace-workflow`, defaulting to `~/.paseo/workspace-workflow`. Set `PASEO_WORKFLOW_DATA_DIR` in the daemon environment to choose another directory. Run only one plugin installation per data directory.

The command bridge listens on loopback and uses a signed workspace binding. Commands in agent history continue to work after reloads. There are no external network calls. State files and bridge keys remain after uninstalling the plugin.

If a definition is invalid, or its saved state has been removed, actions stop and the UI shows an error. Restore the missing state or correct the YAML. The plugin does not silently reset saved state. It also preserves unreadable state files so they can be recovered.

## Develop

```sh
npm run typecheck
npm test
paseo plugin reload paseoplugintest
paseo plugin ls
paseo plugin logs paseoplugintest
```

The tests cover configuration validation, persistence, workspace isolation, stale and concurrent transitions, command bindings, reloads, and action dispatch. UI code uses React Native, Paseo theme colors, and compact layout spacing. Desktop UI has been checked in Paseo; native mobile verification remains to be done.
