import { useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, Switch, Text, TextInput, View, type PressableProps, type ViewProps } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/react-native";
import { changeOutline, children, completedIds, getOutline, type Action, type Item, type Outline } from "../shared/tasks";
import { dropAction, structure } from "../shared/drag";
import { useOutlineDrag } from "./drag";
import { FoldRow, useReducedMotion } from "./fold";
import { useWorkOnTask } from "./work";
import { outlineView } from "../shared/view";
import { descriptionBoundary } from "./caret";

type Draft = { base: string; text: string; description?: { base: string; text: string } };
type KeyEvent = { nativeEvent: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean }; currentTarget?: unknown; preventDefault(): void };

function TaskActionButton({ disabled, children, ...props }: Omit<PressableProps, "style" | "children"> & {
  children: (active: boolean) => ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  return <Pressable {...props} disabled={disabled}
    onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
    style={{ padding: 8, opacity: disabled ? 0.35 : 1 }}>
    {({ pressed }) => children(!disabled && (hovered || pressed))}
  </Pressable>;
}

function CompletionHandle({ children, ...props }: Omit<ViewProps, "children"> & { children: (active: boolean) => ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  return <View {...props}
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onResponderGrant={event => { setPressed(true); props.onResponderGrant?.(event); }}
    onResponderRelease={event => { setPressed(false); props.onResponderRelease?.(event); }}
    onResponderTerminate={event => { setPressed(false); props.onResponderTerminate?.(event); }}>
    {children(hovered || pressed)}
  </View>;
}

export function OutlinePanel(props: PluginWorkspacePanelProps) {
  return <View style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }}>
    <OutlineEditor key={props.workspaceId} {...props} />
  </View>;
}

