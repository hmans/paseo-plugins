import type { PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { WorkflowIcon, WorkflowPanel, WorkflowPopover } from "./workflow";
import { createActionPills } from "./action-pills";

export function registerWorkflow(client: PluginClientContext) {
  const lifetime = new AbortController();
  const pills = new Map<string, { workspaceId: string; remove(): void }>();

  function register(agent: { id: string; workspaceId?: string | null; archivedAt?: string | null }) {
    if (lifetime.signal.aborted) return;
    if (!agent.workspaceId || agent.archivedAt) {
      pills.get(agent.id)?.remove();
      pills.delete(agent.id);
      return;
    }
    if (pills.get(agent.id)?.workspaceId === agent.workspaceId) return;
    pills.get(agent.id)?.remove();
    const workspaceId = agent.workspaceId;
    const actions = createActionPills((id, button) => client.addComposerPill({ id, workspaceId, agentId: agent.id, button }));
    let registration: PluginButtonRegistration | undefined;
    const onLabel = (label: string) => registration?.update({ label, title: `Workspace workflow: ${label}` });
    function StateIcon(props: PluginButtonIconProps) { return <WorkflowIcon {...props} agentId={agent.id} onLabel={onLabel} onActions={actions.update} />; }
    registration = client.addComposerPill({
      id: "workflow", workspaceId: agent.workspaceId, agentId: agent.id,
      button: { title: "Workspace workflow", label: "Workflow", icon: StateIcon, behavior: { kind: "popover", Content: WorkflowPopover } },
    });
    pills.set(agent.id, { workspaceId, remove() { actions.dispose(); registration?.remove(); } });
  }

  client.addWorkspacePanel({ id: "workflow", title: "Workflow", icon: "GitBranch", context: "agent", Component: WorkflowPanel });
  client.addCommandCenterItem({ id: "open-workflow", title: "Open workspace workflow", icon: "GitBranch", context: "agent", onSelect: ({ openPanel }) => openPanel("workflow") });
  client.addSlashCommand({ name: "workflow", description: "Open this workspace's workflow actions", argumentHint: "", context: "agent", onSubmit: ({ openPanel }) => openPanel("workflow") });

  void client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
    if (lifetime.signal.aborted) return;
    subscription.subscribe({
      snapshot: ({ entries }) => {
        const present = new Set(entries.map(({ agent }) => agent.id));
        for (const [id, pill] of pills) {
          if (!present.has(id)) { pill.remove(); pills.delete(id); }
        }
        for (const { agent } of entries) register(agent);
      },
      update: message => {
        if (message.type !== "agent_update") return;
        const update = message.payload;
        if (update.kind === "upsert") register(update.agent);
        else { pills.get(update.agentId)?.remove(); pills.delete(update.agentId); }
      },
    });
  }).catch(error => { if (!lifetime.signal.aborted) console.error("Workflow agent subscription failed", error); });

  return () => {
    lifetime.abort();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
}
