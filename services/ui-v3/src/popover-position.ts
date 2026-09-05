export function placeNodePopover(anchor: { left: number; top: number; bottom: number }, size: { width: number; height: number }, viewport: { width: number; height: number }) {
  const margin = 12, gap = 8;
  const width = Math.min(size.width, viewport.width - margin * 2);
  const height = Math.min(size.height, viewport.height - margin * 2);
  const left = Math.max(margin, Math.min(anchor.left, viewport.width - width - margin));
  const above = anchor.top - height - gap;
  const below = anchor.bottom + gap;
  const top = above >= margin ? above : below + height <= viewport.height - margin ? below : Math.max(margin, Math.min(above, viewport.height - height - margin));
  return { left, top, width, maxHeight: viewport.height - margin * 2 };
}
