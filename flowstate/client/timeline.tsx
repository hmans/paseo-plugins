import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";

export function TransitionRow({ item, theme, layout }: PluginTimelineItemProps<{
  from: string; to: string; actor: "user" | "agent";
}>) {
  return <View style={{ padding: layout.compact ? 10 : 14, gap: 6, borderLeftWidth: 2, borderLeftColor: theme.colors.accent }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name="GitBranch" size={16} color={theme.colors.accent} />
      <Text style={{ color: theme.colors.foreground, fontWeight: "600", flexShrink: 1 }}>
        {item.data.from} → {item.data.to}
      </Text>
    </View>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
      Flowstate · Changed by {item.data.actor === "user" ? "the user" : "the agent"}
    </Text>
  </View>;
}
