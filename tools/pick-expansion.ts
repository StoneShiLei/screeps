/**
 * 分房选址。
 *
 * 和当初选家（scan-rooms.ts）看的东西不一样。选家只管房间自身好不好，分房还得看
 * 两件事：
 *
 * 一是离老家几格。太远支援不到——第一个 spawn 要 15000 能量，全得从老家运过去，
 * 隔三个房间的单程就是一百多 tick，运输队一辈子跑不了几趟。太近又浪费：贴着老家
 * 的房间本来可以当外矿采，占下来等于把自己的外矿圈吃掉一个。两格是甜点。
 *
 * 二是邻居是谁。旁边坐着个 RCL7 的老玩家，早期那点防御等于没有；而无主的空区
 * 意味着以后的外矿都是自己的。
 *
 * 用法：npx ts-node tools/pick-expansion.ts E28S36 [半径]
 */

import { RoomStatus, fetchMapStatsCached, fetchObjects, fetchTerrain, fetchUsername } from "./api";
import { countOpenSpots, decodeTerrain, exitSides } from "../src/planner/terrain";
import { FIRST_SPAWN_OFFSET } from "../src/planner/bunkerLayout";
import { rankAnchors } from "../src/planner/bunkerPlanner";

const home = process.argv[2] ?? "E28S36";
const radius = Number(process.argv[3] ?? 3);

interface Coord {
  x: number;
  y: number;
}

interface Candidate {
  name: string;
  distance: number;
  mineral: string;
  anchor: Coord;
  cost: number;
  steps: number;
  swampCells: number;
  sourceSpots: number[];
  controllerSpots: number;
  exits: string;
  /** 综合评分，越小越好 */
  score: number;
}

function parse(name: string): { h: string; x: number; v: string; y: number } {
  const match = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
  if (!match) throw new Error(`房间名格式不对: ${name}`);
  return { h: match[1], x: Number(match[2]), v: match[3], y: Number(match[4]) };
}

/** 坐标是 10 的倍数的是高速路；每个扇区中间 9 个房间由 Source Keeper 看守 */
function isClaimable(name: string): boolean {
  const { x, y } = parse(name);
  const mx = x % 10;
  const my = y % 10;
  if (mx === 0 || my === 0) return false;
  return !(mx >= 4 && mx <= 6 && my >= 4 && my <= 6);
}

function box(center: string, size: number): string[] {
  const { h, x, v, y } = parse(center);
  const names: string[] = [];

  for (let dx = -size; dx <= size; dx++) {
    for (let dy = -size; dy <= size; dy++) {
      if (x + dx < 0 || y + dy < 0) continue;
      names.push(`${h}${x + dx}${v}${y + dy}`);
    }
  }

  return names;
}

function distanceBetween(a: string, b: string): number {
  const first = parse(a);
  const second = parse(b);
  if (first.h !== second.h || first.v !== second.v) return Infinity;

  return Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y));
}

/**
 * 邻居地图。
 *
 * 一眼看清自己坐在什么地方：谁在旁边、多高等级、哪片是空的。这比一串房间名
 * 直观得多，早期挨着谁基本决定了能不能安稳发育。
 */
async function drawNeighborhood(stats: Record<string, RoomStatus>): Promise<void> {
  const { h, x: hx, v, y: hy } = parse(home);
  const names = new Map<string, string>();

  for (const status of Object.values(stats)) {
    if (status.own) names.set(status.own.user, "");
  }
  for (const id of names.keys()) names.set(id, await fetchUsername(id));

  console.log(`\n${home} 周边 ${radius * 2 + 1}×${radius * 2 + 1}（· 无主  数字 该玩家的 RCL  H 老家  × 高速/SK）\n`);

  let header = "        ";
  for (let dx = -radius; dx <= radius; dx++) header += `${h}${hx + dx} `.padEnd(7);
  console.log(header);

  for (let dy = -radius; dy <= radius; dy++) {
    let row = `${v}${hy + dy} `.padEnd(8);

    for (let dx = -radius; dx <= radius; dx++) {
      const name = `${h}${hx + dx}${v}${hy + dy}`;
      const status = stats[name];
      row += cell(name, status).padEnd(7);
    }

    console.log(row);
  }

  const owners = [...names.entries()]
    .map(([id, name]) => {
      const rooms = Object.entries(stats).filter(([, status]) => status.own?.user === id);
      const levels = rooms.map(([, status]) => status.own?.level ?? 0);
      return `${name}（${rooms.length} 房，最高 RCL ${Math.max(...levels)}）`;
    })
    .join("，");
  console.log(`\n周边玩家：${owners || "一个都没有"}`);
}

function cell(name: string, status: RoomStatus | undefined): string {
  if (name === home) return "  H  ";
  if (!status || status.status !== "normal") return "  ?  ";
  if (!isClaimable(name)) return "  ×  ";
  if (status.own) return ` ${String(status.own.level).padStart(2)}  `;
  return "  ·  ";
}

