/**
 * 选家脚本：批量评估房间本身的质量，算出 bunker 该放哪、第一个 spawn 该落在哪一格。
 *
 * 只看房间自身条件，不管邻居是谁——邻居那套逻辑在 find-safe-rooms.ts 里。
 *
 * 跑在 Node 里不消耗游戏 CPU，也不需要先占领房间，可以在 respawn 之前把候选区域全扫一遍。
 *
 * 用法：
 *   $env:TS_NODE_PROJECT="tsconfig.test.json"
 *   npx ts-node -r tsconfig-paths/register tools/scan-rooms.ts W11S26 W20S35
 */

import { RoomStatus, fetchMapStatsCached, fetchObjects, fetchTerrain } from "./api";
import { countOpenSpots, decodeTerrain } from "planner/terrain";
import { FIRST_SPAWN_OFFSET } from "planner/bunkerLayout";
import { rankAnchors } from "planner/bunkerPlanner";

interface Coord {
  x: number;
  y: number;
}

interface Candidate {
  name: string;
  mineral: string;
  anchor: Coord;
  /** 综合成本，沼泽已折算在内，排序用这个 */
  cost: number;
  /** 铺好路以后到各兴趣点的总步数 */
  steps: number;
  distances: number[];
  /** bunker 占地内的沼泽格数 */
  swampCells: number;
  anchorCount: number;
  /** 两个能量源周围各能站几个人，少于 2 会卡采集效率 */
  sourceSpots: number[];
  /** 控制器周围能站几个 upgrader */
  controllerSpots: number;
}

function parseRoomName(name: string): { horizontal: string; x: number; vertical: string; y: number } {
  const match = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
  if (!match) throw new Error(`房间名格式不对: ${name}`);
  return { horizontal: match[1], x: Number(match[2]), vertical: match[3], y: Number(match[4]) };
}

/** 坐标是 10 的倍数的是高速路；每个扇区中间 9 个房间由 Source Keeper 看守 */
function isClaimable(name: string): boolean {
  const { x, y } = parseRoomName(name);
  const mx = x % 10;
  const my = y % 10;
  if (mx === 0 || my === 0) return false;
  return !(mx >= 4 && mx <= 6 && my >= 4 && my <= 6);
}

function roomsInRange(from: string, to: string): string[] {
  const a = parseRoomName(from);
  const b = parseRoomName(to);

  const names: string[] = [];
  for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) {
    for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) {
      if (x < 0 || y < 0) continue;
      names.push(`${a.horizontal}${x}${a.vertical}${y}`);
    }
  }
  return names;
}

/** 新手区只对 GCL 4 以下开放，高 GCL 玩家进不去 */
function isNoviceArea(status: RoomStatus | undefined, now: number): boolean {
  return !!status?.novice && status.novice > now;
}

async function main(): Promise<void> {
  const [from, to] = process.argv.slice(2);
  if (!from) {
    console.log("用法: ts-node tools/scan-rooms.ts <起始房间> [结束房间]");
    return;
  }

  const target = to ? roomsInRange(from, to) : [from];

  console.log(`查询 ${target.length} 个房间的归属...`);
  const stats = await fetchMapStatsCached(target);
  const now = Date.now();

  const free = target.filter(name => {
    const info = stats[name];
    if (!info || info.status !== "normal" || info.own || !isClaimable(name)) return false;
    return !isNoviceArea(info, now);
  });

  const owned = target.filter(name => stats[name]?.own).length;
  console.log(`其中 ${owned} 个已被占领，${free.length} 个无主且可占领，开始逐个分析地形\n`);

  const candidates: Candidate[] = [];
  const rejected: { name: string; reason: string }[] = [];

  for (const name of free) {
    try {
      const objects = await fetchObjects(name);
      const sources = objects.filter(o => o.type === "source");
      const controller = objects.find(o => o.type === "controller");

      if (!controller) {
        rejected.push({ name, reason: "没有控制器" });
        continue;
      }
      if (sources.length < 2) {
        rejected.push({ name, reason: `只有 ${sources.length} 个能量源` });
        continue;
      }

      const terrain = decodeTerrain(await fetchTerrain(name));
      const targets = [...sources, controller].map(o => ({ x: o.x, y: o.y }));
      const ranked = rankAnchors(terrain, targets);

      if (ranked.length === 0) {
        rejected.push({ name, reason: "地形放不下 bunker" });
        continue;
      }

      const best = ranked[0];

      candidates.push({
        name,
        mineral: objects.find(o => o.type === "mineral")?.mineralType ?? "-",
        anchor: { x: best.x, y: best.y },
        cost: best.cost,
        steps: best.steps,
        distances: best.distances,
        swampCells: best.swampCells,
        anchorCount: ranked.length,
        sourceSpots: sources.map(s => countOpenSpots(terrain, s.x, s.y)),
        controllerSpots: countOpenSpots(terrain, controller.x, controller.y)
      });
    } catch (error) {
      console.log(`  ${name} 失败: ${(error as Error).message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  candidates.sort((a, b) => a.cost - b.cost);

  console.log("排名 房间     矿  锚点     成本 步数 到各点     spawn放这里 沼泽 源位 控位 锚点数");
  for (const [index, c] of candidates.entries()) {
    const spawn = `${c.anchor.x + FIRST_SPAWN_OFFSET.dx},${c.anchor.y + FIRST_SPAWN_OFFSET.dy}`;
    console.log(
      `${String(index + 1).padStart(3)}  ${c.name.padEnd(8)} ${c.mineral.padEnd(3)} ` +
        `(${String(c.anchor.x).padStart(2)},${String(c.anchor.y).padStart(2)}) ${String(c.cost).padStart(4)} ` +
        `${String(c.steps).padStart(4)} ${c.distances.join("/").padEnd(10)} (${spawn.padEnd(6)}) ` +
        `${String(c.swampCells).padStart(4)} ${c.sourceSpots.join("/").padEnd(4)} ` +
        `${String(c.controllerSpots).padStart(4)} ${String(c.anchorCount).padStart(6)}`
    );
  }

  if (candidates.length === 0) {
    console.log("（这片区域没有合适的房间）");
  }

  console.log(
    "\n成本 = 加权路程（沼泽按 5 倍算）+ bunker 内沼泽格数；步数 = 铺好路之后的距离\n" +
      "源位/控位 = 能量源和控制器周围能站几个 creep，源位低于 2 会卡住早期采集"
  );

  if (rejected.length) {
    console.log("\n淘汰的房间：");
    const byReason = new Map<string, string[]>();
    for (const r of rejected) {
      const list = byReason.get(r.reason) ?? [];
      list.push(r.name);
      byReason.set(r.reason, list);
    }
    for (const [reason, rooms] of byReason) {
      console.log(`  ${reason}（${rooms.length}）: ${rooms.join(" ")}`);
    }
  }
}

void main();
