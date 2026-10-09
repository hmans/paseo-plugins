Workspace workflow gives each workspace a saved state, such as Planning, Implementing, or Reviewing. Its composer pill shows that state and opens prompt buttons for the current agent. All agents in a workspace share the same state.

Define states, prompts, and allowed transitions in `.paseo/workflow.yaml` in your project checkout. Each prompt includes commands the agent can use to read or change state. Invalid transitions and requests based on old state are rejected. The agent decides when the work is ready for a transition; the plugin checks that the transition is allowed.

Requires Paseo 0.11.2 or later and Node.js 18 or later on the daemon machine. Agents need access to a POSIX shell and local loopback connections. No account or API key is required.

The plugin reads the workspace's YAML file and sends the selected prompt and workflow instructions to its current agent. It saves workspace state on the daemon machine, outside the project checkout. State survives reloads and restarts. A local command bridge handles agent transitions without external network calls. Invalid configuration is shown in the UI without resetting saved state. State files remain after the plugin is removed.
