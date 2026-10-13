import { pointerDistance, pointerIntersection, type CollisionDetector } from "@dnd-kit/collision";

/** Extend the header's ends horizontally, without accepting drops outside its row. */
export const headerCollision: CollisionDetector = (input) => {
  const bounds = input.droppable.shape?.boundingRectangle;
  const pointer = input.dragOperation.position.current;
  if (!bounds || pointer.y < bounds.top || pointer.y > bounds.bottom) return null;
  return pointerIntersection(input) ?? pointerDistance(input);
};

export type DropEdge = "left" | "right";

/** The edge of a header nearer the pointer, which is where a drop would land. */
export function dropEdge(pointerX: number, header: { left: number; right: number }): DropEdge {
  return pointerX < (header.left + header.right) / 2 ? "left" : "right";
}

/**
 * Where a column dropped at an edge of target lands: its position among the
 * shown columns once source is taken out, as `moveColumnTo` expects.
 * Undefined when either is not shown or the column is dropped on itself.
 */
export function dropPosition(
  shown: readonly string[],
  source: string,
  target: string,
  edge: DropEdge,
): number | undefined {
  const from = shown.indexOf(source);
  const at = shown.indexOf(target);
  if (from === -1 || at === -1 || from === at) return undefined;
  const others = at > from ? at - 1 : at;
  return edge === "left" ? others : others + 1;
}
