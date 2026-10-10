import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { changeOutline, children, getOutline, type Action, type Item, type Outline } from "../shared/tasks";

type Draft = { base: string; text: string };
type KeyEvent = { nativeEvent: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean }; preventDefault(): void };

export function OutlinePanel(props: PluginWorkspacePanelProps) {
  return <OutlineEditor key={props.workspaceId} {...props} />;
}

function OutlineEditor({ workspaceId, theme, layout }: PluginWorkspacePanelProps) {
  const c = theme.colors;
  const name = useWorkspace(workspaceId, workspace => workspace.name);
  const get = useRpc(getOutline);
  const change = useRpc(changeOutline);
  const cache = useQueryClient();
  const queryKey = ["flowtasks", workspaceId];
  const query = useQuery({ queryKey, queryFn: () => get({ workspaceId }), refetchInterval: 2000, retry: false });
  const latest = useRef<Outline>({ revision: 0, items: [] });
  const drafts = useRef(new Map<string, Draft>());
  const queue = useRef(Promise.resolve());
  const fields = useRef(new Map<string, TextInput>());
  const [editVersion, redraw] = useState(0);
  const [active, setActive] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [rowHeights, setRowHeights] = useState<Record<string, number>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Closing a panel must not cancel text waiting for the debounce timer.
      if (drafts.current.size) enqueue();
    };
  }, []);
  if (query.data && query.data.revision >= latest.current.revision) latest.current = query.data;
  const data = query.data;
  const items = data?.items ?? [];

  function accept(outline: Outline) {
    latest.current = outline;
    cache.setQueryData(queryKey, outline);
  }
  async function apply(action: Action) {
    const result = await change({ workspaceId, expectedRevision: latest.current.revision, action });
    accept(result);
    return result;
  }
  async function flush() {
    for (const [id, draft] of drafts.current) {
      const saved = latest.current.items.find(item => item.id === id);
      if (!saved || (saved.text !== draft.base && saved.text !== draft.text)) throw new Error("This task changed elsewhere. Your text is kept here. Copy it before choosing Reload tasks.");
      const text = draft.text;
      if (saved.text !== text) await apply({ type: "update", id, text });
      const current = drafts.current.get(id);
      if (current?.text === text) drafts.current.delete(id);
      else if (current) current.base = text;
    }
    if (mounted.current) redraw(value => value + 1);
  }
  function enqueue(operation?: () => Promise<void>) {
    queue.current = queue.current.then(async () => {
      if (mounted.current) setSaving(true);
      try {
        accept(await get({ workspaceId }));
        await flush();
        if (mounted.current) await operation?.();
        if (mounted.current) setError(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (mounted.current) setError(message);
        else console.error("Flowtasks could not save pending edits:", message);
      }
      finally { if (mounted.current) setSaving(false); }
    });
  }
  // Save while typing, on blur, and before structural changes. Drafts survive remote refreshes.
  useEffect(() => {
    if (!drafts.current.size) return;
    const timer = setTimeout(() => enqueue(), 650);
    return () => clearTimeout(timer);
  }, [editVersion]);
  useEffect(() => {
    if (focusId && fields.current.has(focusId)) {
      fields.current.get(focusId)?.focus();
      setFocusId(null);
    }
  }, [focusId, data]);

  function edit(item: Item, text: string) {
    const existing = drafts.current.get(item.id);
    drafts.current.set(item.id, { base: existing?.base ?? item.text, text });
    redraw(value => value + 1);
  }
  function focus(id?: string) { if (id) { setActive(id); setFocusId(id); } }
  function add(id?: string) {
    enqueue(async () => {
      const anchor = latest.current.items.find(item => item.id === id);
      if (id && !anchor) throw new Error("This task was deleted. Reload tasks.");
      const previous = new Set(latest.current.items.map(item => item.id));
      const result = await apply({ type: "create", text: "", parentId: anchor?.parentId ?? null, ...(anchor ? { afterId: anchor.id } : {}) });
      focus(result.items.find(item => !previous.has(item.id))?.id);
    });
  }
  function indent(id: string, outdent = false) {
    enqueue(async () => {
      const all = latest.current.items;
      const item = all.find(item => item.id === id);
      if (!item) return;
      const siblings = children(all, item.parentId);
      const previous = siblings[siblings.findIndex(item => item.id === id) - 1];
      const parent = all.find(parent => parent.id === item.parentId);
      if (outdent && parent) await apply({ type: "move", id, parentId: parent.parentId, afterId: parent.id });
      else if (!outdent && previous) {
        await apply({ type: "move", id, parentId: previous.id, afterId: children(all, previous.id).at(-1)?.id ?? null });
        setCollapsed(value => { const next = new Set(value); next.delete(previous.id); return next; });
      }
      focus(id);
    });
  }
  function complete(id: string) {
    enqueue(async () => {
      const item = latest.current.items.find(item => item.id === id);
      if (item) await apply({ type: "update", id, completed: !item.completed });
    });
  }
  const visible: { item: Item; depth: number }[] = [];
  const groups = new Map<string | null, Item[]>();
  for (const item of items) {
    const group = groups.get(item.parentId) ?? [];
    group.push(item);
    groups.set(item.parentId, group);
  }
  const pending = (groups.get(null) ?? []).map(item => ({ item, depth: 0 })).reverse();
  while (pending.length) {
    const entry = pending.pop()!;
    visible.push(entry);
    if (!collapsed.has(entry.item.id)) pending.push(...(groups.get(entry.item.id) ?? []).map(item => ({ item, depth: entry.depth + 1 })).reverse());
  }
  function removeEmpty(id: string) {
    const previousId = visible[visible.findIndex(entry => entry.item.id === id) - 1]?.item.id;
    enqueue(async () => {
      const item = latest.current.items.find(item => item.id === id);
      if (!item || item.text || children(latest.current.items, id).length) return;
      await apply({ type: "delete", id, deleteChildren: false });
      focus(previousId);
    });
  }
  function keyPress(event: KeyEvent, item: Item) {
    const key = event.nativeEvent;
    if (key.isComposing) return;
    if (key.key === "Tab") { event.preventDefault(); indent(item.id, !!key.shiftKey); }
    else if (key.key === "Enter" && (key.ctrlKey || key.metaKey)) { event.preventDefault(); complete(item.id); }
    else if (key.key === "Enter" && !key.shiftKey) { event.preventDefault(); add(item.id); }
    else if (key.key === "Backspace" && !(drafts.current.get(item.id)?.text ?? item.text)) { event.preventDefault(); removeEmpty(item.id); }
    else if (key.key === "ArrowUp" || key.key === "ArrowDown") {
      event.preventDefault();
      enqueue();
      const index = visible.findIndex(entry => entry.item.id === item.id);
      focus(visible[index + (key.key === "ArrowUp" ? -1 : 1)]?.item.id);
    }
  }
  const muted = { color: c.foregroundMuted, fontSize: 12 };
  const completed = items.filter(item => item.completed).length;
  const progress = items.length ? completed / items.length : 0;
  return <View style={{ flex: 1, backgroundColor: c.surface0 }}>
    <View style={{ paddingHorizontal: layout.compact ? 16 : 28, paddingTop: 16, paddingBottom: 12, gap: 4 }}>
      <Text style={{ color: c.foreground, fontSize: 18, fontWeight: "600" }}>{name ?? "Flowtasks"}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 }}>
        <View accessibilityRole="progressbar" accessibilityLabel="Task completion"
          accessibilityValue={{ min: 0, max: Math.max(1, items.length), now: completed, text: `${completed} of ${items.length} completed` }}
          style={{ width: 96, height: 5, borderRadius: 3, backgroundColor: c.surface2, overflow: "hidden" }}>
          <View style={{ width: `${progress * 100}%`, height: "100%", borderRadius: 3, backgroundColor: c.accent }} />
        </View>
        <Text style={{ ...muted, color: progress === 1 ? c.accent : c.foregroundMuted }}>
          {completed} of {items.length} completed
        </Text>
        {saving && <Text style={muted}>Saving…</Text>}
      </View>
      {!layout.compact && <Text style={muted}>Enter to add · Tab to indent · Shift+Tab to outdent · ⌘/Ctrl+Enter to complete</Text>}
    </View>
    {(error || query.isError) && <View accessibilityRole="alert" style={{ padding: 16, gap: 8 }}>
      <Text selectable style={{ color: c.foreground }}>{error ?? query.error?.message}</Text>
      <Pressable accessibilityRole="button" onPress={() => { drafts.current.clear(); setError(null); void query.refetch(); redraw(value => value + 1); }}>
        <Text style={{ color: c.accent }}>Reload tasks (discard local edits)</Text>
      </Pressable>
    </View>}
    {query.isPending && <Text style={{ ...muted, padding: 20 }}>Loading tasks…</Text>}
    <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: layout.compact ? 8 : 20, paddingBottom: 40 }}>
      {visible.map(({ item, depth }) => <View key={item.id} style={{ marginLeft: Math.min(depth, layout.compact ? 5 : 12) * 20, flexDirection: "row", alignItems: "flex-start" }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${collapsed.has(item.id) ? "Expand" : "Collapse"} task`} disabled={!groups.has(item.id)}
          onPress={() => setCollapsed(value => { const next = new Set(value); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next; })}
          style={{ width: 22, paddingVertical: 6 }}>
          {groups.has(item.id) && <Icon name={collapsed.has(item.id) ? "ChevronRight" : "ChevronDown"} size={14} color={c.foregroundMuted} />}
        </Pressable>
        <Pressable accessibilityRole="checkbox" accessibilityLabel={`Complete ${item.text || "task"}`} accessibilityState={{ checked: item.completed }} onPress={() => complete(item.id)} style={{ paddingVertical: 6, paddingRight: 8 }}>
          <Icon name={item.completed ? "CircleCheck" : "Circle"} size={14} color={item.completed ? c.accent : c.foregroundMuted} />
        </Pressable>
        <TextInput ref={field => { if (field) fields.current.set(item.id, field); else fields.current.delete(item.id); }}
          accessibilityLabel="Task" placeholder="Task" placeholderTextColor={c.foregroundMuted}
          multiline numberOfLines={1} scrollEnabled={false} value={drafts.current.get(item.id)?.text ?? item.text} onChangeText={text => edit(item, text)}
          onContentSizeChange={event => {
            if (Platform.OS === "web") return;
            const height = Math.max(26, Math.ceil(event.nativeEvent.contentSize.height));
            setRowHeights(previous => previous[item.id] === height ? previous : { ...previous, [item.id]: height });
          }}
          onFocus={() => setActive(item.id)} onBlur={() => enqueue()}
          onKeyPress={event => { if (Platform.OS === "web") keyPress(event as KeyEvent, item); }}
          submitBehavior={Platform.OS === "web" ? "newline" : "submit"}
          onSubmitEditing={() => { if (Platform.OS !== "web") add(item.id); }}
          style={{ flex: 1, minWidth: 0, minHeight: 26, fontSize: 14, lineHeight: 20, paddingVertical: 3, paddingHorizontal: 0, borderWidth: 0, backgroundColor: "transparent", textAlignVertical: "top",
            ...(Platform.OS === "web" ? { outlineWidth: 0, fieldSizing: "content", resize: "none" } : { height: rowHeights[item.id] ?? 26 }),
            color: item.completed ? c.foregroundMuted : c.foreground, textDecorationLine: item.completed ? "line-through" : "none" }} />
      </View>)}
      {data && !items.length && <Pressable accessibilityRole="button" onPress={() => add()} style={{ padding: 12 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 15 }}>+ Start your first task</Text>
      </Pressable>}
      {active && <View style={{ flexDirection: "row", gap: 20, paddingHorizontal: 22, paddingVertical: 12 }}>
        {([
          ["Add task", "Plus", () => add(active)],
          ["Indent", "IndentIncrease", () => indent(active)],
          ["Outdent", "IndentDecrease", () => indent(active, true)],
        ] as const).map(([label, icon, onPress]) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={{ padding: 8 }}>
          <Icon name={icon} size={16} color={c.foregroundMuted} />
        </Pressable>)}
      </View>}
    </ScrollView>
  </View>;
}
