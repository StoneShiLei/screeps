/**
 * 两个房间之间实际要走几个房间。
 *
 * 地图上贴在一起不等于走得通：房间之间只在边缘有非岩石格的地方才连通，
 * 整条边都是岩石的话就得绕。分房选址时这个数才是支援成本的真实尺度，
 * 直线距离会骗人。
 *
 * 用法：npx ts-node tools/route.ts E28S36 E29S36 E28S34
 */

import { decodeTerrain } from "../src/planner/terrain";
import { fetchTerrain } from "./api";

const from = process.argv[2];
const targets = process.argv.slice(3);

const SIZE = 50;
const WALL = 1;

function parse(name: string): { h: string; x: number; v: string; y: number } {
  const match = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
  if (!match) throw new Error(`房间名格式不对: ${name}`);
  return { h: match[1], x: Number(match[2]), v: match[3], y: Number(match[4]) };
}

function shift(name: string, dx: number, dy: number): string | undefined {
  const { h, x, v, y } = parse(name);
  if (x + dx < 0 || y + dy < 0) return undefined;
  return `${h}${x + dx}${v}${y + dy}`;
}

const terrainCache = new Map<string, Uint8Array>();

async function terrainOf(name: string): Promise<Uint8Array | undefined> {
  const cached = terrainCache.get(name);
  if (cached) return cached;

  try {
    const grid = decodeTerrain(await fetchTerrain(name));
    terrainCache.set(name, grid);
    return grid;
  } catch {
    return undefined;
  }
}

/**
 * 走得通的邻房。
 *
 * 只查自己这一侧的边缘：地图生成保证了两侧的出口格是对齐的，所以本房间东边
 * 有非岩石格，对面西边就一定有。
 */
async function neighborsOf(name: string): Promise<string[]> {
  const grid = await terrainOf(name);
  if (!grid) return [];

  const result: string[] = [];
  const edges: [number, number, (i: number) => number][] = [
    [0, -1, i => i], // 上边 y=0
    [0, 1, i => 49 * SIZE + i], // 下边 y=49
    [-1, 0, i => i * SIZE], // 左边 x=0
    [1, 0, i => i * SIZE + 49] // 右边 x=49
  ];

  for (const [dx, dy, indexOf] of edges) {
    let open = false;
    for (let i = 1; i < SIZE - 1; i++) {
      if (grid[indexOf(i)] !== WALL) {
        open = true;
        break;
      }
    }
    if (!open) continue;

    const neighbor = shift(name, dx, dy);
    if (neighbor) result.push(neighbor);
  }

  return result;
}

async function routeTo(start: string, goal: string, limit = 6): Promise<string[] | undefined> {
  const queue: string[][] = [[start]];
  const seen = new Set([start]);

  while (queue.length > 0) {
    const path = queue.shift() as string[];
    const current = path[path.length - 1];
    if (current === goal) return path;
    if (path.length > limit) continue;

    for (const next of await neighborsOf(current)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...path, next]);
    }
  }

  return undefined;
}

async function main(): Promise<void> {
  if (!from || targets.length === 0) {
    console.log("用法：npx ts-node tools/route.ts <起点> <目标> ...");
    return;
  }

  console.log(`从 ${from} 出发：\n`);

  for (const target of targets) {
    const route = await routeTo(from, target);
    if (!route) {
      console.log(`  ${target.padEnd(8)} 六个房间以内走不到`);
      continue;
    }

    const hops = route.length - 1;
    console.log(`  ${target.padEnd(8)} ${hops} 跳：${route.join(" → ")}`);
  }

  console.log("\n跳数 = 要穿过几个房间。第一个 spawn 要 15000 能量，每多一跳单程就多约 50 tick");
}

void main();
