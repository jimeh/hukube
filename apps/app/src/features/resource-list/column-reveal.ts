interface HorizontalBounds {
  left: number;
  right: number;
}

/** Reveal only a clipped column, preferring the space beside an open checklist. */
export function columnRevealDelta(
  column: HorizontalBounds,
  viewport: HorizontalBounds,
  menu: HorizontalBounds | undefined,
): number {
  if (column.left >= viewport.left && column.right <= viewport.right) return 0;
  let { left, right } = viewport;
  const width = column.right - column.left;
  if (menu && menu.left < right && menu.right > left) {
    if (menu.left - left >= width) right = menu.left;
    else if (right - menu.right >= width) left = menu.right;
  }
  return (column.left + column.right - left - right) / 2;
}
