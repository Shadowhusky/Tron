import type { SpriteData } from "../types";

const _ = ""; // transparent pixel

// --- Furniture Sprites ---

export const deskSprite: SpriteData = (() => {
  // 32x16 top-down desk
  const W = "#8B6914"; // wood
  const D = "#A07828"; // wood highlight
  const E = "#6B4E0A"; // wood shadow
  const rows: SpriteData = [];
  for (let r = 0; r < 16; r++) {
    const row: string[] = [];
    for (let c = 0; c < 32; c++) {
      if (r === 0 || r === 15) row.push(E);
      else if (c === 0 || c === 31) row.push(E);
      else if (r === 1) row.push(D);
      else if (r < 3) row.push(W);
      else if (r < 14) row.push(D);
      else row.push(W);
    }
    rows.push(row);
  }
  return rows;
})();

export const plantSprite: SpriteData = (() => {
  // 16x24 potted plant
  const G = "#4CAF50"; // green leaves
  const L = "#66BB6A"; // light green
  const T = "#795548"; // trunk
  const P = "#D2691E"; // pot
  const rows: SpriteData = Array.from({ length: 24 }, () => Array(16).fill(_));
  // Leaves (rows 2-12)
  for (let r = 2; r < 12; r++) {
    for (let c = 4; c < 12; c++) {
      rows[r][c] = (r + c) % 3 === 0 ? L : G;
    }
  }
  // Top leaf extension
  rows[0][7] = G; rows[0][8] = G;
  rows[1][6] = G; rows[1][7] = L; rows[1][8] = L; rows[1][9] = G;
  // Trunk (rows 12-16)
  for (let r = 12; r < 17; r++) { rows[r][7] = T; rows[r][8] = T; }
  // Pot (rows 17-23)
  for (let r = 17; r < 23; r++) {
    const w = r < 19 ? 4 : r < 21 ? 3 : 2;
    for (let c = 8 - w; c < 8 + w; c++) rows[r][c] = P;
  }
  return rows;
})();

export const bookshelfSprite: SpriteData = (() => {
  // 16x32 bookshelf
  const W = "#8B6914"; // wood
  const E = "#6B4E0A"; // edge
  const books = ["#E53935", "#1E88E5", "#43A047", "#FB8C00", "#8E24AA", "#00ACC1"];
  const rows: SpriteData = [];
  for (let r = 0; r < 32; r++) {
    const row: string[] = [];
    for (let c = 0; c < 16; c++) {
      if (c === 0 || c === 15 || r === 0 || r === 31) row.push(E);
      else if (r === 15 || r === 16) row.push(W); // middle shelf
      else if (r > 1 && r < 15 && c > 1 && c < 14) {
        row.push(books[(c - 2) % books.length]);
      } else if (r > 16 && r < 30 && c > 1 && c < 14) {
        row.push(books[(c + 3) % books.length]);
      } else row.push(W);
    }
    rows.push(row);
  }
  return rows;
})();

export const coolerSprite: SpriteData = (() => {
  // 16x24 water cooler
  const B = "#42A5F5"; // blue water
  const W = "#E0E0E0"; // white body
  const G = "#9E9E9E"; // gray
  const rows: SpriteData = Array.from({ length: 24 }, () => Array(16).fill(_));
  // Water jug (rows 0-8)
  for (let r = 0; r < 9; r++) {
    for (let c = 5; c < 11; c++) rows[r][c] = r < 2 ? G : B;
  }
  // Body (rows 9-20)
  for (let r = 9; r < 21; r++) {
    for (let c = 4; c < 12; c++) rows[r][c] = r === 9 ? G : W;
  }
  // Tap
  rows[13][12] = G; rows[14][12] = G;
  // Base (rows 21-23)
  for (let r = 21; r < 24; r++) {
    for (let c = 3; c < 13; c++) rows[r][c] = G;
  }
  return rows;
})();

