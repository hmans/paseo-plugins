# Questlog

Questlog is a task outline shared by all agents in a Paseo workspace. Edit tasks inline, nest related work, collapse branches, and track completion with a progress bar.

Open Questlog from the workspace panel menu or Command Center. Changes save automatically on the daemon machine. Data is stored outside the repository and is not synced through Git.

New agents receive MCP tools to read and change their workspace's outline. Existing agents can use the panel, but must be replaced with a newly created agent to receive the tools. Concurrent edits are checked to prevent silent overwrites.

Requires Paseo 0.11.2 or later. No external account or service is needed.

New agents also receive brief instructions to use the outline for meaningful work, without logging every small action. These are appended to existing agent instructions; no repository instruction file is required. Existing agents retain their original instructions.
