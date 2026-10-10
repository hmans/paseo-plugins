import { children, descendants, type Item } from "./tasks";

export type DropTarget = { id: string; position: "before" | "inside" | "after" };

export type RowBounds = { id: string; top: number; height: number };

export function dropBoundary(rows: RowBounds[], target: DropTarget | null): number | null {
  if (!target || target.position === "inside") return null;
  const row = rows.find(row => row.id === target.id);
  return row ? row.top + (target.position === "after" ? row.height : 0) : null;
}

export function dropTargetAt(rows: RowBounds[], y: number, previous: DropTarget | null): DropTarget | null {
  const priorRow = rows.find(row => row.id === previous?.id);
  if (previous && priorRow) {
    const start = priorRow.top + priorRow.height * (previous.position === "before" ? 0 : previous.position === "inside" ? 0.25 : 0.75);
    const end = priorRow.top + priorRow.height * (previous.position === "before" ? 0.25 : previous.position === "inside" ? 0.75 : 1);
    // Require deliberate movement across a boundary before changing the indicator.
    if (y >= start - 4 && y <= end + 4) return previous;
  }
  const row = rows.find(row => row.height > 0 && y >= row.top && y < row.top + row.height);
  if (!row) return null;
  return { id: row.id, position: y < row.top + row.height * 0.25 ? "before" : y > row.top + row.height * 0.75 ? "after" : "inside" };
}

export function dropAction(items: Item[], sourceId: string, target: DropTarget) {
  const source = items.find(item => item.id === sourceId);
  const destination = items.find(item => item.id === target.id);
  if (!source || !destination || sourceId === target.id || descendants(items, sourceId).has(target.id)) return null;
  const siblings = children(items, destination.parentId).filter(item => item.id !== sourceId);
  const index = siblings.findIndex(item => item.id === target.id);
  const parentId = target.position === "inside" ? target.id : destination.parentId;
  const afterId = target.position === "inside" ? children(items, target.id).filter(item => item.id !== sourceId).at(-1)?.id ?? null
    : target.position === "after" ? target.id : siblings[index - 1]?.id ?? null;
  return { type: "move" as const, id: sourceId, parentId, afterId };
}

export function structure(items: Item[]) {
  return JSON.stringify(items.map(({ id, parentId }) => [id, parentId]));
}