async function main(): Promise<void> {
  const target = box(home, radius);
  console.log(`查询 ${target.length} 个房间的归属...`);
  const stats = await fetchMapStatsCached(target);

  await drawNeighborhood(stats);

  const now = Date.now();
  const free = target.filter(name => {
    const status = stats[name];
    if (name === home || !status || status.status !== "normal" || status.own || !isClaimable(name)) return false;
    // 新手区只对 GCL 4 以下开放，我们进不去
    return !(status.novice && status.novice > now);
  });

  console.log(`\n无主且可占领的有 ${free.length} 个，逐个看地形\n`);

  const candidates: Candidate[] = [];
  const rejected: { name: string; reason: string }[] = [];

  for (const name of free) {
    const objects = await fetchObjects(name);
    const sources = objects.filter(object => object.type === "source");
    const controller = objects.find(object => object.type === "controller");

    if (!controller) {
      rejected.push({ name, reason: "没有控制器" });
      continue;
    }
    if (sources.length < 2) {
      rejected.push({ name, reason: `只有 ${sources.length} 个源` });
      continue;
    }
    if (objects.some(object => object.type === "invaderCore")) {
      rejected.push({ name, reason: "有 invader core" });
      continue;
    }

    const terrain = decodeTerrain(await fetchTerrain(name));
    const ranked = rankAnchors(
      terrain,
      [...sources, controller].map(object => ({ x: object.x, y: object.y }))
    );

    if (ranked.length === 0) {
      rejected.push({ name, reason: "放不下 bunker" });
      continue;
    }

    const best = ranked[0];
    const distance = distanceBetween(home, name);

    candidates.push({
      name,
      distance,
      mineral: objects.find(object => object.type === "mineral")?.mineralType ?? "-",
      anchor: { x: best.x, y: best.y },
      cost: best.cost,
      steps: best.steps,
      swampCells: best.swampCells,
      sourceSpots: sources.map(source => countOpenSpots(terrain, source.x, source.y)),
      controllerSpots: countOpenSpots(terrain, controller.x, controller.y),
      exits: exitSides(terrain).join(""),
      score: 0
    });

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  for (const candidate of candidates) candidate.score = scoreOf(candidate);
  candidates.sort((a, b) => a.score - b.score);

  console.log("排名 房间     距离 矿  锚点     评分 布局成本 沼泽 源位 控位 出口   spawn 落点");
  for (const [index, candidate] of candidates.entries()) {
    const spawn = `${candidate.anchor.x + FIRST_SPAWN_OFFSET.dx},${candidate.anchor.y + FIRST_SPAWN_OFFSET.dy}`;
    console.log(
      `${String(index + 1).padStart(3)}  ${candidate.name.padEnd(8)} ${String(candidate.distance).padStart(3)}  ` +
        `${candidate.mineral.padEnd(3)} (${String(candidate.anchor.x).padStart(2)},${String(candidate.anchor.y).padStart(2)}) ` +
        `${candidate.score.toFixed(0).padStart(4)} ${candidate.cost.toFixed(0).padStart(8)} ` +
        `${String(candidate.swampCells).padStart(4)} ${candidate.sourceSpots.join("/").padEnd(4)} ` +
        `${String(candidate.controllerSpots).padStart(4)} ${candidate.exits.padEnd(6)} (${spawn})`
    );
  }

  if (rejected.length) {
    console.log("\n淘汰：");
    const byReason = new Map<string, string[]>();
    for (const item of rejected) {
      const list = byReason.get(item.reason) ?? [];
      list.push(item.name);
      byReason.set(item.reason, list);
    }
    for (const [reason, rooms] of byReason) console.log(`  ${reason}（${rooms.length}）：${rooms.join(" ")}`);
  }

  console.log(
    "\n评分 = 布局成本 + 距离惩罚。两格最省心：一格会吃掉自己的外矿圈，三格以上" +
      "第一个 spawn 的 15000 能量运不过去\n源位低于 2 会卡早期采集，控位低会锁死升级速度，出口越少越好守"
  );
}

/**
 * 分房评分。
 *
 * 布局成本是老本行：铺好路之后从 bunker 到两个源和控制器的总步数，沼泽已折算进去。
 * 在它之上加一笔距离惩罚——两格不罚，一格罚得狠（等于自断一个外矿），三格往外
 * 每多一格都要按支援成本算，因为那 15000 能量的 spawn 全靠老家运。
 */
function scoreOf(candidate: Candidate): number {
  const ideal = 2;
  const penalty = candidate.distance < ideal ? 60 : (candidate.distance - ideal) * 40;

  // 源位不足 2 的房间，早期两个矿工挤在一格上，产能直接砍半
  const cramped = candidate.sourceSpots.filter(spots => spots < 2).length * 30;

  return candidate.cost + penalty + cramped;
}

void main();
