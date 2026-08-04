/**
 * 选家脚本：批量评估房间，算出 bunker 该放哪、第一个 spawn 该落在哪一格，
 * 同时看一眼邻居是谁——地形再好，隔壁住着满级玩家也不能去。
 *
 * 跑在 Node 里不消耗游戏 CPU，也不需要先占领房间，可以在 respawn 之前把候选区域全扫一遍。
 *
 * 用法：
 *   $env:TS_NODE_PROJECT="tsconfig.test.json"
 *   npx ts-node -r tsconfig-paths/register tools/scan-rooms.ts W11S26 W20S35
 */

import { FIRST_SPAWN_OFFSET } from "planner/bunkerLayout";
import { rankAnchors } from "planner/bunkerPlanner";
import { decodeTerrain } from "planner/terrain";
import { RoomStatus, fetchMapStats, fetchObjects, fetchTerrain } from "./api";

/** 统计邻居时看多远，3 表示前后左右各 3 个房间 */
const NEIGHBOUR_RADIUS = 3;

interface Coord {
  x: number;
  y: number;
}

interface Candidate {
  name: string;
  sources: number;
  mineral: string;
  anchor: Coord;
  cost: number;
  distances: number[];
  anchorCount: number;
  /** 到最远那个兴趣点的步数，反映最长的一趟要跑多久 */
  worst: number;
  protectedUntil?: string;
  neighbours: NeighbourSurvey;
}

function parseRoomName(name: string): { horizontal: string; x: number; vertical: string; y: number } {
  const match = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
  if (!match) throw new Error(`房间名格式不对: ${name}`);
  return { horizontal: match[1], x: Number(match[2]), vertical: match[3], y: Number(match[4]) };
}

function buildRoomName(horizontal: string, x: number, vertical: string, y: number): string {
  return `${horizontal}${x}${vertical}${y}`;
}

/** 坐标是 10 的倍数的是高速路；每个扇区中间 9 个房间由 Source Keeper 看守 */
function isClaimable(name: string): boolean {
  const { x, y } = parseRoomName(name);
  const mx = x % 10;
  const my = y % 10;
  if (mx === 0 || my === 0) return false;
  return !(mx >= 4 && mx <= 6 && my >= 4 && my <= 6);
}

function roomsInRange(from: string, to: string, pad = 0): string[] {
  const a = parseRoomName(from);
  const b = parseRoomName(to);

  const names: string[] = [];
  for (let x = Math.min(a.x, b.x) - pad; x <= Math.max(a.x, b.x) + pad; x++) {
    for (let y = Math.min(a.y, b.y) - pad; y <= Math.max(a.y, b.y) + pad; y++) {
      if (x < 0 || y < 0) continue;
      names.push(buildRoomName(a.horizontal, x, a.vertical, y));
    }
  }
  return names;
}

interface NeighbourSurvey {
  /** 新手保护区内的邻居，保护期内只有他们够得着你 */
  inside: number;
  insideStrongest: number;
  /** 保护区外的邻居，保护期一过就是威胁 */
  outside: number;
  outsideStrongest: number;
}

function isProtected(status: RoomStatus | undefined, now: number): boolean {
  return !!status?.novice && status.novice > now;
}

/** 分别统计保护区内外的邻居，因为两者的威胁完全不是一回事 */
function surveyNeighbours(name: string, stats: Record<string, RoomStatus>, now: number): NeighbourSurvey {
  const { horizontal, x, vertical, y } = parseRoomName(name);
  const survey: NeighbourSurvey = { inside: 0, insideStrongest: 0, outside: 0, outsideStrongest: 0 };

  for (let dx = -NEIGHBOUR_RADIUS; dx <= NEIGHBOUR_RADIUS; dx++) {
    for (let dy = -NEIGHBOUR_RADIUS; dy <= NEIGHBOUR_RADIUS; dy++) {
      if (dx === 0 && dy === 0) continue;
      const neighbour = buildRoomName(horizontal, x + dx, vertical, y + dy);
      const info = stats[neighbour];
      if (!info?.own) continue;

      if (isProtected(info, now)) {
        survey.inside++;
        survey.insideStrongest = Math.max(survey.insideStrongest, info.own.level);
      } else {
        survey.outside++;
        survey.outsideStrongest = Math.max(survey.outsideStrongest, info.own.level);
      }
    }
  }

  return survey;
}

async function main(): Promise<void> {
  const [from, to] = process.argv.slice(2);
  if (!from) {
    console.log("用法: ts-node tools/scan-rooms.ts <起始房间> [结束房间]");
    return;
  }

  const target = to ? roomsInRange(from, to) : [from];
  // 多查一圈用来统计邻居
  const withPadding = to ? roomsInRange(from, to, NEIGHBOUR_RADIUS) : [from];

  console.log(`查询 ${withPadding.length} 个房间的归属...`);
  const stats = await fetchMapStats(withPadding);
  const now = Date.now();

  const free = target.filter(name => {
    const info = stats[name];
    return info && info.status === "normal" && !info.own && isClaimable(name);
  });

  const owned = target.filter(name => stats[name]?.own);
  console.log(`其中 ${owned.length} 个已被占领，${free.length} 个无主且可占领，开始逐个分析地形\n`);

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
      const novice = stats[name]?.novice;

      candidates.push({
        name,
        sources: sources.length,
        mineral: objects.find(o => o.type === "mineral")?.mineralType ?? "-",
        anchor: { x: best.x, y: best.y },
        cost: best.cost,
        distances: best.distances,
        worst: Math.max(...best.distances),
        anchorCount: ranked.length,
        protectedUntil: novice && novice > now ? new Date(novice).toISOString().slice(0, 10) : undefined,
        neighbours: surveyNeighbours(name, stats, now)
      });
    } catch (error) {
      console.log(`  ${name} 失败: ${(error as Error).message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  candidates.sort((a, b) => a.cost - b.cost);

  console.log("排名 房间     矿  锚点     总路程 最远 到各点     spawn放这里 锚点数 区内邻居 区外邻居 保护到期");
  for (const [index, c] of candidates.entries()) {
    const spawn = `${c.anchor.x + FIRST_SPAWN_OFFSET.dx},${c.anchor.y + FIRST_SPAWN_OFFSET.dy}`;
    const inside = c.neighbours.inside ? `${c.neighbours.inside}个/最高RCL${c.neighbours.insideStrongest}` : "无";
    const outside = c.neighbours.outside ? `${c.neighbours.outside}个/最高RCL${c.neighbours.outsideStrongest}` : "无";
    console.log(
      `${String(index + 1).padStart(3)}  ${c.name.padEnd(8)} ${c.mineral.padEnd(3)} ` +
        `(${String(c.anchor.x).padStart(2)},${String(c.anchor.y).padStart(2)}) ${String(c.cost).padStart(5)} ` +
        `${String(c.worst).padStart(4)} ${c.distances.join("/").padEnd(10)} (${spawn.padEnd(6)}) ` +
        `${String(c.anchorCount).padStart(5)} ${inside.padEnd(12)} ${outside.padEnd(12)} ${c.protectedUntil ?? "-"}`
    );
  }

  if (candidates.length === 0) {
    console.log("（这片区域没有合适的房间）");
  }

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
