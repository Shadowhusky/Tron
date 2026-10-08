import { describe, it, expect } from "vitest";
import {
  findLinks,
  buildLogicalLine,
  fileUrlToPath,
  type LinkMatch,
} from "../utils/terminalLinks";

const only = (text: string): LinkMatch => {
  const links = findLinks(text);
  expect(links).toHaveLength(1);
  return links[0];
};
const urls = (text: string) => findLinks(text).filter((l) => l.kind === "url").map((l) => l.url);
const paths = (text: string) => findLinks(text).filter((l) => l.kind === "path").map((l) => l.path);

describe("findLinks — URLs", () => {
  it("links a dev-server URL and keeps the range exact", () => {
    const text = "  ➜  Local:   http://localhost:5173/";
    const l = only(text);
    expect(l).toMatchObject({ kind: "url", url: "http://localhost:5173/" });
    expect(text.slice(l.start, l.end)).toBe("http://localhost:5173/");
  });

  it("strips trailing sentence punctuation but keeps query and fragment", () => {
    expect(urls("Visit https://example.com/a?b=1&c=2#frag.")).toEqual(["https://example.com/a?b=1&c=2#frag"]);
    expect(urls("See https://x.com/a: it works")).toEqual(["https://x.com/a"]);
    expect(urls("Is it https://x.com/a?")).toEqual(["https://x.com/a"]);
  });

  it("keeps balanced parens but drops an unbalanced closer", () => {
    expect(urls("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    expect(urls("(see https://x.com/a)")).toEqual(["https://x.com/a"]);
    expect(urls("(see https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
  });

  it("links only the URL of a markdown link", () => {
    const text = "Read [the docs](https://x.dev/guide) first";
    const l = only(text);
    expect(l.url).toBe("https://x.dev/guide");
    expect(l.start).toBe(text.indexOf("https"));
  });

  it("excludes surrounding quotes, backticks and markdown emphasis", () => {
    expect(urls('open "https://example.com/q" now')).toEqual(["https://example.com/q"]);
    expect(urls("`https://example.com/q`")).toEqual(["https://example.com/q"]);
    expect(urls("**https://x.com/a**")).toEqual(["https://x.com/a"]);
  });

  it("stops at CJK text and CJK punctuation", () => {
    expect(urls("访问https://example.com/获取")).toEqual(["https://example.com/"]);
    expect(urls("请打开 https://example.com/docs。")).toEqual(["https://example.com/docs"]);
  });

  it("never includes box-drawing frame glyphs", () => {
    const text = "│ https://github.com/org/repo/pull/12 │";
    expect(only(text).url).toBe("https://github.com/org/repo/pull/12");
    expect(urls("│https://github.com/org/repo│")).toEqual(["https://github.com/org/repo"]);
  });

  it("turns bare local addresses into http URLs", () => {
    const l = only("listening on 0.0.0.0:8000");
    expect(l.url).toBe("http://localhost:8000");
    expect(l.text).toBe("0.0.0.0:8000");
    expect(urls("Server ready at localhost:3000/api")).toEqual(["http://localhost:3000/api"]);
    expect(urls("bound 127.0.0.1:9229.")).toEqual(["http://127.0.0.1:9229"]);
    expect(urls("ipv6 [::1]:5000")).toEqual(["http://[::1]:5000"]);
  });

  it("ignores local addresses with an out-of-range port", () => {
    expect(urls("listening on localhost:99999")).toEqual([]);
    expect(urls("listening on localhost:65535")).toEqual(["http://localhost:65535"]);
  });

  it("rewrites a 0.0.0.0 host in a full URL to localhost", () => {
    const l = only("Uvicorn running on http://0.0.0.0:8080/ (Press CTRL+C)");
    expect(l.url).toBe("http://localhost:8080/");
    expect(l.text).toBe("http://0.0.0.0:8080/");
  });

  it("does not link version numbers, ratios or generic host:port", () => {
    expect(findLinks("version 1.2.3, ratio 3:4, db:5432")).toEqual([]);
  });

  it("does not link a path inside a URL separately", () => {
    const links = findLinks("https://github.com/x/y/blob/main/src/a.ts");
    expect(links).toHaveLength(1);
    expect(links[0].kind).toBe("url");
  });

  it("treats file:// URLs as paths", () => {
    expect(only("open file:///Users/x/My%20Doc.txt").path).toBe("/Users/x/My Doc.txt");
  });
});

describe("findLinks — paths", () => {
  it("unwraps Claude Code tool calls", () => {
    const text = "⏺ Update(src/foo.ts)";
    const l = only(text);
    expect(l).toMatchObject({ kind: "path", path: "src/foo.ts" });
    expect(text.slice(l.start, l.end)).toBe("src/foo.ts");
  });

  it("ignores tool-result gutters with no path", () => {
    expect(findLinks("  ⎿  Read 42 lines (ctrl+r to expand)")).toEqual([]);
  });

  it("excludes frame glyphs around and against a path", () => {
    expect(paths("│ /Users/x/proj/src/a.ts │")).toEqual(["/Users/x/proj/src/a.ts"]);
    expect(paths("│/Users/x/a.ts│")).toEqual(["/Users/x/a.ts"]);
    expect(paths("⠋ Reading /x/y/z.ts")).toEqual(["/x/y/z.ts"]);
  });

  it("parses TypeScript (line,col) locations", () => {
    const text = "src/a.ts(12,5): error TS2322: Type 'x' is not assignable";
    const l = findLinks(text)[0];
    expect(l).toMatchObject({ kind: "path", path: "src/a.ts", line: 12, col: 5, text: "src/a.ts(12,5)" });
  });

  it("parses node stack frames", () => {
    const l = only("    at fn (/x/y.js:12:5)");
    expect(l).toMatchObject({ path: "/x/y.js", line: 12, col: 5, text: "/x/y.js:12:5" });
  });

  it("parses python traceback frames, including spaces in the path", () => {
    expect(only('  File "/usr/lib/python3/x.py", line 12, in <module>')).toMatchObject({
      path: "/usr/lib/python3/x.py",
      line: 12,
    });
    expect(only('  File "/Users/me/My Project/app.py", line 3').path).toBe("/Users/me/My Project/app.py");
  });

  it("parses eslint and pytest style locations", () => {
    expect(findLinks("/Users/x/proj/src/a.ts:12:5  error  'x' is unused")[0]).toMatchObject({
      path: "/Users/x/proj/src/a.ts",
      line: 12,
      col: 5,
    });
    expect(only("src/a.ts:12:5: warning")).toMatchObject({ path: "src/a.ts", line: 12, col: 5 });
    expect(only("test_x.py:12: AssertionError")).toMatchObject({ path: "test_x.py", line: 12 });
  });

  it("links git status / rename lines", () => {
    expect(paths("\tmodified:   src/components/Foo.tsx")).toEqual(["src/components/Foo.tsx"]);
    expect(paths("renamed:    a/b.ts -> c/d.ts")).toEqual(["a/b.ts", "c/d.ts"]);
  });

  it("strips wrapping quotes and backticks", () => {
    expect(paths("'src/utils/x.ts'")).toEqual(["src/utils/x.ts"]);
    expect(paths('"src/utils/x.ts"')).toEqual(["src/utils/x.ts"]);
    expect(paths("`src/utils/x.ts`")).toEqual(["src/utils/x.ts"]);
    expect(paths("'/Volumes/Husky's SSD/a.ts'")).toEqual(["/Volumes/Husky's SSD/a.ts"]);
  });

  it("allows spaces only in interior segments", () => {
    expect(paths("cd /Volumes/Husky's SSD 4T/Projects/tron now")).toEqual(["/Volumes/Husky's SSD 4T/Projects/tron"]);
    expect(paths("see /tmp/a or /tmp/b")).toEqual(["/tmp/a", "/tmp/b"]);
    expect(paths("see the src dir/app.ts file")).toEqual(["dir/app.ts"]);
  });

  it("keeps shell-escaped paths intact", () => {
    expect(paths("/Volumes/Husky\\'s\\ SSD\\ 4T/a.txt")).toEqual(["/Volumes/Husky\\'s\\ SSD\\ 4T/a.txt"]);
  });

  it("links home, dot-relative and Windows paths", () => {
    expect(paths("~/projects/x.md")).toEqual(["~/projects/x.md"]);
    expect(paths("run ./scripts/build.sh then ../lib/a.ts")).toEqual(["./scripts/build.sh", "../lib/a.ts"]);
    expect(paths("C:\\Users\\x\\proj\\a.ts")).toEqual(["C:\\Users\\x\\proj\\a.ts"]);
    expect(only("C:\\Users\\x\\a.ts:12")).toMatchObject({ path: "C:\\Users\\x\\a.ts", line: 12 });
  });

  it("keeps framework route segments", () => {
    expect(paths("app/(auth)/[id]/page.tsx")).toEqual(["app/(auth)/[id]/page.tsx"]);
    expect(paths("routes/$id.tsx")).toEqual(["routes/$id.tsx"]);
  });

  it("strips trailing punctuation and unbalanced parens", () => {
    expect(paths("Edited src/a.ts.")).toEqual(["src/a.ts"]);
    expect(paths("(src/a.ts)")).toEqual(["src/a.ts"]);
    expect(paths("(/x/y/z.ts)")).toEqual(["/x/y/z.ts"]);
  });

  it("does not link prose fractions, units or slash commands", () => {
    expect(findLinks("and/or 10 km/s use /clear")).toEqual([]);
  });

  it("links single-segment absolute paths only when they have an extension", () => {
    expect(paths("cat /etc/hosts /foo.txt /tmp")).toEqual(["/etc/hosts", "/foo.txt"]);
  });

  it("does not mistake IPs, hosts or versions with a :number for file locations", () => {
    for (const text of [
      "connect to 192.168.1.10:3000 now",
      "git@github.com:22 refused",
      "fetching example.com:443",
      "release 1.2.3:4",
      "pi is 3.14:2",
    ]) {
      expect(paths(text), text).toEqual([]);
    }
  });

  it("does not link bare filenames without a location", () => {
    expect(findLinks("Node.js and package.json")).toEqual([]);
  });

  it("handles CJK paths and CJK text after a path", () => {
    expect(paths("/Users/x/文档/笔记.md")).toEqual(["/Users/x/文档/笔记.md"]);
    expect(paths("已保存到 /Users/x/a.md。")).toEqual(["/Users/x/a.md"]);
    expect(paths("/Users/x/a.md已保存")).toEqual(["/Users/x/a.md"]);
  });

  it("returns links in text order without overlaps", () => {
    const links = findLinks("see https://x.com/a and src/b.ts and localhost:3000");
    expect(links.map((l) => l.kind)).toEqual(["url", "path", "url"]);
    for (let i = 1; i < links.length; i++) expect(links[i].start).toBeGreaterThanOrEqual(links[i - 1].end);
  });
});

describe("fileUrlToPath", () => {
  it("decodes file URLs with and without a host", () => {
    expect(fileUrlToPath("file:///Users/x/a%20b.txt")).toBe("/Users/x/a b.txt");
    expect(fileUrlToPath("file://my-mac.local/Users/x/a.txt")).toBe("/Users/x/a.txt");
    expect(fileUrlToPath("file:///C:/Users/x/a.txt")).toBe("C:/Users/x/a.txt");
  });
});

describe("buildLogicalLine — string offsets ↔ buffer cells", () => {
  const cell = (chars: string, width = 1) => ({ chars, width });

  it("maps offsets past a wide character to the right cells", () => {
    // "a中b": 中 occupies cells 1-2 (cell 2 is a width-0 continuation)
    const line = buildLogicalLine([[cell("a"), cell("中", 2), cell("", 0), cell("b")]]);
    expect(line.text).toBe("a中b");
    expect(line.rangeFor(2, 3)).toEqual({ start: { row: 0, x: 4 }, end: { row: 0, x: 4 } });
    // a range ending on the wide char covers both of its cells
    expect(line.rangeFor(0, 2)).toEqual({ start: { row: 0, x: 1 }, end: { row: 0, x: 3 } });
  });

  it("maps a range spanning soft-wrapped rows", () => {
    const line = buildLogicalLine([
      [cell("x"), cell("中", 2), cell("", 0), cell("/")],
      [cell("a"), cell("."), cell("t"), cell("s")],
    ]);
    expect(line.text).toBe("x中/a.ts");
    expect(line.rangeFor(2, 7)).toEqual({ start: { row: 0, x: 4 }, end: { row: 1, x: 4 } });
  });

  it("renders empty cells as spaces", () => {
    const line = buildLogicalLine([[cell("a"), cell(""), cell("b")]]);
    expect(line.text).toBe("a b");
    expect(line.rangeFor(2, 3)).toEqual({ start: { row: 0, x: 3 }, end: { row: 0, x: 3 } });
  });

  it("maps surrogate-pair emoji as one cell pair", () => {
    const line = buildLogicalLine([[cell("😀", 2), cell("", 0), cell("/"), cell("a")]]);
    expect(line.text).toBe("😀/a");
    expect(line.rangeFor(2, 4)).toEqual({ start: { row: 0, x: 3 }, end: { row: 0, x: 4 } });
  });
});
