import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAgent, useRpc, type PluginAgentPanelProps, type PluginButtonContentProps, type PluginButtonIconProps, type PluginButton } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { actionDescription, defaultActionIcon, getWorkflow, runAction, setCommandTrust, workflowActions } from "../shared/workflow";
import { actionButtons } from "./action-pills";

function actionIcon(name: string) {
  return function ActionIcon({ size, color }: PluginButtonIconProps) {
    return <Icon name={name} size={size} color={color} />;
  };
}

function useWorkflow(workspaceId: string, agentId?: string) {
  const get = useRpc(getWorkflow);
  return useQuery({
    queryKey: ["workflow", workspaceId, agentId],
    queryFn: () => get({ workspaceId, agentId }),
    refetchInterval: 2000,
    staleTime: 1000,
    retry: false,
  });
}

export function WorkflowIcon(props: PluginButtonIconProps & { agentId: string; onLabel(label: string): void; onActions(buttons: PluginButton[]): void }) {
  const query = useWorkflow(props.workspaceId, props.agentId);
  const agent = useAgent(props.agentId, agent => ({ status: agent.status }));
  const run = useRpc(runAction);
  const queryClient = useQueryClient();
  const sending = useRef(false);
  const data = query.data;
  const send = useMutation({
    mutationFn: async (action: string) => {
      if (sending.current) throw new Error("A workflow action is already being sent.");
      if (query.isError || data?.status !== "ready") throw new Error("Workflow is unavailable. Open the state pill for details.");
      sending.current = true;
      try {
        await run({ workspaceId: props.workspaceId, agentId: props.agentId, action, expectedState: data.state, expectedRevision: data.revision, definitionVersion: data.definitionVersion });
      } finally { sending.current = false; }
    },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["workflow", props.workspaceId] }); },
  });
  const busy = !agent || agent.status === "running" || agent.status === "initializing" || send.isPending;
  const dispatch = send.mutateAsync;
  const label = query.isError || data?.status === "error" ? "Workflow error"
    : data?.status === "ready" ? data.workflow.states[data.state].label ?? data.state
    : data?.status === "missing" ? "Set up workflow" : "Flowstate";
  useEffect(() => props.onLabel(label), [label, props.onLabel]);
  useEffect(() => {
    props.onActions(actionButtons(query.isError ? undefined : data, busy, dispatch, actionIcon));
  }, [data, query.isError, busy, dispatch, props.onActions]);
  useEffect(() => () => props.onActions([]), [props.onActions]);
  const icon = !query.isError && data?.status === "ready" ? data.workflow.states[data.state].icon ?? "GitBranch" : "GitBranch";
  return <Icon name={icon} size={props.size} color={props.theme.colors.accent} />;
}

type ActionsProps = Pick<PluginAgentPanelProps, "workspaceId" | "agentId" | "theme" | "layout"> & { onSent?(): void };

