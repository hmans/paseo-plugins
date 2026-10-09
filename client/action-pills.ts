import type { PluginButton, PluginButtonRegistration } from "@getpaseo/plugin/client";
import type { WorkflowSnapshot } from "../shared/workflow";

export function actionButtons(snapshot: WorkflowSnapshot | undefined, busy: boolean, onPress: (label: string) => Promise<void>): PluginButton[] {
  if (snapshot?.status !== "ready") return [];
  return snapshot.workflow.states[snapshot.state].actions.map(action => {
    const condition = snapshot.actionConditions?.[action.label];
    const reason = snapshot.toolsReady === false ? "Create a new agent to load workflow tools."
      : action.when && condition?.value !== "true" ? condition?.message ?? "Condition is not met."
      : busy ? "Wait for this agent to finish." : undefined;
    return {
      label: action.label,
      title: reason ? `${action.label}: ${reason}` : action.prompt,
      icon: "Send",
      visible: condition?.value !== "false",
      disabled: !!reason,
      behavior: { kind: "action", onPress: () => onPress(action.label) },
    };
  });
}

// Keep registration order stable, and release all pills when an agent disappears.
export function createActionPills(add: (id: string, button: PluginButton) => PluginButtonRegistration) {
  const registrations: PluginButtonRegistration[] = [];
  let disposed = false;
  return {
    update(buttons: PluginButton[]) {
      if (disposed) return;
      while (registrations.length > buttons.length) registrations.pop()!.remove();
      buttons.forEach((button, index) => {
        if (registrations[index]) registrations[index].update(button);
        else registrations.push(add(`workflow-action-${index}`, button));
      });
    },
    dispose() {
      disposed = true;
      for (const registration of registrations) registration.remove();
      registrations.length = 0;
    },
  };
}
