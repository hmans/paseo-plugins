import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const identifier = z.string().regex(/^[a-z][a-z0-9_-]*$/);
const text = z.string().trim().min(1);
export const workflowSchema = z.object({
  initial: identifier,
  states: z.record(identifier, z.object({
    label: text.optional(),
    actions: z.array(z.object({ label: text, prompt: text }).strict()).min(1),
    transitions: z.array(identifier).default([]),
  }).strict()),
}).strict().superRefine((workflow, ctx) => {
  if (!Object.hasOwn(workflow.states, workflow.initial)) {
    ctx.addIssue({ code: "custom", path: ["initial"], message: "Initial state does not exist." });
  }
  for (const [id, state] of Object.entries(workflow.states)) {
    const labels = new Set<string>();
    state.actions.forEach((action, index) => {
      if (labels.has(action.label)) ctx.addIssue({ code: "custom", path: ["states", id, "actions", index, "label"], message: "Action labels must be unique within a state." });
      labels.add(action.label);
    });
    state.transitions.forEach((target, index) => {
      if (!Object.hasOwn(workflow.states, target)) ctx.addIssue({ code: "custom", path: ["states", id, "transitions", index], message: `Unknown state: ${target}.` });
    });
  }
});
export type Workflow = z.infer<typeof workflowSchema>;

export const readySchema = z.object({
  status: z.literal("ready"),
  workspaceId: z.string(),
  state: z.string(),
  revision: z.string(),
  definitionVersion: z.string(),
  updatedAt: z.string(),
  workflow: workflowSchema,
});
export type ReadyWorkflow = z.infer<typeof readySchema>;
export const snapshotSchema = z.discriminatedUnion("status", [
  readySchema,
  z.object({ status: z.literal("missing"), message: z.string() }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export type WorkflowSnapshot = z.infer<typeof snapshotSchema>;

export const getWorkflow = defineRpc({
  name: "workflow.get",
  input: z.object({ workspaceId: text }),
  output: snapshotSchema,
});

export const runAction = defineRpc({
  name: "workflow.run-action",
  input: z.object({
    workspaceId: text,
    agentId: text,
    action: text,
    expectedState: text,
    expectedRevision: text,
    definitionVersion: text,
  }),
  output: z.object({ sent: z.literal(true) }),
});

export const transitionSchema = z.object({
  target: identifier,
  expectedState: identifier,
  expectedRevision: text,
  definitionVersion: text,
}).strict();
export type Transition = z.infer<typeof transitionSchema>;
