export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface InspectorPlacement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: "above" | "below" | "left" | "right";
}

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(value, maximum));

export function visibleCanvasRect(stage: RectLike, windowWidth: number, windowHeight: number): RectLike {
  const left = clamp(stage.left, 0, Math.max(0, windowWidth - 1));
  const top = clamp(stage.top, 0, Math.max(0, windowHeight - 1));
  const right = Math.max(left + 1, Math.min(stage.right, windowWidth));
  const bottom = Math.max(top + 1, Math.min(stage.bottom, windowHeight));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** Inspector zoom is transient UI state, never a graph viewport/node resize. */
export function zoomInspector(scale: number, factor: number) {
  return clamp(scale * factor, 0.5, 2);
}

/** Same exponential wheel response as the canvas, including trackpad pinch. */
export function inspectorWheelFactor(deltaY: number, deltaMode = 0, ctrlKey = false) {
  const speed = deltaMode === 1 ? 0.05 : deltaMode === 2 ? 1 : 0.002;
  return Math.pow(2, clamp(-deltaY * speed * (ctrlKey ? 10 : 1), -1, 1));
}

/**
 * Place an inspector next to its preview inside the actual canvas rectangle.
 * Below/above mirrors TapNow's preview + composer stack; a side placement is a
 * fallback for short viewports.
 */
export function placeInspectorPanel(stage: RectLike, anchor: RectLike, requested: { width: number; height: number }): InspectorPlacement {
  const margin = 12;
  const gap = 10;
  const safeLeft = stage.left + margin;
  const safeTop = stage.top + margin;
  const safeRight = stage.right - margin;
  const safeBottom = stage.bottom - margin;
  const availableWidth = Math.max(1, safeRight - safeLeft);
  const availableHeight = Math.max(1, safeBottom - safeTop);
  const width = Math.min(requested.width, availableWidth);
  const height = Math.min(requested.height, availableHeight);
  const belowRoom = Math.max(0, safeBottom - anchor.bottom - gap);
  const aboveRoom = Math.max(0, anchor.top - gap - safeTop);
  const rightRoom = Math.max(0, safeRight - anchor.right - gap);
  const leftRoom = Math.max(0, anchor.left - gap - safeLeft);
  const usefulVerticalRoom = Math.min(height, 220);
  const usefulHorizontalRoom = Math.min(width, 360);

  let placement: InspectorPlacement["placement"];
  if (belowRoom >= usefulVerticalRoom) placement = "below";
  else if (aboveRoom >= usefulVerticalRoom) placement = "above";
  else if (Math.max(rightRoom, leftRoom) >= usefulHorizontalRoom) placement = rightRoom >= leftRoom ? "right" : "left";
  else placement = belowRoom >= aboveRoom ? "below" : "above";

  if (placement === "below") {
    return {
      left: clamp(anchor.left + anchor.width / 2 - width / 2, safeLeft, safeRight - width),
      top: Math.min(anchor.bottom + gap, safeBottom - Math.min(height, Math.max(180, belowRoom))),
      width,
      maxHeight: Math.max(180, belowRoom),
      placement,
    };
  }
  if (placement === "above") {
    const maxHeight = Math.max(180, aboveRoom);
    return {
      left: clamp(anchor.left + anchor.width / 2 - width / 2, safeLeft, safeRight - width),
      top: Math.max(safeTop, anchor.top - gap - Math.min(height, maxHeight)),
      width,
      maxHeight,
      placement,
    };
  }
  if (placement === "right") {
    const sideWidth = Math.min(width, Math.max(240, rightRoom));
    return {
      left: Math.min(anchor.right + gap, safeRight - sideWidth),
      top: clamp(anchor.top, safeTop, safeBottom - height),
      width: sideWidth,
      maxHeight: availableHeight,
      placement,
    };
  }
  const sideWidth = Math.min(width, Math.max(240, leftRoom));
  return {
    left: Math.max(safeLeft, anchor.left - gap - sideWidth),
    top: clamp(anchor.top, safeTop, safeBottom - height),
    width: sideWidth,
    maxHeight: availableHeight,
    placement,
  };
}
