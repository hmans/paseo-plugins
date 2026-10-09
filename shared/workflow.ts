import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const identifier = z.string().regex(/^[a-z][a-z0-9_-]*$/);
const text = z.string().trim().min(1);
const iconName = z.string().regex(/^[A-Z][A-Za-z0-9]*$/, "Use a PascalCase Lucide icon name, such as GitCommitHorizontal.");
export const builtinConditions = ["git.dirty"] as const;
export type ConditionExpression = string | { all: ConditionExpression[] } | { any: ConditionExpression[] } | { not: ConditionExpression };
const expression: z.ZodType<ConditionExpression> = z.lazy(() => z.union([
  text, z.object({ all: z.array(expression).min(1) }).strict(),
  z.object({ any: z.array(expression).min(1) }).strict(), z.object({ not: expression }).strict(),
]));
const duration = z.string().regex(/^[1-9][0-9]*(ms|s|m)$/);
export const conditionResultSchema = z.object({ value: z.enum(["true", "false", "unknown"]), message: z.string().optional() });
export type ConditionResult = z.infer<typeof conditionResultSchema>;
export const workflowSchema = z.object({
  initial: identifier,
  conditions: z.record(z.string().regex(/^project\.[a-z][a-z0-9_.-]*$/), z.object({
    command: z.array(z.string().min(1).refine(argument => !argument.includes("\0"), "Command arguments cannot contain null bytes.")).min(1), interval: duration.default("60s"), timeout: duration.default("10s"),
  }).strict()).default({}),
  states: z.record(identifier, z.object({
    label: text.optional(),
    icon: iconName.optional(),
    actions: z.array(z.object({ label: text, prompt: text, icon: iconName.optional(), when: expression.optional() }).strict()).min(1),
    transitions: z.array(identifier).default([]),
  }).strict()),
}).strict().superRefine((workflow, ctx) => {
  if (!Object.hasOwn(workflow.states, workflow.initial)) {
    ctx.addIssue({ code: "custom", path: ["initial"], message: "Initial state does not exist." });
  }
  for (const [id, state] of Object.entries(workflow.states)) {
    const labels = new Set<string>();
    state.actions.forEach((action, index) => {
      const validate = (value: ConditionExpression, depth = 0): void => {
        if (depth > 20) { ctx.addIssue({ code: "custom", message: "Condition nesting exceeds 20 levels." }); return; }
        if (typeof value === "string") {
          if (!(builtinConditions as readonly string[]).includes(value) && !Object.hasOwn(workflow.conditions, value)) ctx.addIssue({ code: "custom", message: `Unknown condition: ${value}.` });
        } else if ("not" in value) validate(value.not, depth + 1);
        else ("all" in value ? value.all : value.any).forEach(child => validate(child, depth + 1));
      };
      if (action.when) validate(action.when);
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
  toolsReady: z.boolean().optional(),
  actionConditions: z.record(z.string(), conditionResultSchema).optional(),
  commandsTrusted: z.boolean().optional(),
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
  input: z.object({ workspaceId: text, agentId: text.optional() }),
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

export const setCommandTrust = defineRpc({
  name: "workflow.command-trust",
  input: z.object({ workspaceId: text, definitionVersion: text, trusted: z.boolean() }),
  output: z.object({ saved: z.literal(true) }),
});

export const transitionSchema = z.object({
  target: identifier,
  expectedState: identifier,
  expectedRevision: text,
  definitionVersion: text,
}).strict();
export type Transition = z.infer<typeof transitionSchema>;
