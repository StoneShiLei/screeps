/**
 * 检查一批房间到底能不能放下 Overmind 的 bunker。
 *
 * 和"能放下 13x13 正方形"不同，这里做的是精确碰撞检测：
 * bunker 四角是空的，那些格子是墙也无所谓，所以实际可选位置会多不少。
 *
 * 用法：
 *   $env:TS_NODE_PROJECT="tsconfig.test.json"
 *   npx ts-node -r tsconfig-paths/register tools/check-fit.ts W11S26 W15S31
 */

import { ROOM_SIZE, TERRAIN_WALL, decodeTerrain, distanceTransform, findOpenSpots } from "planner/terrain";
import { ANCHOR, BUNKER } from "./show-bunker";
import { fetchObjects, fetchTerrain } from "./api";

/** bunker 占用的所有格子，转成相对锚点的偏移 */
function bunkerOffsets(): { dx: number; dy: number }[] {
  const seen = new Set<string>();
  const offsets: { dx: number; dy: number }[] = [];

  for (const positions of Object.values(BUNKER[8])) {
    for (const [x, y] of positions ?? []) {
      const key = `${x},${y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      offsets.push({ dx: x - ANCHOR.x, dy: y - ANCHOR.y });
    }
  }

  return offsets;
}

/** 建筑不能贴着房间边缘，出口两格内也不安全 */
const EDGE_MARGIN = 3;

function countFittingAnchors(terrain: Uint8Array, offsets: { dx: number; dy: number }[]): number {
  let count = 0;

  for (let y = 0; y < ROOM_SIZE; y++) {
    for (let x = 0; x < ROOM_SIZE; x++) {
      let fits = true;
      for (const { dx, dy } of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < EDGE_MARGIN || ny < EDGE_MARGIN || nx >= ROOM_SIZE - EDGE_MARGIN || ny >= ROOM_SIZE - EDGE_MARGIN) {
          fits = false;
          break;
        }
        if (terrain[ny * ROOM_SIZE + nx] === TERRAIN_WALL) {
          fits = false;
          break;
        }
      }
      if (fits) count++;
    }
  }

  return count;
}

function parseRoomName(name: string): { x: number; y: number } {
  const match = /^[WE](\d+)[NS](\d+)$/.exec(name);
  if (!match) throw new Error(`房间名格式不对: ${name}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

function isNormalRoom(name: string): boolean {
  const { x, y } = parseRoomName(name);
  const mx = x % 10;
  const my = y % 10;
  if (mx === 0 || my === 0) return false;
  return !(mx >= 4 && mx <= 6 && my >= 4 && my <= 6);
}

function roomsInRange(from: string, to: string): string[] {
  const a = parseRoomName(from);
  const b = parseRoomName(to);
  const prefix = /^([WE])\d+([NS])\d+$/.exec(from);
  if (!prefix) throw new Error(`房间名格式不对: ${from}`);

  const names: string[] = [];
  for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) {
    for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) {
      names.push(`${prefix[1]}${x}${prefix[2]}${y}`);
    }
  }
  return names;
}

async function main(): Promise<void> {
  const [from, to] = process.argv.slice(2);
  if (!from) {
    console.log("用法: ts-node tools/check-fit.ts <起始房间> [结束房间]");
    return;
  }

  const offsets = bunkerOffsets();
  console.log(`bunker 占用 ${offsets.length} 格\n`);

  const names = (to ? roomsInRange(from, to) : [from]).filter(isNormalRoom);
  const rows: { name: string; sources: number; clearance: number; anchors: number }[] = [];

  for (const name of names) {
    try {
      const terrain = decodeTerrain(await fetchTerrain(name));
      const clearance = findOpenSpots(distanceTransform(terrain), 1)[0]?.clearance ?? 0;
      const anchors = countFittingAnchors(terrain, offsets);
      const sources = (await fetchObjects(name)).filter(o => o.type === "source").length;
      rows.push({ name, sources, clearance, anchors });
    } catch (error) {
      console.log(`  ${name} 失败: ${(error as Error).message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 120));
  }

  rows.sort((a, b) => b.anchors - a.anchors);

  console.log("房间     源  最大方块  可放置锚点数");
  for (const r of rows) {
    const square = `${r.clearance * 2 - 1}x${r.clearance * 2 - 1}`;
    console.log(`${r.name.padEnd(8)} ${r.sources}   ${square.padEnd(8)} ${r.anchors}`);
  }

  const twoSource = rows.filter(r => r.sources === 2);
  const fits = twoSource.filter(r => r.anchors > 0);
  const bigSquare = twoSource.filter(r => r.clearance >= 7);

  console.log(`\n双源普通房 ${twoSource.length} 个`);
  console.log(`  精确检测能放下 bunker: ${fits.length} 个`);
  console.log(`  按 13x13 正方形估算:   ${bigSquare.length} 个`);
}

void main();
