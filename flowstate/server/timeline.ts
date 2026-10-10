import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { ReadyWorkflow, Transition } from "../shared/workflow";

export async function publishTransition(
  paseo: PluginHandlerContext["paseo"], agentId: string, input: Transition,
  snapshot: ReadyWorkflow, actor: "user" | "agent",
) {
  try {
    await paseo.agents.ref(agentId).timeline.append({
      type: "plugin", id: `transition-${snapshot.revision}`, kind: "flowstate-transition", version: 1,
      data: {
        from: snapshot.workflow.states[input.expectedState].label ?? input.expectedState,
        to: snapshot.workflow.states[snapshot.state].label ?? snapshot.state,
        actor,
      },
    });
  } catch (error) {
    // State is already saved. A display failure must not make the caller retry the transition.
    console.error("Flowstate transition saved, but timeline publication failed:", error);
  }
}
