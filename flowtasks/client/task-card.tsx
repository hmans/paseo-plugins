import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { z } from "zod";
import { parseTaskCard, taskCardSchema } from "../shared/task-card";

function TaskCard({ item, theme, layout }: PluginTimelineItemProps<z.output<typeof taskCardSchema>>) {
  const [expanded, setExpanded] = useState(false);
  const c = theme.colors;
  return <View style={{ padding: layout.compact ? 12 : 16, gap: 10, borderRadius: 10,
    borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name="ListTodo" size={16} color={c.accent} />
      <Text style={{ color: c.foregroundMuted, fontSize: 12, flex: 1 }}>Flowtasks · Work on task</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={expanded ? "Hide task details" : "Show task details"}
        accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)}
        style={{ padding: 8, flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Details</Text>
        <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={c.foregroundMuted} />
      </Pressable>
    </View>
    <Text selectable numberOfLines={expanded ? undefined : 3} style={{ color: c.foreground, fontSize: 14, lineHeight: 20 }}>{item.data.text}</Text>
    {expanded && <View style={{ borderTopWidth: 1, borderColor: c.border, paddingTop: 10 }}>
      <Text selectable style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{item.data.prompt}</Text>
    </View>}
  </View>;
}

export function registerTaskCards(client: PluginClientContext) {
  client.addTimelineTransformer({
    id: "task-card", query: { itemType: "user_message" },
    transform({ item }) {
      const data = parseTaskCard(item.text);
      if (!data) return;
      return { items: [{ type: "plugin", kind: "task-card", version: 1, data }] };
    },
  });
  client.addTimelineRenderer({ kind: "task-card", version: 1, schema: taskCardSchema, Component: TaskCard });
}
