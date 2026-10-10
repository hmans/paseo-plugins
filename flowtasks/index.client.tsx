import type { PluginClientContext } from "@getpaseo/plugin/client";
import { OutlinePanel } from "./client/outline";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({ id: "tasks", title: "Flowtasks", icon: "ListTodo", context: "workspace", locations: ["workspace", "explorer"], Component: OutlinePanel });
  client.addCommandCenterItem({ id: "open-tasks", title: "Open Flowtasks", icon: "ListTodo", context: "workspace", onSelect: ({ openPanel }) => openPanel("tasks") });
  client.addSlashCommand({ name: "flowtasks", description: "Open this workspace's task outline", argumentHint: "", context: "workspace", onSubmit: ({ openPanel }) => openPanel("tasks") });
  return () => {};
}
