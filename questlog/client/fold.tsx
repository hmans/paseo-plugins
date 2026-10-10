import { useEffect, useState, type ReactNode } from "react";
import { AccessibilityInfo, Platform, View, type ViewStyle } from "react-native";

export function useReducedMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (active) setReduced(value); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => { active = false; subscription.remove(); };
  }, []);
  return reduced;
}

export function FoldRow({ open, reducedMotion, children }: { open: boolean; reducedMotion: boolean; children: ReactNode }) {
  // A grid track can transition between zero and the row's natural height,
  // including wrapped text. Keep it mounted until the closing transition ends.
  const [present, setPresent] = useState(open);
  const [expanded, setExpanded] = useState(open);
  useEffect(() => {
    if (Platform.OS !== "web" || reducedMotion) { setPresent(open); setExpanded(open); return; }
    if (open) {
      setPresent(true);
      const timer = setTimeout(() => setExpanded(true), 20);
      return () => clearTimeout(timer);
    }
    setExpanded(false);
    const timer = setTimeout(() => setPresent(false), 180);
    return () => clearTimeout(timer);
  }, [open, reducedMotion]);
  if (Platform.OS !== "web") return open ? children : null;
  return <View pointerEvents={open ? "auto" : "none"} accessibilityElementsHidden={!open} importantForAccessibility={open ? "auto" : "no-hide-descendants"}
    style={{ display: "grid", gridTemplateRows: expanded ? "1fr" : "0fr", opacity: expanded ? 1 : 0,
      transitionProperty: "grid-template-rows, opacity", transitionDuration: reducedMotion ? "0ms" : "160ms", transitionTimingFunction: "ease-out" } as unknown as ViewStyle}>
    <View style={{ minHeight: 0, overflow: "hidden" }}>{present ? children : null}</View>
  </View>;
}
