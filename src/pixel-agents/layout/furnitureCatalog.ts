import type { FurnitureCatalogEntry } from "../types";
import { FurnitureType, Direction } from "../types";
import {
  deskSprite,
  plantSprite,
  bookshelfSprite,
  coolerSprite,
  whiteboardSprite,
  chairSprite,
  pcSprite,
  lampSprite,
} from "../sprites/spriteData";

export const FURNITURE_CATALOG: FurnitureCatalogEntry[] = [
  {
    type: FurnitureType.DESK,
    name: "Desk",
    cols: 2,
    rows: 1,
    sprite: deskSprite,
    isDesk: true,
    category: "office",
  },
  {
    type: FurnitureType.BOOKSHELF,
    name: "Bookshelf",
    cols: 1,
    rows: 2,
    sprite: bookshelfSprite,
    category: "decor",
  },
  {
    type: FurnitureType.PLANT,
    name: "Plant",
    cols: 1,
    rows: 1,
    sprite: plantSprite,
    category: "decor",
  },
  {
    type: FurnitureType.COOLER,
    name: "Water Cooler",
    cols: 1,
    rows: 1,
    sprite: coolerSprite,
    category: "decor",
  },
  {
    type: FurnitureType.WHITEBOARD,
    name: "Whiteboard",
    cols: 2,
    rows: 1,
    sprite: whiteboardSprite,
    category: "office",
  },
  {
    type: FurnitureType.CHAIR,
    name: "Chair",
    cols: 1,
    rows: 1,
    sprite: chairSprite,
    category: "office",
    seatDirection: Direction.UP,
  },
  {
    type: FurnitureType.PC,
    name: "PC Monitor",
    cols: 1,
    rows: 1,
    sprite: pcSprite,
    category: "office",
  },
  {
    type: FurnitureType.LAMP,
    name: "Desk Lamp",
    cols: 1,
    rows: 1,
    sprite: lampSprite,
    category: "office",
  },
];

export function getCatalogEntry(type: FurnitureType): FurnitureCatalogEntry | undefined {
  return FURNITURE_CATALOG.find((e) => e.type === type);
}
