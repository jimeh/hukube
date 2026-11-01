import type { IBuffer, IBufferCellPosition, IMarker, Terminal } from "@xterm/xterm";

// Read the existing logical line, rather than predicting xterm's reflow. A
// wide glyph can leave one empty cell before its continuation on the next row.
function logicalLine(buffer: IBuffer, row: number, cols: number) {
  let start = row;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  const parts: { row: number; text: string; columns: number }[] = [];
  let text = "";
  for (let y = start; y < buffer.length; y++) {
    const line = buffer.getLine(y)!;
    const next = buffer.getLine(y + 1);
    const wrapped = next?.isWrapped;
    const last = line.getCell(cols - 1);
    const padding =
      wrapped &&
      last?.getCode() === 0 &&
      last.getWidth() === 1 &&
      next.getCell(0)?.getWidth() === 2;
    const columns = cols - (padding ? 1 : 0);
    const part = line.translateToString(!wrapped, 0, columns);
    parts.push({ row: y, text: part, columns });
    text += part;
    if (!wrapped) break;
  }
  return { start, parts, text };
}

type LogicalLine = ReturnType<typeof logicalLine>;

function textOffset(buffer: IBuffer, line: LogicalLine, point: IBufferCellPosition) {
  let offset = 0;
  for (const part of line.parts) {
    if (part.row === point.y) {
      return (
        offset +
        Math.min(
          part.text.length,
          buffer.getLine(part.row)!.translateToString(false, 0, Math.min(point.x, part.columns))
            .length,
        )
      );
    }
    offset += part.text.length;
  }
  return offset;
}

function position(buffer: IBuffer, line: LogicalLine, offset: number) {
  for (const part of line.parts) {
    if (offset > part.text.length) {
      offset -= part.text.length;
      continue;
    }
    const row = buffer.getLine(part.row)!;
    let length = 0;
    for (let x = 0; x < part.columns; x++) {
      const cell = row.getCell(x)!;
      if (!cell.getWidth()) continue;
      if (length === offset) return { x, y: part.row };
      length += (cell.getChars() || " ").length;
    }
    if (length === offset) return { x: part.columns, y: part.row };
    return;
  }
}

/** Preserve a retained linear selection across one synchronous terminal fit. */
export function fitWithSelection(terminal: Terminal, fit: () => void): void {
  const selected = terminal.getSelection();
  const range = terminal.getSelectionPosition();
  if (!selected || !range) {
    fit();
    return;
  }
  const buffer = terminal.buffer.active;
  const cols = terminal.cols;
  const rows = terminal.rows;
  const markers: IMarker[] = [];
  const capture = (point: IBufferCellPosition) => {
    if (point.y === buffer.length && point.x === 0) point = { x: cols, y: point.y - 1 };
    const line = logicalLine(buffer, point.y, cols);
    // The cursor's logical line and alternate buffer retain physical rows,
    // cropping their cells instead of reflowing them. Logical prefix offsets
    // cannot identify a later retained row once earlier rows have been cropped.
    if (
      buffer.type === "alternate" ||
      line.parts.some((part) => part.row === buffer.baseY + buffer.cursorY)
    ) {
      const physical = terminal.registerMarker(point.y - buffer.baseY - buffer.cursorY);
      if (physical) markers.push(physical);
      const part = line.parts.find((candidate) => candidate.row === point.y)!;
      const rowLine = { start: point.y, parts: [part], text: part.text };
      // Copied text excludes a hard row's empty suffix. Normalize that endpoint
      // on this row only, so earlier cropped rows cannot affect its column.
      const x = position(buffer, rowLine, textOffset(buffer, rowLine, point))?.x;
      return {
        physical,
        x,
        prefix:
          x === undefined ? undefined : buffer.getLine(point.y)!.translateToString(false, 0, x),
      };
    }
    // Mark the first row: continuation rows may be deleted when a line unwraps.
    const marker = terminal.registerMarker(line.start - buffer.baseY - buffer.cursorY);
    if (marker) markers.push(marker);
    // If narrowing trims the logical line's prefix, its following boundary can
    // still anchor the retained suffix. Never search for matching text elsewhere.
    const afterRow = line.parts.at(-1)!.row + 1;
    const after =
      afterRow < buffer.length
        ? terminal.registerMarker(afterRow - buffer.baseY - buffer.cursorY)
        : undefined;
    if (after) markers.push(after);
    return { line, marker, after, offset: textOffset(buffer, line, point) };
  };
  try {
    const start = capture(range.start);
    const end = capture(range.end);
    fit();
    if (terminal.cols === cols && terminal.rows === rows) return;
    if (terminal.buffer.active !== buffer) return;
    const restore = (anchor: typeof start) => {
      if ("physical" in anchor) {
        if (
          !anchor.physical ||
          anchor.physical.isDisposed ||
          anchor.x === undefined ||
          anchor.x > terminal.cols
        )
          return;
        const row = buffer.getLine(anchor.physical.line);
        if (row?.translateToString(false, 0, anchor.x) !== anchor.prefix) return;
        return { x: anchor.x, y: anchor.physical.line };
      }
      if (!anchor.marker) return;
      const prefixTrimmed = anchor.marker?.isDisposed;
      if (prefixTrimmed && (!anchor.after || anchor.after.isDisposed || anchor.after.line < 1))
        return;
      const row = prefixTrimmed ? anchor.after!.line - 1 : anchor.marker.line;
      const line = logicalLine(buffer, row, terminal.cols);
      const removed = prefixTrimmed ? anchor.line.text.length - line.text.length : 0;
      if (removed < 0 || anchor.offset < removed) return;
      const offset = anchor.offset - removed;
      // Only the prefix through this endpoint must survive; the final selected
      // text check below also verifies every cell between the endpoints.
      if (offset > line.text.length) return;
      if (line.text.slice(0, offset) !== anchor.line.text.slice(removed, anchor.offset)) return;
      return position(buffer, line, offset);
    };
    const from = restore(start);
    const to = restore(end);
    if (!from || !to) {
      terminal.clearSelection();
      return;
    }
    // Public select/getSelectionPosition use zero-based buffer rows and cells
    // in xterm 6. A selection length counts cells, not JavaScript characters.
    terminal.select(from.x, from.y, (to.y - from.y) * terminal.cols + to.x - from.x);
    if (terminal.getSelection() !== selected) terminal.clearSelection();
  } finally {
    for (const marker of markers) marker.dispose();
  }
}
