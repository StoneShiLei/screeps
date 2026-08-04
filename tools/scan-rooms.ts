/**
 * 选家脚本：批量评估房间，算出每个房间 bunker 该放哪、第一个 spawn 该落在哪一格。
 *
 * 跑在 Node 里不消耗游戏 CPU，也不需要先占领房间——Screeps 的地形和资源接口对任意房间开放，
 * 所以可以在 respawn 之前就把候选区域全部扫一遍。
 *
 * 用法：
 *   $env:TS_NODE_PROJECT="tsconfig.test.json"
 *   npx ts-node -r tsconfig-paths/register tools/scan-rooms.ts W11S26 W15S31
 */

import { FIRST_SPAWN_OFFSET } from "planner/bunkerLayout";
import { rankAnchors } from "planner/bunkerPlanner";
import { decodeTerrain } from "planner/terrain";
import { fetchObjects, fetchTerrain } from "./api";

type RoomKind = "普通" | "高速路" | "SK房" | "中心房";

interface RoomReport {
  name: string;
  kind: RoomKind;
  sources: number;
  mineral: string;
  anchorCount: number;
  best?: { x: number; y: number; cost: number; distances: number[] };
}

function parseRoomName(name: string): { x: number; y: number } {
  const match = /^[WE](\d+)[NS](\d+)$/.exec(name);
  if (!match) throw new Error(`房间名格式不对: ${name}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

/**
 * 坐标是 10 的倍数的是高速路，没有 controller 不能占领；
 * 每个扇区中间 9 个房间由 Source Keeper 看守，不适合当主基地。
 */
function classify(name: string): RoomKind {
  const { x, y } = parseRoomName(name);
  const mx = x % 10;
  const my = y % 10;

  if (mx === 0 || my === 0) return "高速路";
  if (mx >= 4 && mx <= 6 && my >= 4 && my <= 6) {
    return mx === 5 && my === 5 ? "中心房" : "SK房";
  }
  return "普通";
}

async function inspectRoom(name: string): Promise<RoomReport> {
  const kind = classify(name);
  const objects = await fetchObjects(name);
  const sources = objects.filter(o => o.type === "source");
  const controller = objects.find(o => o.type === "controller");
  const mineral = objects.find(o => o.type === "mineral");

  const report: RoomReport = {
    name,
    kind,
    sources: sources.length,
    mineral: mineral?.mineralType ?? "-",
    anchorCount: 0
  };

  // 不能占领的房间没必要算锚点
  if (kind !== "普通" || !controller) return report;

  const terrain = decodeTerrain(await fetchTerrain(name));
  const targets = [...sources, controller].map(o => ({ x: o.x, y: o.y }));
  const ranked = rankAnchors(terrain, targets);

  report.anchorCount = ranked.length;
  report.best = ranked[0];
  return report;
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
    console.log("用法: ts-node tools/scan-rooms.ts <起始房间> [结束房间]");
    return;
  }

  const names = to ? roomsInRange(from, to) : [from];
  console.log(`扫描 ${names.length} 个房间...\n`);

  const reports: RoomReport[] = [];
  for (const name of names) {
    try {
      reports.push(await inspectRoom(name));
    } catch (error) {
      console.log(`  ${name} 失败: ${(error as Error).message}`);
    }
    // 别把官方 API 打太狠
    await new Promise(resolve => setTimeout(resolve, 120));
  }

  const usable = reports.filter(r => r.kind === "普通" && r.sources === 2 && r.best);
  usable.sort((a, b) => a.best!.cost - b.best!.cost);

  console.log("排名 房间     矿   锚点      总路程  到各点距离      spawn 放这里  可选锚点");
  usable.forEach((r, i) => {
    const best = r.best!;
    const spawn = `${best.x + FIRST_SPAWN_OFFSET.dx},${best.y + FIRST_SPAWN_OFFSET.dy}`;
    console.log(
      `${String(i + 1).padStart(3)}  ${r.name.padEnd(8)} ${r.mineral.padEnd(4)} ` +
        `(${String(best.x).padStart(2)},${String(best.y).padStart(2)})  ${String(best.cost).padStart(5)}   ` +
        `${best.distances.join("/").padEnd(14)}  (${spawn.padEnd(6)})     ${String(r.anchorCount).padStart(4)}`
    );
  });

  const rejected = reports.filter(r => r.kind === "普通" && r.sources === 2 && !r.best);
  if (rejected.length) {
    console.log(`\n放不下 bunker 的双源房：${rejected.map(r => r.name).join(", ")}`);
  }

  const others = reports.filter(r => r.kind !== "普通");
  if (others.length) {
    console.log(`不可占领：${others.map(r => `${r.name}(${r.kind})`).join(", ")}`);
  }
}

void main();
