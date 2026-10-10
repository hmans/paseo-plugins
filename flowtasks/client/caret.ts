/// <reference lib="dom" />

// Textareas do not expose caret geometry. Mirror their typography and wrapping
// to distinguish the first/last visual line, including soft-wrapped text.
export function descriptionBoundary(target: unknown, direction: "up" | "down"): boolean {
  const field = target as HTMLTextAreaElement | null;
  if (!field || field.tagName !== "TEXTAREA" || field.selectionStart !== field.selectionEnd) return false;
  const document = field.ownerDocument;
  const style = document.defaultView?.getComputedStyle(field);
  if (!style) return false;
  const mirror = document.createElement("div");
  for (const property of Array.from(style)) mirror.style.setProperty(property, style.getPropertyValue(property));
  Object.assign(mirror.style, { position: "absolute", visibility: "hidden", pointerEvents: "none",
    height: "auto", minHeight: "0", maxHeight: "none", overflow: "visible", whiteSpace: "pre-wrap",
    overflowWrap: "break-word", width: `${field.getBoundingClientRect().width}px`, boxSizing: "border-box" });
  document.body.appendChild(mirror);
  try {
    const top = (offset: number) => {
      mirror.textContent = field.value.slice(0, offset);
      const marker = document.createElement("span");
      marker.textContent = field.value.slice(offset) || "\u200b";
      mirror.appendChild(marker);
      return marker.getClientRects()[0]?.top ?? marker.getBoundingClientRect().top;
    };
    const caret = top(field.selectionStart);
    const boundary = top(direction === "up" ? 0 : field.value.length);
    return Math.abs(caret - boundary) < 1;
  } finally { mirror.remove(); }
}
