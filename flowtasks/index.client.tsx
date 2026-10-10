import type { PluginClientContext } from "@getpaseo/plugin/client";
import { OutlinePanel } from "./client/outline";
import { registerTaskCards } from "./client/task-card";

export default function contribute(client: PluginClientContext) {
  registerTaskCards(client);
  client.addWorkspacePanel({ id: "tasks", title: "Flowtasks", icon: "ListTodo", context: "workspace", locations: ["workspace", "explorer"], Component: OutlinePanel });
  client.addCommandCenterItem({ id: "open-tasks", title: "Open Flowtasks", icon: "ListTodo", context: "workspace", onSelect: ({ openPanel }) => openPanel("tasks") });
  return () => {};
}