function OutlineEditor({ workspaceId, theme, layout, navigation }: PluginWorkspacePanelProps) {
  const c = theme.colors;
  const reducedMotion = useReducedMotion();
  const name = useWorkspace(workspaceId, workspace => workspace.name);
  const get = useRpc(getOutline);
  const change = useRpc(changeOutline);
  const cache = useQueryClient();
  const queryKey = ["questlog", workspaceId];
  const query = useQuery({ queryKey, queryFn: () => get({ workspaceId }), refetchInterval: 2000, retry: false });
  const latest = useRef<Outline>({ revision: 0, items: [] });
  const drafts = useRef(new Map<string, Draft>());
  const queue = useRef(Promise.resolve());
  const fields = useRef(new Map<string, TextInput>());
  const descriptionFields = useRef(new Map<string, TextInput>());
  const [descriptionId, setDescriptionId] = useState<string | null>(null);
  const [focusDescriptionId, setFocusDescriptionId] = useState<string | null>(null);
  const [editVersion, redraw] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [search, setSearch] = useState("");
  const [hideCompleted, setHideCompleted] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; text: string } | null>(null);
  const work = useWorkOnTask(workspaceId);
  const workPending = useRef(false);
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
  const { groups, rendered, visible } = outlineView(items, { search, hideCompleted, collapsed, editingId });
  const filtering = !!search.trim() || hideCompleted;
  const drag = useOutlineDrag(items, ({ sourceId, target, items: original }) => {
    if (!target || filtering) return;
    enqueue(async () => {
      if (structure(original) !== structure(latest.current.items)) throw new Error("The task order changed while dragging. Try the move again.");
      const action = dropAction(latest.current.items, sourceId, target);
      if (!action) return;
      await apply(action);
      if (target.position === "inside") setCollapsed(value => { const next = new Set(value); next.delete(target.id); return next; });
      focus(sourceId);
    });
  });
  useEffect(() => { drag.cancel(); }, [search, hideCompleted]);

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
      const description = draft.description?.text;
      if (draft.description && (saved.description ?? "") !== draft.description.base && (saved.description ?? "") !== description) throw new Error("This description changed elsewhere. Your edit is kept here. Copy it before choosing Reload tasks.");
      if (saved.text !== text || (description !== undefined && (saved.description ?? "") !== description)) await apply({ type: "update", id, text, ...(description === undefined ? {} : { description }) });
      const current = drafts.current.get(id);
      if (current?.text === text && current.description?.text === description) drafts.current.delete(id);
      else if (current) {
        current.base = text;
        if (current.description && description !== undefined) current.description.base = description;
      }
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
        else console.error("Questlog could not save pending edits:", message);
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
  useEffect(() => {
    if (focusDescriptionId) {
      descriptionFields.current.get(focusDescriptionId)?.focus();
      setFocusDescriptionId(null);
    }
  }, [focusDescriptionId]);

  function edit(item: Item, text: string) {
    const existing = drafts.current.get(item.id);
    drafts.current.set(item.id, { ...existing, base: existing?.base ?? item.text, text });
    redraw(value => value + 1);
  }
  function editDescription(item: Item, text: string) {
    const existing = drafts.current.get(item.id);
    drafts.current.set(item.id, { base: existing?.base ?? item.text, text: existing?.text ?? item.text,
      description: { base: existing?.description?.base ?? item.description ?? "", text } });
    redraw(value => value + 1);
  }
  function focus(id?: string) { if (id) setFocusId(id); }
  function add(id?: string) {
    enqueue(async () => {
      const anchor = latest.current.items.find(item => item.id === id);
      if (id && !anchor) throw new Error("This task was deleted. Reload tasks.");
      const previous = new Set(latest.current.items.map(item => item.id));
      const result = await apply({ type: "create", text: "", parentId: anchor?.parentId ?? null, ...(anchor ? { afterId: anchor.id } : {}) });
      setSearch("");
      setHideCompleted(false);
      const created = result.items.find(item => !previous.has(item.id));
      setCollapsed(value => {
        const next = new Set(value);
        let parentId = created?.parentId;
        const seen = new Set<string>();
        while (parentId && !seen.has(parentId)) {
          seen.add(parentId);
          next.delete(parentId);
          parentId = result.items.find(item => item.id === parentId)?.parentId;
        }
        return next;
      });
      focus(created?.id);
    });
  }
  function indent(id: string, outdent = false) {
    if (filtering) return;
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
  function removeEmpty(id: string) {
    const previousId = visible[visible.findIndex(entry => entry.item.id === id) - 1]?.item.id;
    enqueue(async () => {
      const item = latest.current.items.find(item => item.id === id);
      if (!item || item.text || item.description || children(latest.current.items, id).length) return;
      await apply({ type: "delete", id, deleteChildren: false });
      focus(previousId);
    });
  }
  function keyPress(event: KeyEvent, item: Item) {
    const key = event.nativeEvent;
    if (key.isComposing) return;
    if (key.key === "Escape" && drag.drag) { event.preventDefault(); drag.cancel(); return; }
    if (key.key === "Tab") { event.preventDefault(); indent(item.id, !!key.shiftKey); }
    else if (key.key === "Enter" && (key.ctrlKey || key.metaKey)) { event.preventDefault(); complete(item.id); }
    else if (key.key === "Enter" && key.shiftKey) {
      event.preventDefault();
      setDescriptionId(item.id);
      setFocusDescriptionId(item.id);
    }
    else if (key.key === "Enter" && !key.shiftKey) { event.preventDefault(); add(item.id); }
    else if (key.key === "Backspace" && !(drafts.current.get(item.id)?.text ?? item.text)) { event.preventDefault(); removeEmpty(item.id); }
    else if (key.key === "ArrowUp" || key.key === "ArrowDown") {
      event.preventDefault();
      enqueue();
      const index = visible.findIndex(entry => entry.item.id === item.id);
      focus(visible[index + (key.key === "ArrowUp" ? -1 : 1)]?.item.id);
    }
  }
  function descriptionKeyPress(event: KeyEvent, item: Item) {
    const key = event.nativeEvent;
    if (key.isComposing || key.shiftKey || key.ctrlKey || key.metaKey) return;
    const up = key.key === "ArrowUp" && descriptionBoundary(event.currentTarget, "up");
    const down = key.key === "ArrowDown" && descriptionBoundary(event.currentTarget, "down");
    const next = up ? item.id : down ? visible[visible.findIndex(entry => entry.item.id === item.id) + 1]?.item.id : undefined;
    if (next) { event.preventDefault(); focus(next); }
  }
  const muted = { color: c.foregroundMuted, fontSize: 12 };
  const effectiveCompleted = completedIds(items);
  const completed = effectiveCompleted.size;
  const progress = items.length ? completed / items.length : 0;
  return <View style={{ flex: 1, width: "100%", maxWidth: 820, alignSelf: "center", backgroundColor: c.surface0 }}>
    <View style={{ paddingHorizontal: layout.compact ? 16 : 28, paddingTop: 16, paddingBottom: 12, gap: 4 }}>
      <Text style={{ color: c.foreground, fontSize: 18, fontWeight: "600" }}>{name ?? "Questlog"}</Text>
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
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexGrow: 1, flexBasis: 160, minWidth: 0,
          backgroundColor: c.surface1, borderRadius: 6, paddingLeft: 10 }}>
          <Icon name="Search" size={14} color={c.foregroundMuted} />
          <TextInput accessibilityLabel="Search tasks" placeholder="Search tasks…" placeholderTextColor={c.foregroundMuted}
            value={search} onChangeText={setSearch} style={{ flex: 1, minWidth: 0, padding: 8, color: c.foreground, fontSize: 13 }} />
          {!!search && <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setSearch("")} style={{ padding: 10 }}>
            <Icon name="X" size={14} color={c.foregroundMuted} />
          </Pressable>}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4, paddingVertical: 6 }}>
          <Text style={muted}>Hide completed</Text>
          <Switch accessibilityLabel="Hide completed" value={hideCompleted} onValueChange={setHideCompleted}
            trackColor={{ false: c.surface2, true: c.accent }} thumbColor={c.foreground} ios_backgroundColor={c.surface2} />
        </View>
      </View>
      {filtering && <Text style={muted}>Clear filters to reorder tasks. Progress includes all workspace tasks.</Text>}
    </View>
    {(error || query.isError) && <View accessibilityRole="alert" style={{ padding: 16, gap: 8 }}>
      <Text selectable style={{ color: c.foreground }}>{error ?? query.error?.message}</Text>
      <Pressable accessibilityRole="button" onPress={() => { drafts.current.clear(); setError(null); void query.refetch(); redraw(value => value + 1); }}>
        <Text style={{ color: c.accent }}>Reload tasks (discard local edits)</Text>
      </Pressable>
    </View>}
    {query.isPending && <Text style={{ ...muted, padding: 20 }}>Loading tasks…</Text>}
    <View ref={drag.viewport} style={{ flex: 1, overflow: "hidden" }}>
    <ScrollView ref={drag.scroll} style={{ flex: 1 }} keyboardShouldPersistTaps="handled" scrollEventThrottle={16}
      onScroll={event => drag.onScroll(event.nativeEvent.contentOffset.y)} onContentSizeChange={(_width, height) => drag.onContentSize(height)}
      contentContainerStyle={{ paddingHorizontal: layout.compact ? 8 : 20, paddingBottom: 40 }}>
      {rendered.map(({ item, depth, hidden }) => <FoldRow key={item.id} open={!hidden} reducedMotion={reducedMotion}>
        <View ref={row => { if (row && !hidden) drag.rows.current.set(item.id, row); else drag.rows.current.delete(item.id); }}
        style={{ marginLeft: Math.min(depth, layout.compact ? 5 : 12) * 20, flexDirection: "row", alignItems: "flex-start",
          opacity: drag.drag?.sourceId === item.id ? 0.4 : 1,
          backgroundColor: drag.drag?.target?.id === item.id && drag.drag.target.position === "inside" ? c.surface2 : "transparent" }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${collapsed.has(item.id) && !search.trim() ? "Expand" : "Collapse"} task`} disabled={!groups.has(item.id) || !!search.trim()}
          onPress={() => setCollapsed(value => { const next = new Set(value); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next; })}
          style={{ width: 22, paddingVertical: 6 }}>
          {groups.has(item.id) && <View style={{ transform: [{ rotate: collapsed.has(item.id) && !search.trim() ? "-90deg" : "0deg" }],
            ...(Platform.OS === "web" ? { transitionProperty: "transform", transitionDuration: reducedMotion ? "0ms" : "160ms", transitionTimingFunction: "ease-out" } : {}) }}>
            <Icon name="ChevronDown" size={14} color={c.foregroundMuted} />
          </View>}
        </Pressable>
        <CompletionHandle {...drag.handle(item.id, () => complete(item.id), !filtering)} accessibilityRole="checkbox" accessible focusable
          accessibilityLabel={`Complete ${item.text || "task"}`} accessibilityState={{ checked: item.completed }}
          accessibilityHint={filtering ? "Click to toggle completion." : "Click to toggle completion. Drag to move the task."}
          accessibilityActions={[{ name: "activate", label: "Toggle completion" }]}
          onAccessibilityAction={event => { if (event.nativeEvent.actionName === "activate") complete(item.id); }}
          {...(Platform.OS === "web" ? { onKeyDown: (event: { nativeEvent: { key: string; repeat?: boolean }; preventDefault(): void }) => {
            if (event.nativeEvent.key === "Escape") { drag.cancel(); return; }
            if (event.nativeEvent.key === " " || event.nativeEvent.key === "Enter") {
              event.preventDefault();
              if (!event.nativeEvent.repeat) complete(item.id);
            }
          } } : {})}
          style={{ paddingVertical: 6, paddingRight: 8, ...(Platform.OS === "web" ? { cursor: "pointer" as const, touchAction: "none", userSelect: "none" as const } : {}) }}>
          {active => <Icon name={item.completed ? "CircleCheck" : "Circle"} size={14} color={active ? c.foreground : item.completed ? c.accent : c.foregroundMuted} />}
        </CompletionHandle>
        <View style={{ flex: 1, minWidth: 0 }}>
        <TextInput ref={field => { if (field) fields.current.set(item.id, field); else fields.current.delete(item.id); }}
          accessibilityLabel="Task title" placeholder="Task title" placeholderTextColor={c.foregroundMuted} editable={!hidden}
          multiline numberOfLines={1} scrollEnabled={false} value={drafts.current.get(item.id)?.text ?? item.text} onChangeText={text => edit(item, text)}
          onContentSizeChange={event => {
            if (Platform.OS === "web") return;
            const height = Math.max(26, Math.ceil(event.nativeEvent.contentSize.height));
            setRowHeights(previous => previous[item.id] === height ? previous : { ...previous, [item.id]: height });
          }}
          onFocus={() => setEditingId(item.id)} onBlur={() => { setEditingId(null); enqueue(); }}
          onKeyPress={event => { if (Platform.OS === "web") keyPress(event as KeyEvent, item); }}
          submitBehavior={Platform.OS === "web" ? "newline" : "submit"}
          onSubmitEditing={() => { if (Platform.OS !== "web") add(item.id); }}
          style={{ minWidth: 0, minHeight: 26, fontSize: 14, lineHeight: 20, paddingVertical: 3, paddingHorizontal: 0, borderWidth: 0, backgroundColor: "transparent", textAlignVertical: "top",
            ...(Platform.OS === "web" ? { outlineWidth: 0, fieldSizing: "content", resize: "none" } : { height: rowHeights[item.id] ?? 26 }),
            color: effectiveCompleted.has(item.id) ? c.foregroundMuted : c.foreground, textDecorationLine: effectiveCompleted.has(item.id) ? "line-through" : "none" }} />
        {(descriptionId === item.id || !!(drafts.current.get(item.id)?.description?.text ?? item.description)) && <TextInput
          ref={field => { if (field) descriptionFields.current.set(item.id, field); else descriptionFields.current.delete(item.id); }}
          accessibilityLabel={`Description for ${item.text || "task"}`}
          editable={!hidden} multiline scrollEnabled={false}
          value={drafts.current.get(item.id)?.description?.text ?? item.description ?? ""}
          onChangeText={text => editDescription(item, text)}
          onContentSizeChange={event => {
            if (Platform.OS === "web") return;
            const height = Math.max(22, Math.ceil(event.nativeEvent.contentSize.height));
            const key = `description:${item.id}`;
            setRowHeights(previous => previous[key] === height ? previous : { ...previous, [key]: height });
          }}
          onFocus={() => { setEditingId(item.id); setDescriptionId(item.id); }}
          onBlur={() => { setEditingId(null); setDescriptionId(null); enqueue(); }}
          onKeyPress={event => { if (Platform.OS === "web") descriptionKeyPress(event as KeyEvent, item); }}
          style={{ minHeight: 22, fontSize: 12, lineHeight: 18, color: c.foregroundMuted, paddingVertical: 2, paddingHorizontal: 0,
            textAlignVertical: "top", backgroundColor: "transparent", borderWidth: 0,
            ...(Platform.OS === "web" ? { outlineWidth: 0, fieldSizing: "content", resize: "none" } : { height: rowHeights[`description:${item.id}`] ?? 22 }),
            opacity: effectiveCompleted.has(item.id) ? 0.5 : 1,
            textDecorationLine: effectiveCompleted.has(item.id) ? "line-through" : "none" }} />}
        </View>
        <TaskActionButton accessibilityRole="button" accessibilityLabel={`Work on this now: ${item.text || "task"}`}
          accessibilityHint="Send this task and its subtasks to the most recently used agent in this workspace."
          accessibilityState={{ disabled: hidden || saving || work.isPending || !work.canWork || !(drafts.current.get(item.id)?.text ?? item.text).trim() }}
          disabled={hidden || saving || work.isPending || !work.canWork || !(drafts.current.get(item.id)?.text ?? item.text).trim()}
          onPress={() => {
            if (workPending.current || !work.canWork) return;
            workPending.current = true;
            enqueue(async () => {
              const agentId = await work.mutateAsync({ taskId: item.id, expectedRevision: latest.current.revision });
              if (agentId) navigation?.openAgent({ agentId });
            });
            void queue.current.finally(() => { workPending.current = false; });
          }}>
          {active => <Icon name="Play" size={14} color={active ? c.foreground : c.accent} />}
        </TaskActionButton>
        <TaskActionButton accessibilityRole="button" accessibilityLabel={`Delete task: ${item.text || "task"}`}
          accessibilityHint="Ask for confirmation before deleting this task and all its subtasks."
          accessibilityState={{ disabled: hidden || saving }} disabled={hidden || saving}
          onPress={() => setDeleteTarget({ id: item.id, text: drafts.current.get(item.id)?.text ?? item.text })}>
          {active => <Icon name="Trash2" size={14} color={active ? c.foreground : c.foregroundMuted} />}
        </TaskActionButton>
      </View></FoldRow>)}
      {data && !items.length && <Pressable accessibilityRole="button" onPress={() => add()} style={{ padding: 12 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 15 }}>+ Start your first task</Text>
      </Pressable>}
      {data && items.length > 0 && visible.length === 0 && <Text style={{ ...muted, padding: 12 }}>No tasks match this view.</Text>}
    </ScrollView>
    {/* One overlay centered on the shared row boundary, outside folding clips. */}
    <View pointerEvents="none" style={{ position: "absolute", height: 2, backgroundColor: c.accent,
      opacity: drag.lineY === null ? 0 : 1, top: (drag.lineY ?? 0) - 1,
      left: (layout.compact ? 8 : 20) + Math.min(visible.find(entry => entry.item.id === drag.drag?.target?.id)?.depth ?? 0, layout.compact ? 5 : 12) * 20,
      right: layout.compact ? 8 : 20 }} />
    </View>
    <Modal title="Delete task?" open={deleteTarget !== null} onOpenChange={open => { if (!open) setDeleteTarget(null); }}>
      <Modal.Content>
        <Text style={{ color: c.foreground }}>
          Delete “{deleteTarget?.text || "Untitled task"}” and all its subtasks? This cannot be undone.
        </Text>
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 12 }}>
          <Pressable accessibilityRole="button" onPress={() => setDeleteTarget(null)} style={{ padding: 10 }}>
            <Text style={{ color: c.foreground }}>Cancel</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => {
            if (!deleteTarget) return;
            const { id } = deleteTarget;
            setDeleteTarget(null);
            enqueue(async () => { await apply({ type: "delete", id, deleteChildren: true }); });
          }} style={{ padding: 10, borderRadius: 6, backgroundColor: c.surface2 }}>
            <Text style={{ color: c.foreground, fontWeight: "600" }}>Delete task</Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  </View>;
}
