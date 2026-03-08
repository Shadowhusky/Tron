import type { SpriteData } from "./types";

const colorizeCache = new Map<string, SpriteData>();

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h / 360 + 1/3) * 255),
    Math.round(hue2rgb(p, q, h / 360) * 255),
    Math.round(hue2rgb(p, q, h / 360 - 1/3) * 255),
  ];
}

export function adjustSprite(
  sprite: SpriteData,
  hueShift: number,
  satShift: number = 0,
  brightShift: number = 0,
): SpriteData {
  return sprite.map(row =>
    row.map(pixel => {
      if (!pixel || pixel === "") return pixel;
      const [r, g, b] = hexToRgb(pixel);
      const [h, s, l] = rgbToHsl(r, g, b);
      const newH = h + hueShift;
      const newS = Math.max(0, Math.min(1, s + satShift / 100));
      const newL = Math.max(0, Math.min(1, l + brightShift / 100));
      const [nr, ng, nb] = hslToRgb(newH, newS, newL);
      return rgbToHex(nr, ng, nb);
    })
  );
}

export function getColorizedSprite(
  sprite: SpriteData,
  h: number,
  s: number,
  b: number,
  c: number,
  colorize?: boolean,
): SpriteData {
  const key = `${h},${s},${b},${c},${colorize ? 1 : 0}`;
  const cached = colorizeCache.get(key);
  if (cached) return cached;

  const result = colorize
    ? colorizeSprite(sprite, h, s, b, c)
    : adjustSprite(sprite, h, s, b);
  colorizeCache.set(key, result);
  return result;
}

function colorizeSprite(
  sprite: SpriteData,
  hue: number,
  sat: number,
  bright: number,
  contrast: number,
): SpriteData {
  return sprite.map(row =>
    row.map(pixel => {
      if (!pixel || pixel === "") return pixel;
      const [r, g, b] = hexToRgb(pixel);
      let lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      // Contrast: expand/compress around 0.5
      lum = 0.5 + (lum - 0.5) * (1 + contrast / 100);
      // Brightness: shift up/down
      lum = Math.max(0, Math.min(1, lum + bright / 100));
      const s = Math.max(0, Math.min(1, sat / 100));
      const [nr, ng, nb] = hslToRgb(hue, s, lum);
      return rgbToHex(nr, ng, nb);
    })
  );
}
