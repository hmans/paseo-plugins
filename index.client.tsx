import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerWorkflow } from "./client/register";

export default function contribute(client: PluginClientContext) {
  return registerWorkflow(client);
}
