import { expect, it } from "vitest";
import { filterLogContent, parseLogContent } from "./log-content.ts";

it("removes 28 hostile escape sequences whole", () => {
  const hostile = [
    "\x1b[2J",
    "\x1b[3J",
    "\x1b[?1049h",
    "\x1b[?1049l",
    "\x1b[H",
    "\x1b[4A",
    "\x1b[2K",
    "\x1b[1;2r",
    "\x1b]0;title\x07",
    "\x1b]2;title\x1b\\",
    "\x1b]8;;https://evil\x07",
    "\x1b]52;c;secret\x07",
    "\x1bPpayload\x1b\\",
    "\x1b_payload\x1b\\",
    "\x1b^payload\x1b\\",
    "\x1bXpayload\x1b\\",
    "\x1b(B",
    "\x1b)0",
    "\x1b7",
    "\x1b8",
    "\x9b2J",
    "\x9d0;title\x9c",
    "\x90payload\x9c",
    "\x1b]unterminated",
    "\x1bPunterminated",
    "\x1b_unterminated",
    "\x1b^unterminated",
    "\x1bXunterminated",
  ];
  expect(hostile).toHaveLength(28);
  for (const sequence of hostile) expect(filterLogContent(`safe${sequence}`)).toBe("safe");
});
it("resolves progress and pictures control bytes without interpreting markup", () => {
  expect(filterLogContent("10%\r50%\r100%\r")).toBe("100%");
  expect(filterLogContent("\0\x01\x08\t\n\x1b\x7f\x80\x9a")).toBe("␀␁␈\t␊␛␡��");
  expect(parseLogContent('<script>alert(1)</script><img onerror="bad">').text).toBe(
    '<script>alert(1)</script><img onerror="bad">',
  );
});
it("retains colors and four styles, maps extended colors, and caps spans", () => {
  expect(parseLogContent("\x1b[31;7;5;8;9mred").spans).toEqual([[0, 3, 1, -1, 0]]);
  expect(parseLogContent("\x1b[38:2::255:85:85mred").spans?.[0]?.[2]).toBe(9);
  const colored = parseLogContent("\x1b[31;1;2;3;4mred\x1b[0m normal");
  expect(colored).toEqual({ text: "red normal", spans: [[0, 3, 1, -1, 15]] });
  expect(parseLogContent("\x1b[38;2;255;85;85mred").spans?.[0]?.[2]).toBe(9);
  expect(parseLogContent("\x1b[38;5;196mred").spans?.[0]?.[2]).toBe(1);
  expect(parseLogContent("\x1b[44mblue").spans?.[0]?.[3]).toBe(4);
  expect(parseLogContent("\x1b[31ma\x1b[32mb".repeat(50)).spans).toHaveLength(32);
});
