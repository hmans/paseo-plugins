import { Platform } from "react-native";

// React Native Web filters out the title prop, so attach it to the rendered element.
export function hoverTitle(title: string) {
  return (element: unknown) => {
    if (Platform.OS !== "web" || !element) return;
    const target = element as { setAttribute?: (name: string, value: string) => void };
    target.setAttribute?.("title", title);
  };
}
