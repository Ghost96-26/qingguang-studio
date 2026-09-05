import test from "node:test";
import assert from "node:assert/strict";
import { inspectorWheelFactor, zoomInspector, placeInspectorPanel, visibleCanvasRect } from "../src/focus-layout.ts";

const stage = { left: 68, top: 60, right: 1610, bottom: 980, width: 1542, height: 920 };

test("inspector respects visible window even when the desktop canvas overflows a narrow panel", () => {
  const visible = visibleCanvasRect(stage, 518, 789);
  const anchor = { left: 289, top: 385, right: 480, bottom: 488, width: 191, height: 103 };
  const panel = placeInspectorPanel(visible, anchor, { width: 540, height: 277 });
  assert.ok(panel.left >= 68);
  assert.ok(panel.left + panel.width <= 518);
  assert.ok(panel.top + Math.min(277, panel.maxHeight) <= 789);
});

test("inspector zoom is independent, reversible and has useful limits", () => {
  assert.equal(zoomInspector(1, 1.2), 1.2);
  assert.equal(zoomInspector(1.2, 1 / 1.2), 1);
  assert.equal(zoomInspector(1, 0.1), 0.5);
  assert.equal(zoomInspector(1, 10), 2);
  assert.equal(zoomInspector(2, 0.5), 1);
});

test("wheel and trackpad pinch zoom in the expected direction without huge jumps", () => {
  assert.ok(inspectorWheelFactor(-80) > 1);
  assert.ok(inspectorWheelFactor(80) < 1);
  assert.equal(inspectorWheelFactor(0), 1);
  assert.equal(inspectorWheelFactor(-100000), 2);
  assert.equal(inspectorWheelFactor(100000), 0.5);
  assert.equal(inspectorWheelFactor(-10, 0, true), inspectorWheelFactor(-100));
  assert.ok(inspectorWheelFactor(-2, 1) > 1);
});

test("editor remains aligned with preview centre through repeated inspector zoom", () => {
  const anchor = { left: 620, top: 180, right: 1058, bottom: 426, width: 438, height: 246 };
  const centre = anchor.left + anchor.width / 2;
  for (const scale of [0.5, 0.8, 1, 1.2, 1.5, 2]) {
    const panel = placeInspectorPanel(stage, anchor, { width: 540 * scale, height: 280 * scale });
    assert.equal(panel.placement, "below");
    assert.ok(Math.abs(panel.left + panel.width / 2 - centre) < 0.001);
    assert.equal(panel.top, anchor.bottom + 10);
  }
});

test("inspector prefers the space below a preview and remains inside the canvas", () => {
  const anchor = { left: 420, top: 180, right: 858, bottom: 426, width: 438, height: 246 };
  const position = placeInspectorPanel(stage, anchor, { width: 540, height: 430 });
  assert.equal(position.placement, "below");
  assert.ok(position.top >= anchor.bottom);
  assert.ok(position.left >= stage.left + 12);
  assert.ok(position.left + position.width <= stage.right - 12);
  assert.ok(position.top + Math.min(430, position.maxHeight) <= stage.bottom - 12);
});

test("inspector moves above a low preview instead of defaulting to the bottom right", () => {
  const anchor = { left: 800, top: 700, right: 1238, bottom: 946, width: 438, height: 246 };
  const position = placeInspectorPanel(stage, anchor, { width: 540, height: 430 });
  assert.equal(position.placement, "above");
  assert.ok(position.top + Math.min(430, position.maxHeight) <= anchor.top);
  assert.ok(position.left + position.width <= stage.right - 12);
});

test("short canvases use a side placement and clamp to the canvas bounds", () => {
  const shortStage = { left: 68, top: 60, right: 1610, bottom: 580, width: 1542, height: 520 };
  const anchor = { left: 510, top: 170, right: 948, bottom: 416, width: 438, height: 246 };
  const position = placeInspectorPanel(shortStage, anchor, { width: 540, height: 500 });
  assert.ok(position.placement === "right" || position.placement === "left");
  assert.ok(position.left >= shortStage.left + 12);
  assert.ok(position.left + position.width <= shortStage.right - 12);
  assert.ok(position.top >= shortStage.top + 12);
});
