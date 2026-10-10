import { useEffect, useRef, useState } from "react";
import type { GestureResponderEvent, ScrollView, View } from "react-native";
import { dropAction, dropBoundary, dropTargetAt, type DropTarget } from "../shared/drag";
import type { Item } from "../shared/tasks";

type Bounds = { id: string; top: number; height: number };
type Drag = { sourceId: string; target: DropTarget | null; items: Item[] };

export function useOutlineDrag(items: Item[], onDrop: (drag: Drag) => void) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [lineY, setLineY] = useState<number | null>(null);
  const current = useRef<Drag | null>(null);
  const rows = useRef(new Map<string, View>());
  const viewport = useRef<View>(null);
  const scroll = useRef<ScrollView>(null);
  const offset = useRef(0);
  const measuredOffset = useRef(0);
  const bounds = useRef<Bounds[]>([]);
  const frame = useRef({ top: 0, height: 0 });
  const pointer = useRef<number | null>(null);
  const maxScroll = useRef(0);
  const contentHeight = useRef(0);
  const generation = useRef(0);
  const press = useRef<{ x: number; y: number } | null>(null);

  function cancel() { generation.current++; current.current = null; pointer.current = null; press.current = null; setDrag(null); setLineY(null); }
  function update(y: number) {
    pointer.current = y;
    const active = current.current;
    if (!active) return;
    const adjusted = y + offset.current - measuredOffset.current;
    const withinViewport = y >= frame.current.top && y <= frame.current.top + frame.current.height;
    const candidate = withinViewport ? dropTargetAt(bounds.current, adjusted, active.target) : null;
    const target = candidate && dropAction(active.items, active.sourceId, candidate) ? candidate : null;
    const boundary = dropBoundary(bounds.current, target);
    setLineY(boundary === null ? null : boundary - frame.current.top - (offset.current - measuredOffset.current));
    if (active.target?.id !== target?.id || active.target?.position !== target?.position) {
      current.current = { ...active, target };
      setDrag(current.current);
    }
  }
  function start(sourceId: string, event: GestureResponderEvent) {
    const token = ++generation.current;
    const active = { sourceId, target: null, items };
    current.current = active;
    setDrag(active);
    pointer.current = event.nativeEvent.pageY;
    measuredOffset.current = offset.current;
    bounds.current = [];
    viewport.current?.measureInWindow((_x, top, _width, height) => {
      frame.current = { top, height };
      maxScroll.current = Math.max(0, contentHeight.current - height);
    });
    for (const [id, row] of rows.current) row.measureInWindow((_x, top, _width, height) => {
      if (token !== generation.current) return;
      bounds.current.push({ id, top, height });
      if (pointer.current !== null) update(pointer.current);
    });
  }
  useEffect(() => {
    if (!drag) return;
    const timer = setInterval(() => {
      const y = pointer.current;
      const { top, height } = frame.current;
      if (y === null || !height) return;
      const delta = y < top + 36 ? -8 : y > top + height - 36 ? 8 : 0;
      if (delta) scroll.current?.scrollTo({ y: Math.max(0, Math.min(maxScroll.current, offset.current + delta)), animated: false });
    }, 30);
    return () => clearInterval(timer);
  }, [!!drag]);
  useEffect(() => () => { generation.current++; current.current = null; }, []);

  return {
    drag, lineY, rows, viewport, scroll, cancel,
    onScroll(y: number) { offset.current = y; if (pointer.current !== null) update(pointer.current); },
    onContentSize(height: number) { contentHeight.current = height; maxScroll.current = Math.max(0, height - frame.current.height); },
    handle(sourceId: string, onClick: () => void, enabled = true) {
      return {
        onStartShouldSetResponder: () => true,
        onResponderGrant: (event: GestureResponderEvent) => {
          press.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
        },
        onResponderMove: (event: GestureResponderEvent) => {
          const origin = press.current;
          if (!origin) return;
          if (enabled && !current.current && Math.hypot(event.nativeEvent.pageX - origin.x, event.nativeEvent.pageY - origin.y) >= 5) start(sourceId, event);
          if (current.current) update(event.nativeEvent.pageY);
        },
        onResponderRelease: (event: GestureResponderEvent) => {
          const origin = press.current;
          if (current.current) update(event.nativeEvent.pageY);
          const result = current.current;
          const clicked = !result && origin && Math.hypot(event.nativeEvent.pageX - origin.x, event.nativeEvent.pageY - origin.y) < 5;
          cancel();
          if (result?.target) onDrop(result);
          else if (clicked) onClick();
        },
        onResponderTerminationRequest: () => !current.current,
        onResponderTerminate: cancel,
      };
    },
  };
}
