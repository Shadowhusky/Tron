import { useState, useEffect, useRef, useMemo } from "react";

/**
 * Tiny heat-map bar visualizing token generation character frequency.
 * 42 buckets: a-z (26) + 0-9 (10) + 6 symbol groups.
 * Each bucket is 3×3px. Clickable to expand live token stream.
 */

const BUCKET_COUNT = 42;

const BUCKET_LABELS: string[] = [
  ..."abcdefghijklmnopqrstuvwxyz".split(""),
  ..."0123456789".split(""),
  "space", "punct", "bracket", "op", "quote", "other",
];

function charToBucket(code: number): number {
  if (code >= 97 && code <= 122) return code - 97;
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 48 && code <= 57) return 26 + code - 48;
  if (code === 32 || code === 10 || code === 9 || code === 13) return 36;
  if (code === 46 || code === 44 || code === 58 || code === 59 || code === 33 || code === 63) return 37;
  if (code === 40 || code === 41 || code === 91 || code === 93 || code === 123 || code === 125) return 38;
  if (code === 43 || code === 45 || code === 42 || code === 47 || code === 61 ||
      code === 60 || code === 62 || code === 124 || code === 38 || code === 94 ||
      code === 37 || code === 126) return 39;
  if (code === 34 || code === 39 || code === 96) return 40;
  return 41;
}

// 10-step heat palette: cold → hot
const HEAT_COLORS = [
  "rgba(255,255,255,0.04)", "#1b1b4b", "#1e3a6e", "#1a5276", "#0e7490",
  "#0891b2", "#10b981", "#84cc16", "#eab308", "#f97316", "#ef4444",
];
const HEAT_COLORS_LIGHT = [
  "rgba(0,0,0,0.04)", "#c7d2fe", "#a5b4fc", "#818cf8", "#6366f1",
  "#4f46e5", "#10b981", "#84cc16", "#eab308", "#f97316", "#ef4444",
];

function heatColor(ratio: number, isLight?: boolean): string {
  const idx = Math.min(Math.round(ratio * 10), 10);
  return (isLight ? HEAT_COLORS_LIGHT : HEAT_COLORS)[idx];
}

interface TokenHeatBarProps {
  text: string;
  isLight?: boolean;
}

const TokenHeatBar: React.FC<TokenHeatBarProps> = ({ text, isLight }) => {
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { pixels, max } = useMemo(() => {
    const counts = new Uint32Array(BUCKET_COUNT);
    let max = 0;
    for (let i = 0; i < text.length; i++) {
      const bucket = charToBucket(text.charCodeAt(i));
      counts[bucket]++;
      if (counts[bucket] > max) max = counts[bucket];
    }
    const pixels = new Array(BUCKET_COUNT);
    for (let b = 0; b < BUCKET_COUNT; b++) {
      pixels[b] = max > 0 ? counts[b] / max : 0;
    }
    return { pixels, max };
  }, [text]);

  // Auto-scroll the token stream to bottom
  useEffect(() => {
    if (expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [expanded, text]);

  if (max === 0) return null;

  // Show last N chars for the expanded view, word-wrapped
  const tailLen = 600;
  const tail = text.length > tailLen ? text.slice(-tailLen) : text;
  const tokenCount = Math.round(text.length / 4);

  return (
    <div className="mt-0.5">
      {/* Clickable heat bar + token count */}
      <div
        className={`flex items-center gap-[1px] cursor-pointer rounded-sm px-0.5 py-px -mx-0.5 transition-colors ${
          isLight ? "hover:bg-gray-100" : "hover:bg-white/5"
        }`}
        onClick={() => setExpanded((v) => !v)}
        title="Click to toggle live token stream"
      >
        {pixels.map((ratio: number, i: number) => (
          <div
            key={i}
            className="transition-colors duration-150"
            style={{
              width: 3,
              height: 3,
              borderRadius: 0.5,
              backgroundColor: heatColor(ratio, isLight),
            }}
            title={`${BUCKET_LABELS[i]}: ${Math.round(ratio * max)}`}
          />
        ))}
        <span className={`text-[9px] font-mono ml-1 ${isLight ? "text-gray-400" : "text-gray-600"}`}>
          {tokenCount}t
        </span>
        <span className={`text-[9px] ml-0.5 transition-transform ${expanded ? "rotate-90" : ""} ${isLight ? "text-gray-400" : "text-gray-600"}`}>
          ▶
        </span>
      </div>

      {/* Expanded: live token stream */}
      {expanded && (
        <div
          ref={scrollRef}
          className={`mt-1 max-h-24 overflow-y-auto overflow-x-hidden rounded border p-1.5 font-mono text-[10px] leading-tight whitespace-pre-wrap break-all select-text ${
            isLight
              ? "bg-gray-50 border-gray-200 text-gray-600"
              : "bg-black/40 border-white/5 text-gray-400"
          }`}
        >
          {text.length > tailLen && (
            <span className={`${isLight ? "text-gray-300" : "text-gray-700"}`}>...{" "}</span>
          )}
          {tail}
          <span className={`inline-block w-1 h-3 ml-px align-middle animate-pulse ${isLight ? "bg-gray-400" : "bg-gray-500"}`} />
        </div>
      )}
    </div>
  );
};

export default TokenHeatBar;
