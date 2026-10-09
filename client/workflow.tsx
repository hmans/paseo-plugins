import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAgent, useRpc, type PluginAgentPanelProps, type PluginButtonContentProps, type PluginButtonIconProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { getWorkflow, runAction } from "../shared/workflow";

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

export function WorkflowIcon(props: PluginButtonIconProps & { onLabel(label: string): void }) {
  const query = useWorkflow(props.workspaceId, props.context === "agent" ? props.agentId : undefined);
  const data = query.data;
  const label = query.isError || data?.status === "error" ? "Workflow error"
    : data?.status === "ready" ? data.workflow.states[data.state].label ?? data.state
    : data?.status === "missing" ? "Set up workflow" : "Workflow";
  useEffect(() => props.onLabel(label), [label, props.onLabel]);
  return <Icon name="GitBranch" size={props.size} color={props.color} />;
}

type ActionsProps = Pick<PluginAgentPanelProps, "workspaceId" | "agentId" | "theme" | "layout"> & { onSent?(): void };

function WorkflowActions({ workspaceId, agentId, theme, layout, onSent }: ActionsProps) {
  const query = useWorkflow(workspaceId, agentId);
  const queryClient = useQueryClient();
  const run = useRpc(runAction);
  const agent = useAgent(agentId, agent => ({ status: agent.status }));
  const snapshot = query.data;
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
      <Text style={{ ...text, fontWeight: "600" }}>Workspace workflow</Text>
      <Text selectable style={muted}>{message}</Text>
      <Pressable accessibilityRole="button" onPress={() => { void query.refetch(); }} style={{ paddingVertical: 10 }}>
        <Text style={{ color: colors.accent }}>Refresh workflow</Text>
      </Pressable>
    </View>;
  }

  const state = snapshot.workflow.states[snapshot.state];
  const needsNewAgent = snapshot.toolsReady === false;
  const disabled = busy || send.isPending || needsNewAgent;
  return <View style={{ gap: layout.compact ? 14 : 18 }}>
    <View style={{ gap: 5 }}>
      <Text style={{ color: colors.foreground, fontSize: 22, fontWeight: "600" }}>{state.label ?? snapshot.state}</Text>
      <Text style={muted}>Choose a prompt to send to this agent.</Text>
    </View>
    {needsNewAgent && <Text style={{ ...muted, color: colors.statusWarning }}>Create a new agent in this workspace to load the workflow tools. This agent was created without them. Your workspace state will stay the same.</Text>}
    <View style={{ gap: 8 }}>
      {state.actions.map(action => <Pressable
        key={action.label}
        accessibilityRole="button"
        accessibilityLabel={action.label}
        accessibilityState={{ disabled, busy: send.isPending && send.variables === action.label }}
        disabled={disabled}
        onPress={() => send.mutate(action.label)}
        style={({ pressed }) => ({
          padding: layout.compact ? 12 : 14, gap: 6, borderRadius: 8,
          borderWidth: 1, borderColor: pressed ? colors.accent : colors.border,
          backgroundColor: pressed ? colors.surface2 : colors.surface1,
          opacity: disabled ? 0.55 : 1,
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Icon name="Send" size={15} color={colors.accent} />
          <Text style={{ ...text, flex: 1, fontWeight: "600" }}>{send.isPending && send.variables === action.label ? "Sending…" : action.label}</Text>
        </View>
        <Text numberOfLines={3} style={muted}>{action.prompt}</Text>
      </Pressable>)}
    </View>
    {busy && !needsNewAgent && <Text style={muted}>Actions are available when this agent is ready for a new prompt.</Text>}
    {send.isError && <Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>{send.error.message}</Text>}
    {send.isSuccess && <Text style={{ ...text, color: colors.statusSuccess }}>Prompt sent to this agent.</Text>}
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12, gap: 4 }}>
      <Text style={muted}>{state.transitions.length
        ? `Can move to ${state.transitions.map(id => snapshot.workflow.states[id].label ?? id).join(", ")}.`
        : "This state has no outgoing transitions."}</Text>
      <Text style={muted}>State is shared by all agents in this workspace.</Text>
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
