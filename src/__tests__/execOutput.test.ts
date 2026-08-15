import { describe, it, expect } from "vitest";
import { cleanExecCapture, stripOscSequences } from "../../electron/ipc/execOutput";

const SENTINEL = "__TRON_DONE_abc123__";
const CMD = `cat package.json | python3 -c "import sys,json; json.load(sys.stdin); print('valid JSON')"`;
const WRAPPED = `${CMD}; printf '\\n${SENTINEL}%d\\n' $?`;
// Shell-integration preexec marker: URL-encoded command line — letters and
// underscores are NOT %-encoded, so the sentinel appears VERBATIM inside it.
const enc = (s: string) => encodeURIComponent(s).replace(/'/g, "%27");
const BLOCK_START = `\x1b]1337;TronBlockStart;88974;7;${enc(WRAPPED)}\x07`;
const BLOCK_END = `\x1b]1337;TronBlockEnd;88974;7;0\x07`;

describe("stripOscSequences", () => {
  it("removes complete OSC sequences including their payload (BEL and ST terminated)", () => {
    expect(stripOscSequences(`a${BLOCK_START}b\x1b]0;title\x1b\\c`)).toBe("abc");
  });

  it("leaves ordinary text and CSI sequences alone", () => {
    expect(stripOscSequences("plain \x1b[32mgreen\x1b[0m")).toBe("plain \x1b[32mgreen\x1b[0m");
  });
});

describe("cleanExecCapture", () => {
  it("replays log f62ad06c2b: quiet one-line command with a TronBlockStart leak", () => {
    // zle redraws erased the echo via bare \r; the marker's embedded sentinel
    // copy sits BEFORE the real output. Old code cut there — the agent saw
    // only "1337;TronBlockStart;…" and looped re-validating package.json.
    const raw =
      `${WRAPPED}\r` + // echo segment erased by \r-overwrite handling
      `\r\n${BLOCK_START}valid JSON\r\n` +
      `\r\n${SENTINEL}0\r\n`;
    const out = cleanExecCapture(raw, SENTINEL);
    expect(out).toBe("valid JSON");
    expect(out).not.toContain("1337;TronBlockStart");
  });

  it("ignores the command echo's sentinel copy (followed by %d, not digits)", () => {
    const raw =
      `${WRAPPED}\r\n` + // echo survives intact on line 1
      `line one\r\nline two\r\n` +
      `\r\n${SENTINEL}0\r\n`;
    expect(cleanExecCapture(raw, SENTINEL)).toBe("line one\r\nline two");
  });

  it("keeps output on the stall path (no sentinel printed yet)", () => {
    const raw = `${WRAPPED}\r\n${BLOCK_START}Fetching layers...\r\nstill working\r\n`;
    const out = cleanExecCapture(raw, SENTINEL);
    expect(out).toContain("Fetching layers...");
    expect(out).toContain("still working");
    expect(out).not.toContain("TronBlockStart");
    expect(out).not.toContain(SENTINEL);
  });

  it("strips ANSI colors and the closing block marker", () => {
    const raw =
      `${WRAPPED}\r\n` +
      `\x1b[32mok\x1b[0m\r\n` +
      `\r\n${SENTINEL}0\r\n${BLOCK_END}prompt %`;
    expect(cleanExecCapture(raw, SENTINEL)).toBe("ok");
  });
});