export const whiteboardSprite: SpriteData = (() => {
  // 32x16 whiteboard
  const F = "#E0E0E0"; // frame
  const W = "#FAFAFA"; // white surface
  const M = "#FF5722"; // marker red
  const B = "#2196F3"; // marker blue
  const rows: SpriteData = [];
  for (let r = 0; r < 16; r++) {
    const row: string[] = [];
    for (let c = 0; c < 32; c++) {
      if (r === 0 || r === 15 || c === 0 || c === 31) row.push(F);
      else if (r === 4 && c > 4 && c < 20) row.push(M);
      else if (r === 8 && c > 6 && c < 25) row.push(B);
      else row.push(W);
    }
    rows.push(row);
  }
  return rows;
})();

export const chairSprite: SpriteData = (() => {
  // 16x16 chair (top-down)
  const W = "#8D6E63"; // wood
  const S = "#A1887F"; // seat
  const rows: SpriteData = Array.from({ length: 16 }, () => Array(16).fill(_));
  // Back (rows 1-3)
  for (let r = 1; r < 4; r++) {
    for (let c = 3; c < 13; c++) rows[r][c] = W;
  }
  // Seat (rows 4-12)
  for (let r = 4; r < 13; r++) {
    for (let c = 4; c < 12; c++) rows[r][c] = S;
  }
  // Legs
  rows[13][4] = W; rows[13][11] = W;
  rows[14][4] = W; rows[14][11] = W;
  return rows;
})();

export const pcSprite: SpriteData = (() => {
  // 16x16 PC monitor
  const F = "#424242"; // frame
  const S = "#1565C0"; // screen
  const B = "#616161"; // base
  const rows: SpriteData = Array.from({ length: 16 }, () => Array(16).fill(_));
  // Screen frame (rows 1-10)
  for (let r = 1; r < 11; r++) {
    for (let c = 2; c < 14; c++) {
      if (r === 1 || r === 10 || c === 2 || c === 13) rows[r][c] = F;
      else rows[r][c] = S;
    }
  }
  // Stand
  rows[11][7] = F; rows[11][8] = F;
  rows[12][7] = F; rows[12][8] = F;
  // Base
  for (let c = 5; c < 11; c++) rows[13][c] = B;
  return rows;
})();

export const lampSprite: SpriteData = (() => {
  // 16x16 desk lamp
  const M = "#FFD54F"; // lamp light
  const A = "#757575"; // arm
  const B = "#424242"; // base
  const rows: SpriteData = Array.from({ length: 16 }, () => Array(16).fill(_));
  // Light cone (rows 0-4)
  rows[0][6] = M; rows[0][7] = M; rows[0][8] = M; rows[0][9] = M;
  rows[1][5] = M; rows[1][6] = M; rows[1][7] = M; rows[1][8] = M; rows[1][9] = M; rows[1][10] = M;
  rows[2][5] = M; rows[2][6] = M; rows[2][7] = M; rows[2][8] = M; rows[2][9] = M; rows[2][10] = M;
  // Shade
  for (let c = 4; c < 12; c++) rows[3][c] = A;
  // Arm
  rows[4][8] = A; rows[5][8] = A; rows[6][8] = A;
  rows[7][7] = A; rows[7][8] = A;
  rows[8][6] = A; rows[8][7] = A;
  rows[9][5] = A; rows[9][6] = A;
  rows[10][5] = A;
  // Base
  for (let c = 3; c < 9; c++) { rows[11][c] = B; rows[12][c] = B; }
  return rows;
})();

// --- Speech Bubbles ---

export const permissionBubble: SpriteData = (() => {
  const W = "#FFFFFF";
  const R = "#FF3D00";
  const B = "#424242";
  const rows: SpriteData = Array.from({ length: 12 }, () => Array(14).fill(_));
  // Border
  for (let c = 2; c < 12; c++) { rows[0][c] = B; rows[8][c] = B; }
  for (let r = 1; r < 8; r++) { rows[r][1] = B; rows[r][12] = B; }
  rows[0][1] = B; rows[0][12] = B; rows[8][1] = B; rows[8][12] = B;
  // Fill
  for (let r = 1; r < 8; r++) {
    for (let c = 2; c < 12; c++) rows[r][c] = W;
  }
  // Exclamation mark
  rows[2][7] = R; rows[3][7] = R; rows[4][7] = R; rows[5][7] = R;
  rows[7][7] = R; // dot
  // Tail
  rows[9][5] = B; rows[9][6] = B;
  rows[10][4] = B;
  return rows;
})();

