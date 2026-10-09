import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { operations } from "../shared/workflow";

export const operationHandlers: Record<keyof typeof operations, (workspaceId: string, context: PluginHandlerContext) => Promise<void>> = {
  "workspace.archive": async (workspaceId, { paseo }) => {
    const result = await paseo.workspaces.ref(workspaceId).archive();
    if (result.error || !result.archivedAt) throw new Error(result.error ?? "Paseo did not archive the workspace.");
  },
};
