import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const setupWorkflow = defineRpc({
  name: "workflow.setup",
  input: z.object({ workspaceId: z.string().trim().min(1), agentId: z.string().trim().min(1) }),
  output: z.object({ sent: z.literal(true) }),
});

export const exampleWorkflow = `initial: planning

# Common actions appear in every state.
actions:
  - label: Make a commit
    icon: GitCommitHorizontal
    when: git.dirty
    prompt: Review the changes and make a commit following this project's conventions.

states:
  planning:
    label: Planning
    icon: NotebookPen
    actions:
      - label: Plan the work
        prompt: |
          Inspect the project and clarify the task's scope and acceptance criteria.
          Write a concise plan. Once the scope is agreed, transition to implementing.
          Before each transition, call workflow_get_state, then workflow_transition
          with target and the returned state as expectedState, revision as
          expectedRevision, and definitionVersion unchanged. Re-read on conflicts.
    transitions: [implementing]

  implementing:
    label: Implementing
    icon: Code
    actions:
      - label: Implement the plan
        prompt: |
          Implement the agreed scope and run the project's relevant checks.
          When ready for review, transition to reviewing. If scope needs to change,
          explain why and transition to planning. Read workflow_get_state before
          workflow_transition and use its current state, revision and definitionVersion.
    transitions: [planning, reviewing]

  reviewing:
    label: Reviewing
    icon: ScanEye
    actions:
      - label: Review changes
        prompt: |
          Review the changes against the agreed scope, checking correctness,
          regressions and verification results. If fixes are needed, transition
          to implementing. Otherwise summarize verification and transition to done.
          Read workflow_get_state before workflow_transition and use its current
          state, revision and definitionVersion. Re-read and reassess conflicts.
    transitions: [implementing, done]

  done:
    label: Done
    icon: CircleCheck
    actions:
      - label: Start next task
        prompt: |
          Establish the next task's scope with the user, preserving completed work.
          Read workflow_get_state, then transition to planning with workflow_transition
          using the returned state, revision and definitionVersion.
      - label: Archive workspace
        operation: workspace.archive
        when: github.pr.merged
    transitions: [planning]
`;

export const setupPrompt = `Set up a Flowstate workflow for this project in .paseo/flowstate.yml.

Inspect the repository instructions, development scripts and conventions first.
Use the example below as a starting point; adapt the stages, action prompts and
verification commands to this project's actual needs. Keep it simple. Ask only
about preferences that materially affect the workflow and cannot be inferred.
Check whether the file already exists before writing; preserve existing configuration
and discuss changes if another agent or user has created it in the meantime.

How Flowstate works:
- A workspace shares one saved state across its agents. States describe stages of work.
- Actions are buttons. A prompt action sends its full prompt with an action header to the selected agent.
  Clicking it does not change state. Prompts should explain both what to do and when
  to transition. The agent judges completion criteria; the graph only limits destinations.
- Agents read workflow_get_state before calling workflow_transition with target,
  expectedState (returned state), expectedRevision (returned revision), and the
  unchanged definitionVersion. On conflicts, read again and reassess. Never edit saved state files.
- Top-level actions appear in every state. State actions appear only in that state.
- An operation action runs directly in Paseo. The only supported operation is
  workspace.archive; it archives the workspace and may remove its managed worktree.
- Optional when conditions control action availability, not transitions: false hides,
  unknown disables. Built-ins are git.dirty and github.pr.merged (the attached PR).
  Expressions can use { all: [...] }, { any: [...] }, or { not: ... }.
- Optional custom conditions live under conditions with project.* names, e.g.
  project.check: { command: ["./scripts/check"], interval: "60s", timeout: "10s" }.
  Commands run without an implicit shell: exit 0 is true, 1 false, others unknown.
  Use read-only checks. They require the user's command trust in the workflow UI.
  Prefer built-in conditions unless a custom check is useful.

YAML authoring rules:
- initial names a defined state. IDs match [a-z][a-z0-9_-]*.
- Each state supports optional label, icon, actions and transitions.
  transitions contains defined state IDs; empty or omitted makes a terminal state.
- Actions need a nonempty label and exactly one of prompt or operation.
  Labels must be unique within each state and must not collide with common actions.
- Icons are optional PascalCase Lucide names (e.g. Code or CircleCheck).
- Unknown fields, duplicate YAML keys and YAML aliases are rejected.
- Use multiline prompt: | text for instructions. There are no automatic on-entry
  hooks, transition conditions or separate criteria fields; put criteria in prompts.

Complete example (adapt rather than copy blindly):
\`\`\`yaml
${exampleWorkflow}\`\`\`

Questlog is optional and independent. If the project uses it and its tools are
available, adapt prompts to read and update the shared task outline, preserve
unrelated tasks and mark only verified work complete. Do not require it otherwise.

After writing, call workflow_validate with no arguments. It validates this workspace's
.paseo/flowstate.yml against Flowstate's actual YAML parser and schema without
initializing or changing workflow state or executing condition commands. Fix every
reported error and repeat until status is valid. Only then report setup complete,
including the validation result and a brief explanation of the stages and actions.
If validation is missing or unavailable, do not claim success: explain the blocker.
Agents created after this version of Flowstate is running receive tools even before
the workflow exists. Older agents without workflow_validate need a new agent to
finish validation. YAML edits are picked up automatically; no plugin reload is needed.
`;