export const waitingBubble: SpriteData = (() => {
  const W = "#FFFFFF";
  const D = "#9E9E9E";
  const B = "#424242";
  const rows: SpriteData = Array.from({ length: 12 }, () => Array(14).fill(_));
  // Border
  for (let c = 2; c < 12; c++) { rows[0][c] = B; rows[6][c] = B; }
  for (let r = 1; r < 6; r++) { rows[r][1] = B; rows[r][12] = B; }
  rows[0][1] = B; rows[0][12] = B; rows[6][1] = B; rows[6][12] = B;
  // Fill
  for (let r = 1; r < 6; r++) {
    for (let c = 2; c < 12; c++) rows[r][c] = W;
  }
  // Three dots
  rows[3][4] = D; rows[3][7] = D; rows[3][10] = D;
  // Tail
  rows[7][5] = B; rows[7][6] = B;
  rows[8][4] = B;
  return rows;
})();

// --- Character Sprites ---

// 6 color palettes: [skin, hair, shirt, pants, shoes]
const PALETTES = [
  { skin: "#FFCC99", hair: "#3E2723", shirt: "#1565C0", pants: "#37474F", shoes: "#5D4037" },
  { skin: "#F5CBA7", hair: "#D4A373", shirt: "#C62828", pants: "#1B5E20", shoes: "#4E342E" },
  { skin: "#D7CCC8", hair: "#212121", shirt: "#6A1B9A", pants: "#283593", shoes: "#3E2723" },
  { skin: "#FFAB91", hair: "#BF360C", shirt: "#00695C", pants: "#4A148C", shoes: "#263238" },
  { skin: "#FFE0B2", hair: "#F9A825", shirt: "#AD1457", pants: "#0D47A1", shoes: "#1B5E20" },
  { skin: "#BCAAA4", hair: "#1B1B1B", shirt: "#FF6F00", pants: "#311B92", shoes: "#33691E" },
];

