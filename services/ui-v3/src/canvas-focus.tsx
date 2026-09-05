import { createContext, useContext } from "react";

export interface CanvasFocusContextValue {
  focusedNodeId: string | null;
  detailScale: number;
  closeFocusedNode: () => void;
}

export const CanvasFocusContext = createContext<CanvasFocusContextValue | null>(null);

export function useCanvasFocus() {
  const value = useContext(CanvasFocusContext);
  if (!value) throw new Error("CanvasFocusContext is unavailable");
  return value;
}
