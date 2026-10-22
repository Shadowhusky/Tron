import { describe, it, expect } from "vitest";
import { looksDegenerate, shingleDiversity } from "../utils/degeneration";

/** The real thing, reproduced from a live stuck run. */
const REAL_DEGENERATE = '"     :     "}Now:{"     ,     "}EMIT:{"     :     "}JSON:{"     ,     "}Emit:{"'.repeat(40);

describe("looksDegenerate — the live sample", () => {
  it("flags the repetition loop that made the agent look stuck", () => {
    expect(looksDegenerate(REAL_DEGENERATE)).toBe(true);
  });

  it("flags a simple single-token loop", () => {
    expect(looksDegenerate("JSON:".repeat(300))).toBe(true);
    expect(looksDegenerate('{"tool":'.repeat(200))).toBe(true);
  });

  it("flags a whitespace-padded loop", () => {
    expect(looksDegenerate('Now:   {   "   }   '.repeat(120))).toBe(true);
  });
});

describe("looksDegenerate — must not fire on legitimate output", () => {
  it("ignores short outputs entirely", () => {
    expect(looksDegenerate("")).toBe(false);
    expect(looksDegenerate('{"tool":"final_answer","content":"Done."}')).toBe(false);
    expect(looksDegenerate("JSON:".repeat(20))).toBe(false); // under the length floor
  });

  it("passes a normal long tool call", () => {
    const content = Array.from({ length: 60 }, (_, i) =>
      `  const value${i} = computeSomething(${i}, options);`).join("\\n");
    expect(looksDegenerate(`{"tool":"write_file","path":"/tmp/a.ts","content":"${content}"}`)).toBe(false);
  });

  it("passes repetitive but real file content — CSV rows", () => {
    const csv = Array.from({ length: 200 }, (_, i) =>
      `${i},user${i}@example.com,2026-08-${(i % 28) + 1},active,${i * 37}`).join("\\n");
    expect(looksDegenerate(csv)).toBe(false);
  });

  it("passes a long block of import statements", () => {
    const imports = Array.from({ length: 120 }, (_, i) =>
      `import { thing${i} } from "./module${i}";`).join("\\n");
    expect(looksDegenerate(imports)).toBe(false);
  });

  it("passes real varied prose", () => {
    const sentences = [
      "The agent reads the terminal output and decides what to do next.",
      "Cargo was not installed, so the toolchain check failed early.",
      "Homebrew is present at /opt/homebrew and can install rustup.",
      "The scan walks each directory in parallel and aggregates sizes bottom-up.",
      "Symlinks are not followed, which avoids cycles on macOS system paths.",
      "Permission errors are skipped silently rather than aborting the walk.",
      "Results are cached per directory so navigating back is instant.",
      "The footer shows total, used and free space for the mounted volume.",
    ];
    const prose = Array.from({ length: 30 }, (_, i) => sentences[i % sentences.length]).join(" ");
    expect(prose.length).toBeGreaterThan(600);
    expect(looksDegenerate(prose)).toBe(false);
  });

  it("passes an ASCII rule that sits inside a document", () => {
    // Only the TAIL is judged, so a rule followed by real content is safe —
    // which is the realistic shape. (An output that is nothing BUT 700 dashes
    // is correctly treated as degenerate.)
    const doc = "# Report\\n" + "-".repeat(700) + "\\n" +
      Array.from({ length: 20 }, (_, i) =>
        `Finding ${i}: subsystem ${i} reported ${i * 13} anomalies during the scan.`).join("\\n");
    expect(looksDegenerate(doc)).toBe(false);
  });

  it("KNOWN LIMIT: an identical block repeated many times is treated as degenerate", () => {
    // Documented tradeoff. A model emitting the same sentence 40× back-to-back
    // is indistinguishable from a repetition loop, and in practice IS one — but
    // it does mean a genuinely repetitive artefact could be cut short. The
    // token cap, not this detector, is the guarantee against runaway output.
    const identical = "This exact sentence repeats with no variation whatsoever. ".repeat(40);
    expect(looksDegenerate(identical)).toBe(true);
  });
});

describe("shingleDiversity", () => {
  it("collapses toward zero on a locked cycle and stays high on prose", () => {
    expect(shingleDiversity("abcdefgh".repeat(100))).toBeLessThan(0.1);
    expect(shingleDiversity(
      "the quick brown fox jumps over the lazy dog while the agent keeps working steadily",
    )).toBeGreaterThan(0.8);
  });
});