// Template character sprite (16x24 per frame)
// Uses letter codes: H=hair, K=skin, S=shirt, P=pants, O=shoes, _=transparent
const CHAR_TEMPLATE_DOWN: string[][][] = [
  // Standing / walk frame 0
  [
    "________________",
    "________________",
    "______HHHH______",
    "_____HHHHHH_____",
    "_____HKKKKH_____",
    "_____KKKKKK_____",
    "______KKKK______",
    "_____SSSSSS_____",
    "____SSSSSSSS____",
    "____SSSSSSSS____",
    "____SSSSSSSS____",
    "_____SSSSSS_____",
    "_____PPPPPP_____",
    "_____PPPPPP_____",
    "_____PP__PP_____",
    "______OO_OO_____",
    "________________",
  ].map(r => r.split("")),
  // Walk frame 1
  [
    "________________",
    "________________",
    "______HHHH______",
    "_____HHHHHH_____",
    "_____HKKKKH_____",
    "_____KKKKKK_____",
    "______KKKK______",
    "_____SSSSSS_____",
    "____SSSSSSSS____",
    "____SSSSSSSS____",
    "____SSSSSSSS____",
    "_____SSSSSS_____",
    "_____PPPPPP_____",
    "____PPP_PPP_____",
    "____OO___OO_____",
    "________________",
    "________________",
  ].map(r => r.split("")),
  // Walk frame 2
  [
    "________________",
    "________________",
    "______HHHH______",
    "_____HHHHHH_____",
    "_____HKKKKH_____",
    "_____KKKKKK_____",
    "______KKKK______",
    "_____SSSSSS_____",
    "____SSSSSSSS____",
    "____SSSSSSSS____",
    "____SSSSSSSS____",
    "_____SSSSSS_____",
    "_____PPPPPP_____",
    "_____PPPPPP_____",
    "______PP________",
    "______OO________",
    "________________",
  ].map(r => r.split("")),
  // Walk frame 3 (mirror of frame 2)
  [
    "________________",
    "________________",
    "______HHHH______",
    "_____HHHHHH_____",
    "_____HKKKKH_____",
    "_____KKKKKK_____",
    "______KKKK______",
    "_____SSSSSS_____",
    "____SSSSSSSS____",
    "____SSSSSSSS____",
    "____SSSSSSSS____",
    "_____SSSSSS_____",
    "_____PPPPPP_____",
    "_____PPPPPP_____",
    "________PP______",
    "________OO______",
    "________________",
  ].map(r => r.split("")),
  // Typing frame 0 (sitting, arms forward-wide)
  [
    "________________",
    "______HHHH______",
    "_____HHHHHH_____",
    "_____HKKKKH_____",
    "_____KKKKKK_____",
    "______KKKK______",
    "__KKSSSSSSK_____",
    "____SSSSSSKK____",
    "____SSSSSSSS____",
    "____SSSSSSSS____",
    "_____SSSSSS_____",
    "_____PPPPPP_____",
    "_____PPPPPP_____",
    "________________",
    "________________",
    "________________",
    "________________",
  ].map(r => r.split("")),
  // Typing frame 1 (sitting, arms forward-narrow, slight lean)
  [
    "________________",
    "_______HHHH_____",
    "______HHHHHH____",
    "______HKKKKH____",
    "______KKKKKK____",
    "_______KKKK_____",
    "____KSSSSSSKK___",
    "___KKSSSSSS_____",
    "_____SSSSSSSS___",
    "_____SSSSSSSS___",
    "______SSSSSS____",
    "______PPPPPP____",
    "______PPPPPP____",
    "________________",
    "________________",
    "________________",
    "________________",
  ].map(r => r.split("")),
  // Reading frame 0 (sitting, hands together)
  [
    "________________",
    "______HHHH______",
    "_____HHHHHH_____",
    "_____HKKKKH_____",
    "_____KKKKKK_____",
    "______KKKK______",
    "_____SSSSSS_____",
    "____KSSSSSK_____",
    "____SSSSSSSS____",
    "____SSSSSSSS____",
    "_____SSSSSS_____",
    "_____PPPPPP_____",
    "_____PPPPPP_____",
    "________________",
    "________________",
    "________________",
    "________________",
  ].map(r => r.split("")),
];

