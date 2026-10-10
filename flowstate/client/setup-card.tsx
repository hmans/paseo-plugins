import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { actionCardSchema, parseActionCard } from "../shared/action-card";
import { parseSetupCard, setupCardSchema } from "../shared/setup-card";

function SetupCard({ item, theme, layout }: PluginTimelineItemProps<{ prompt: string }>) {
  const [expanded, setExpanded] = useState(false);
  const c = theme.colors;
  return <View style={{ padding: layout.compact ? 12 : 16, gap: 10, borderRadius: 10,
    borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name="GitBranch" size={16} color={c.accent} />
      <Text style={{ color: c.foregroundMuted, fontSize: 12, flex: 1 }}>Flowstate · Setup requested</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={expanded ? "Hide setup instructions" : "Show setup instructions"}
        accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)}
        style={{ padding: 8, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Details</Text>
        <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={c.foregroundMuted} />
      </Pressable>
    </View>
    <Text style={{ color: c.foreground, fontSize: 15, fontWeight: "600" }}>Set up a project workflow</Text>
    <Text style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 19 }}>Tailor the stages and actions to this project, then validate the workflow.</Text>
    {expanded && <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: 12 }}>
      <Text selectable style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{item.data.prompt}</Text>
    </View>}
  </View>;
}

function ActionCard({ item, theme, layout }: PluginTimelineItemProps<{ label: string; icon: string; prompt: string }>) {
  const [expanded, setExpanded] = useState(false);
  const c = theme.colors;
  return <View style={{ padding: layout.compact ? 12 : 16, gap: 10, borderRadius: 10,
    borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name={item.data.icon} size={16} color={c.accent} />
      <Text style={{ color: c.foregroundMuted, fontSize: 12, flex: 1 }}>Flowstate · Action requested</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={expanded ? "Hide action instructions" : "Show action instructions"}
        accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)}
        style={{ padding: 8, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Details</Text>
        <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={c.foregroundMuted} />
      </Pressable>
    </View>
    <Text selectable style={{ color: c.foreground, fontSize: 15, fontWeight: "600" }}>{item.data.label}</Text>
    {expanded && <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: 12 }}>
      <Text selectable style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{item.data.prompt}</Text>
    </View>}
  </View>;
}

export function registerSetupCards(client: PluginClientContext) {
  client.addTimelineTransformer({
    id: "action-card", query: { itemType: "user_message" },
    transform({ item }) {
      const data = parseActionCard(item.text);
      if (!data) return;
      return { items: [{ type: "plugin", kind: "flowstate-action", version: 1, data }] };
    },
  });
  client.addTimelineRenderer({ kind: "flowstate-action", version: 1, schema: actionCardSchema, Component: ActionCard });
  client.addTimelineTransformer({
    id: "setup-card", query: { itemType: "user_message" },
    transform({ item }) {
      const data = parseSetupCard(item.text);
      if (!data) return;
      return { items: [{ type: "plugin", kind: "flowstate-setup", version: 1, data }] };
    },
  });
  client.addTimelineRenderer({ kind: "flowstate-setup", version: 1, schema: setupCardSchema, Component: SetupCard });
}
