# Agent workflow

Use both Flowstate and Flowtasks for repository work, including small changes and
tasks requested directly in chat. Do not wait for the user to remind you or click
a workflow action.

- At the start of work, call `workflow_get_state` and `flowtasks_get` (including
  completed tasks). Follow the workflow defined in `.paseo/flowstate.yml` and use
  the conversation or selected task to establish scope.
- Record the work in Flowtasks before implementation. Reuse an applicable task
  or create one; use short titles and put requirements, acceptance criteria,
  blockers, and verification results in descriptions. Keep tracking proportional
  to the work: a small change can be one task.
- Keep Flowstate aligned with the actual stage of work. Once the requested work
  is understood and recorded, transition from `planning` to `implementing`;
  transition to `reviewing` when changes are ready; review and verify the scoped
  work before transitioning to `done`. Use the allowed transitions to return to
  implementation or planning when needed. A clear user request authorizes routine
  implementation; do not add a separate approval step solely for state tracking.
- Update Flowtasks as work progresses. Mark only verified work complete. Read
  scoped descendants even under completed parents: `effectiveCompleted` is not
  evidence of verification. Reopen affected tasks and completed ancestors in
  scope when fixes remain. Preserve completed and unrelated tasks; delete tasks
  only when explicitly requested.
- Read before writes and use the returned revisions. For Flowstate transitions,
  pass the current state, revision, and `definitionVersion`. On conflicts, read
  again and reassess rather than blindly retrying. Both tools manage shared
  workspace state; do not overwrite another agent's progress or edit their saved
  state files directly.
- Save task updates before the corresponding workflow transition. Before the
  final response, confirm verified scoped tasks are complete and Flowstate is
  `done`, or accurately record remaining work and the current stage. Unrelated
  open tasks do not prevent completion of the agreed scope.
- If required tools are unavailable or fail, report the limitation explicitly;
  do not silently omit tracking or claim a task or state update succeeded.