// UP direction template
const CHAR_TEMPLATE_UP: string[][][] = [
  // Standing / walk frame 0
  [
    "________________",
    "________________",
    "______HHHH______",
    "_____HHHHHH_____",
    "_____HHHHHH_____",
    "_____HHHHHH_____",
    "______HHHH______",
    "_____SSSSSS_____",
    "____SSSSSSSS____",
    "____SSSSSSSS____",
    "____SSSSSSSS____",
    "_____SSSSSS_____",
    "_____PPPPPP_____",
    "_____PPPPPP_____",
    "_____PP__PP_____",
    "______OO_OO_____",
    "________________",
  ].map(r => r.split("")),
  // Walk frames same as down but hair only
  [
    "________________",
    "________________",
    "______HHHH______",
    "_____HHHHHH_____",
    "_____HHHHHH_____",
    "_____HHHHHH_____",
    "______HHHH______",
    "_____SSSSSS_____",
    "____SSSSSSSS____",
    "____SSSSSSSS____",
    "____SSSSSSSS____",
    "_____SSSSSS_____",
    "_____PPPPPP_____",
    "____PPP_PPP_____",
    "____OO___OO_____",
    "________________",
    "________________",
  ].map(r => r.split("")),
  [
    "________________",
    "________________",
    "______HHHH______",
    "_____HHHHHH_____",
    "_____HHHHHH_____",
    "_____HHHHHH_____",
    "______HHHH______",
    "_____SSSSSS_____",
    "____SSSSSSSS____",
    "____SSSSSSSS____",
    "____SSSSSSSS____",
    "_____SSSSSS_____",
    "_____PPPPPP_____",
    "_____PPPPPP_____",
    "______PP________",
    "______OO________",
    "________________",
  ].map(r => r.split("")),
  [
    "________________",
    "________________",
    "______HHHH______",
    "_____HHHHHH_____",
    "_____HHHHHH_____",
    "_____HHHHHH_____",
    "______HHHH______",
    "_____SSSSSS_____",
    "____SSSSSSSS____",
    "____SSSSSSSS____",
    "____SSSSSSSS____",
    "_____SSSSSS_____",
    "_____PPPPPP_____",
    "_____PPPPPP_____",
    "________PP______",
    "________OO______",
    "________________",
  ].map(r => r.split("")),
  // Typing (from behind, arms forward-wide)
  [
    "________________",
    "______HHHH______",
    "_____HHHHHH_____",
    "_____HHHHHH_____",
    "_____HHHHHH_____",
    "______HHHH______",
    "__KKSSSSSSK_____",
    "____SSSSSSKK____",
    "____SSSSSSSS____",
    "____SSSSSSSS____",
    "_____SSSSSS_____",
    "_____PPPPPP_____",
    "_____PPPPPP_____",
    "________________",
    "________________",
    "________________",
    "________________",
  ].map(r => r.split("")),
  // Typing (from behind, arms forward-narrow, slight lean)
  [
    "________________",
    "_______HHHH_____",
    "______HHHHHH____",
    "______HHHHHH____",
    "______HHHHHH____",
    "_______HHHH_____",
    "____KSSSSSSKK___",
    "___KKSSSSSS_____",
    "_____SSSSSSSS___",
    "_____SSSSSSSS___",
    "______SSSSSS____",
    "______PPPPPP____",
    "______PPPPPP____",
    "________________",
    "________________",
    "________________",
    "________________",
  ].map(r => r.split("")),
  // Reading (from behind)
  [
    "________________",
    "______HHHH______",
    "_____HHHHHH_____",
    "_____HHHHHH_____",
    "_____HHHHHH_____",
    "______HHHH______",
    "_____SSSSSS_____",
    "____KSSSSSK_____",
    "____SSSSSSSS____",
    "____SSSSSSSS____",
    "_____SSSSSS_____",
    "_____PPPPPP_____",
    "_____PPPPPP_____",
    "________________",
    "________________",
    "________________",
    "________________",
  ].map(r => r.split("")),
];