function WorkflowActions({ workspaceId, agentId, theme, layout, onSent }: ActionsProps) {
  const [hoveredAction, setHoveredAction] = useState<string | null>(null);
  const query = useWorkflow(workspaceId, agentId);
  const queryClient = useQueryClient();
  const run = useRpc(runAction);
  const saveTrust = useRpc(setCommandTrust);
  const agent = useAgent(agentId, agent => ({ status: agent.status }));
  const snapshot = query.data;
  const trust = useMutation({
    mutationFn: (trusted: boolean) => {
      if (snapshot?.status !== "ready") throw new Error("Workflow is not ready.");
      return saveTrust({ workspaceId, definitionVersion: snapshot.definitionVersion, trusted });
    },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["workflow", workspaceId] }); },
  });
  const send = useMutation({
    mutationFn: (action: string) => {
      if (snapshot?.status !== "ready") throw new Error("Workflow is not ready.");
      return run({ workspaceId, agentId, action, expectedState: snapshot.state, expectedRevision: snapshot.revision, definitionVersion: snapshot.definitionVersion });
    },
    onSuccess: () => onSent?.(),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["workflow", workspaceId] }); },
  });
  const colors = theme.colors;
  const text = { color: colors.foreground, fontSize: 14 };
  const muted = { color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 };
  const busy = !agent || agent.status === "running" || agent.status === "initializing";

  if (query.isPending) return <Text style={muted}>Loading workflow…</Text>;
  if (query.isError || !snapshot || snapshot.status !== "ready") {
    const message = query.isError ? query.error.message : snapshot && snapshot.status !== "ready" ? snapshot.message : "Workflow is unavailable.";
    return <View style={{ gap: 12 }}>
      <Text style={{ ...text, fontWeight: "600" }}>Flowstate</Text>
      <Text selectable style={muted}>{message}</Text>
      <Pressable accessibilityRole="button" onPress={() => { void query.refetch(); }} style={{ paddingVertical: 10 }}>
        <Text style={{ color: colors.accent }}>Refresh workflow</Text>
      </Pressable>
    </View>;
  }

  const state = snapshot.workflow.states[snapshot.state];
  const actions = workflowActions(snapshot.workflow, snapshot.state);
  const needsNewAgent = snapshot.toolsReady === false && actions.some(action => "prompt" in action);
  const disabled = busy || send.isPending;
  return <View style={{ gap: layout.compact ? 14 : 18 }}>
    <View style={{ gap: 5 }}>
      <Text style={{ color: colors.foreground, fontSize: 22, fontWeight: "600" }}>{state.label ?? snapshot.state}</Text>
      <Text style={muted}>Choose an action.</Text>
    </View>
    {needsNewAgent && <Text style={{ ...muted, color: colors.statusWarning }}>Create a new agent in this workspace to load the workflow tools. This agent was created without them. Your workspace state will stay the same.</Text>}
    {Object.keys(snapshot.workflow.conditions).length > 0 && <View style={{ gap: 8 }}>
      <Text style={muted}>Custom conditions run project commands automatically with the daemon's permissions and credentials. Trust includes future changes to the scripts they call.</Text>
      {Object.entries(snapshot.workflow.conditions).map(([name, condition]) => <Text key={name} selectable style={muted}>{name}: {JSON.stringify(condition.command)}</Text>)}
      <Pressable accessibilityRole="button" disabled={trust.isPending} onPress={() => trust.mutate(!snapshot.commandsTrusted)}>
        <Text style={{ ...text, color: colors.accent }}>{trust.isPending ? "Saving…" : snapshot.commandsTrusted ? "Revoke command trust" : "Trust these commands in this workspace"}</Text>
      </Pressable>
      {trust.isError && <Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>{trust.error.message}</Text>}
    </View>}
    <View style={{ gap: 8 }}>
      {actions.filter(action => snapshot.actionConditions?.[action.label]?.value !== "false").map(action => {
        const condition = snapshot.actionConditions?.[action.label];
        const actionDisabled = disabled || ("prompt" in action && needsNewAgent) || (!!action.when && condition?.value !== "true");
        return <Pressable
        key={action.label}
        accessibilityRole="button"
        accessibilityLabel={action.label}
        accessibilityState={{ disabled: actionDisabled, busy: send.isPending && send.variables === action.label }}
        disabled={actionDisabled}
        onHoverIn={() => setHoveredAction(action.label)}
        onHoverOut={() => setHoveredAction(null)}
        onPress={() => send.mutate(action.label)}
        style={({ pressed }) => ({
          padding: layout.compact ? 12 : 14, gap: 6, borderRadius: 8,
          borderWidth: 1, borderColor: !actionDisabled && (pressed || hoveredAction === action.label) ? colors.accent : colors.border,
          backgroundColor: !actionDisabled && (pressed || hoveredAction === action.label) ? colors.surface2 : colors.surface1,
          opacity: actionDisabled ? 0.55 : 1,
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Icon name={action.icon ?? defaultActionIcon(action)} size={15} color={colors.accent} />
          <Text style={{ ...text, flex: 1, fontWeight: "600" }}>{send.isPending && send.variables === action.label ? "Running…" : action.label}</Text>
        </View>
        <Text numberOfLines={3} style={muted}>{actionDescription(action)}</Text>
        {action.when && condition?.value !== "true" && <Text style={{ ...muted, color: colors.statusWarning }}>{condition?.message ?? "Checking condition…"}</Text>}
      </Pressable>; })}
      {actions.length === 0 ? <Text style={muted}>No actions configured for this state.</Text>
        : actions.every(action => snapshot.actionConditions?.[action.label]?.value === "false") && <Text style={muted}>No actions match the current workspace conditions.</Text>}
    </View>
    {busy && <Text style={muted}>Wait for this agent to finish before running an action.</Text>}
    {send.isError && <Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>{send.error.message}</Text>}
    {send.isSuccess && <Text style={{ ...text, color: colors.statusSuccess }}>{"sent" in send.data ? "Prompt sent to this agent." : "Workspace archive requested."}</Text>}
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: layout.compact ? 12 : 16, gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="ArrowRight" size={14} color={colors.foregroundMuted} />
        <Text style={{ ...muted, fontWeight: "500" }}>{state.transitions.length ? "Next states" : "No next states"}</Text>
      </View>
      {state.transitions.length > 0 && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {state.transitions.map(id => {
          const next = snapshot.workflow.states[id];
          return <View key={id} style={{
            flexDirection: "row", alignItems: "center", gap: 7,
            paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6,
            backgroundColor: colors.surface2, maxWidth: "100%",
          }}>
            <Icon name={next.icon ?? "GitBranch"} size={14} color={colors.accent} />
            <Text style={{ ...text, fontSize: 13, fontWeight: "500", flexShrink: 1 }}>{next.label ?? id}</Text>
          </View>;
        })}
      </View>}
    </View>
  </View>;
}

export function WorkflowPopover(props: PluginButtonContentProps) {
  if (props.context !== "agent") return null;
  return <WorkflowActions {...props} onSent={props.close} />;
}

export function WorkflowPanel(props: PluginAgentPanelProps) {
  return <ScrollView style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }} contentContainerStyle={{ padding: props.layout.compact ? 16 : 24 }}>
    <View style={{ width: "100%", maxWidth: 620, alignSelf: "center" }}>
      <WorkflowActions {...props} />
    </View>
  </ScrollView>;
}
