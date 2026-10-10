import { completedIds, type Item } from "./tasks";

export type ViewOptions = { search: string; hideCompleted: boolean; collapsed: Set<string>; editingId?: string | null };

export function outlineView(items: Item[], options: ViewOptions) {
  const byId = new Map(items.map(item => [item.id, item]));
  const groups = new Map<string | null, Item[]>();
  for (const item of items) {
    const group = groups.get(item.parentId) ?? [];
    group.push(item);
    groups.set(item.parentId, group);
  }
  const ordered: { item: Item; depth: number }[] = [];
  const pending = (groups.get(null) ?? []).map(item => ({ item, depth: 0 })).reverse();
  const seen = new Set<string>();
  while (pending.length) {
    const entry = pending.pop()!;
    if (seen.has(entry.item.id)) continue;
    seen.add(entry.item.id);
    ordered.push(entry);
    pending.push(...(groups.get(entry.item.id) ?? []).map(item => ({ item, depth: entry.depth + 1 })).reverse());
  }
  const completed = completedIds(items);
  const search = options.search.trim().toLocaleLowerCase();
  const included = new Set<string>();
  for (const { item } of ordered) {
    if (item.id !== options.editingId && ((options.hideCompleted && completed.has(item.id)) || (search && !item.text.toLocaleLowerCase().includes(search)))) continue;
    let current: Item | undefined = item;
    while (current && seen.has(current.id) && !included.has(current.id)) {
      included.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  const hiddenIds = new Set<string>();
  const rendered = ordered.map(entry => {
    const parentHidden = entry.item.parentId !== null &&
      (hiddenIds.has(entry.item.parentId) || (!search && options.collapsed.has(entry.item.parentId)));
    const hidden = !included.has(entry.item.id) || parentHidden;
    if (hidden) hiddenIds.add(entry.item.id);
    return { ...entry, hidden };
  });
  return { groups, rendered, visible: rendered.filter(entry => !entry.hidden) };
}