// RIGHT direction template
const CHAR_TEMPLATE_RIGHT: string[][][] = [
  // Standing
  [
    "________________",
    "________________",
    "_______HHHH_____",
    "______HHHHH_____",
    "______HKKKK_____",
    "______KKKKK_____",
    "_______KKK______",
    "______SSSSS_____",
    "_____SSSSSSS____",
    "_____SSSSSSK____",
    "_____SSSSSSS____",
    "______SSSSS_____",
    "______PPPPP_____",
    "______PPPPP_____",
    "______PP_PP_____",
    "_______O__O_____",
    "________________",
  ].map(r => r.split("")),
  [
    "________________",
    "________________",
    "_______HHHH_____",
    "______HHHHH_____",
    "______HKKKK_____",
    "______KKKKK_____",
    "_______KKK______",
    "______SSSSS_____",
    "_____SSSSSSS____",
    "_____SSSSSSK____",
    "_____SSSSSSS____",
    "______SSSSS_____",
    "______PPPPP_____",
    "_____PPP_PP_____",
    "_____OO___O_____",
    "________________",
    "________________",
  ].map(r => r.split("")),
  [
    "________________",
    "________________",
    "_______HHHH_____",
    "______HHHHH_____",
    "______HKKKK_____",
    "______KKKKK_____",
    "_______KKK______",
    "______SSSSS_____",
    "_____SSSSSSS____",
    "_____SSSSSSK____",
    "_____SSSSSSS____",
    "______SSSSS_____",
    "______PPPPP_____",
    "______PPPPP_____",
    "_______PP_______",
    "_______OO_______",
    "________________",
  ].map(r => r.split("")),
  [
    "________________",
    "________________",
    "_______HHHH_____",
    "______HHHHH_____",
    "______HKKKK_____",
    "______KKKKK_____",
    "_______KKK______",
    "______SSSSS_____",
    "_____SSSSSSS____",
    "_____SSSSSSK____",
    "_____SSSSSSS____",
    "______SSSSS_____",
    "______PPPPP_____",
    "______PPPPP_____",
    "________PP______",
    "________OO______",
    "________________",
  ].map(r => r.split("")),
  // Typing right
  [
    "________________",
    "_______HHHH_____",
    "______HHHHH_____",
    "______HKKKK_____",
    "______KKKKK_____",
    "_______KKK______",
    "______SSSSSK____",
    "______SSSSSK____",
    "_____SSSSSSS____",
    "_____SSSSSSS____",
    "______SSSSS_____",
    "______PPPPP_____",
    "______PPPPP_____",
    "________________",
    "________________",
    "________________",
    "________________",
  ].map(r => r.split("")),
  [
    "________________",
    "_______HHHH_____",
    "______HHHHH_____",
    "______HKKKK_____",
    "______KKKKK_____",
    "_______KKK______",
    "______SSSSK_____",
    "______SSSSK_____",
    "_____SSSSSSS____",
    "_____SSSSSSS____",
    "______SSSSS_____",
    "______PPPPP_____",
    "______PPPPP_____",
    "________________",
    "________________",
    "________________",
    "________________",
  ].map(r => r.split("")),
  // Reading right
  [
    "________________",
    "_______HHHH_____",
    "______HHHHH_____",
    "______HKKKK_____",
    "______KKKKK_____",
    "_______KKK______",
    "______SSSSS_____",
    "______SSSSK_____",
    "_____SSSSSSS____",
    "_____SSSSSSS____",
    "______SSSSS_____",
    "______PPPPP_____",
    "______PPPPP_____",
    "________________",
    "________________",
    "________________",
    "________________",
  ].map(r => r.split("")),
];

function resolveTemplate(template: string[][], palette: typeof PALETTES[number]): SpriteData {
  const map: Record<string, string> = {
    H: palette.hair,
    K: palette.skin,
    S: palette.shirt,
    P: palette.pants,
    O: palette.shoes,
    _: "",
  };
  return template.map(row => row.map(ch => map[ch] || ""));
}

function flipHorizontal(sprite: SpriteData): SpriteData {
  return sprite.map(row => [...row].reverse());
}

export interface CharacterSprites {
  down: SpriteData[];    // 7 frames: 4 walk + 2 type + 1 read
  up: SpriteData[];
  right: SpriteData[];
  left: SpriteData[];    // generated by flipping right
}

const spriteCache = new Map<string, CharacterSprites>();

export function getCharacterSprites(palette: number, hueShift: number = 0): CharacterSprites {
  const key = `${palette}:${hueShift}`;
  const cached = spriteCache.get(key);
  if (cached) return cached;

  const pal = PALETTES[palette % PALETTES.length];

  const downFrames = CHAR_TEMPLATE_DOWN.map(t => resolveTemplate(t, pal));
  const upFrames = CHAR_TEMPLATE_UP.map(t => resolveTemplate(t, pal));
  const rightFrames = CHAR_TEMPLATE_RIGHT.map(t => resolveTemplate(t, pal));
  const leftFrames = rightFrames.map(flipHorizontal);

  const result: CharacterSprites = {
    down: downFrames,
    up: upFrames,
    right: rightFrames,
    left: leftFrames,
  };

  spriteCache.set(key, result);
  return result;
}
