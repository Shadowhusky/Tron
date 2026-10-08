/** Buffer line of the nearest command start above (dir -1) or below (dir 1) the viewport top. */
export function nextCommandLine(lines: number[], viewportTop: number, dir: -1 | 1): number | null {
  const valid = lines.filter((l) => l >= 0).sort((a, b) => a - b);
  const found = dir < 0
    ? valid.reverse().find((l) => l < viewportTop)
    : valid.find((l) => l > viewportTop);
  return found ?? null;
}
