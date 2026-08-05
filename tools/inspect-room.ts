/**
 * 把房间里实际存在的对象列出来，看看现场是什么样。
 *
 * 规划工具看的是地形，这个看的是地面上真实摆着的东西：自己的建筑、工地、
 * 前人留下的废墟和墙。用法：npx ts-node tools/inspect-room.ts E28S36
 */

import { ROOM_SIZE, TERRAIN_WALL, UNREACHABLE, decodeTerrain, walkingDistanceFrom } from "../src/planner/terrain";
import { RoomObject, fetchObjects, fetchTerrain } from "./api";
import { BUNKER_STRUCTURES, FIRST_SPAWN_OFFSET } from "../src/planner/bunkerLayout";
import { rankAnchors } from "../src/planner/bunkerPlanner";

interface WallObject extends RoomObject {
  hits?: number;
  hitsMax?: number;
}

interface SiteObject extends RoomObject {
  structureType?: string;
  progress?: number;
  progressTotal?: number;
}

interface StoreObject extends RoomObject {
  store?: Record<string, number>;
  energy?: number;
  destroyTime?: number;
  decayTime?: number;
}

const room = process.argv[2] ?? "E28S36";

function groupByType(objects: RoomObject[]): Map<string, RoomObject[]> {
  const groups = new Map<string, RoomObject[]>();

  for (const object of objects) {
    const list = groups.get(object.type) ?? [];
    list.push(object);
    groups.set(object.type, list);
  }

  return groups;
}

/** 房间俯视图：地形打底，上面叠真实存在的对象 */
function render(terrain: Uint8Array, objects: RoomObject[]): string {
  const icons: Record<string, string> = {
    spawn: "S",
    extension: "e",
    container: "c",
    tower: "T",
    storage: "G",
    road: "·",
    constructedWall: "#",
    rampart: "R",
    controller: "C",
    source: "$",
    mineral: "M",
    constructionSite: "+",
    ruin: "r",
    creep: "@"
  };

  const grid: string[][] = [];
  for (let y = 0; y < ROOM_SIZE; y++) {
    const row: string[] = [];
    for (let x = 0; x < ROOM_SIZE; x++) {
      row.push(terrain[y * ROOM_SIZE + x] === TERRAIN_WALL ? "▓" : " ");
    }
    grid.push(row);
  }

  for (const object of objects) {
    grid[object.y][object.x] = icons[object.type] ?? "?";
  }

  return grid.map((row, y) => `${String(y).padStart(2)} ${row.join("")}`).join("\n");
}

async function main(): Promise<void> {
  const [terrainString, objects] = await Promise.all([fetchTerrain(room), fetchObjects(room)]);
  const terrain = decodeTerrain(terrainString);

  console.log(`\n${room} 现场对象\n`);

  const groups = groupByType(objects);
  for (const [type, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const owners = new Set(list.map(object => object.user ?? "无主"));
    console.log(`${type.padEnd(18)} ${String(list.length).padStart(3)} 个   归属 ${[...owners].join(" ")}`);
  }

  const sites = (groups.get("constructionSite") ?? []) as SiteObject[];
  if (sites.length) {
    console.log("\n在建工地：");
    for (const site of sites) {
      const percent = site.progressTotal ? Math.floor(((site.progress ?? 0) / site.progressTotal) * 100) : 0;
      console.log(`  ${(site.structureType ?? "?").padEnd(12)} (${site.x},${site.y})  ${percent}%`);
    }
  }

  reportLoot(groups);

  const walls = (groups.get("constructedWall") ?? []) as WallObject[];
  const ramparts = (groups.get("rampart") ?? []) as WallObject[];

  if (walls.length || ramparts.length) {
    console.log(`\n前人留下的防御工事：墙 ${walls.length} 段，rampart ${ramparts.length} 段`);
    const hits = walls.map(wall => wall.hits ?? 0);
    if (hits.length) {
      const sorted = [...hits].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      console.log(`  血量 最低 ${fmt(Math.min(...hits))} / 中位 ${fmt(median)} / 最高 ${fmt(Math.max(...hits))}`);
      // 一个 WORK 每 tick 拆 50 点血
      console.log(`  以 10 个 WORK 计，拆最薄的一段要 ${Math.ceil(Math.min(...hits) / 500)} tick，最厚的要 ${fmt(Math.ceil(Math.max(...hits) / 500))} tick`);
    }
  }

  analyseBlocking(terrain, objects, walls);

  console.log(`\n${render(terrain, objects)}\n`);
}

function fmt(value: number): string {
  return value.toLocaleString("en-US");
}

/** 会自己消失的那些资源：捡不到就是白白蒸发掉 */
function reportLoot(groups: Map<string, RoomObject[]>): void {
  const perishable = ["ruin", "tombstone", "energy", "resource"];
  let reported = false;

  for (const type of perishable) {
    const list = (groups.get(type) ?? []) as StoreObject[];
    if (list.length === 0) continue;

    const totals: Record<string, number> = {};
    let withLoot = 0;

    for (const object of list) {
      const store = object.store ?? (object.energy !== undefined ? { energy: object.energy } : {});
      const amount = Object.values(store).reduce((sum, value) => sum + value, 0);
      if (amount > 0) withLoot++;

      for (const [resource, value] of Object.entries(store)) {
        totals[resource] = (totals[resource] ?? 0) + value;
      }
    }

    const contents = Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .map(([resource, value]) => `${resource} ${fmt(value)}`)
      .join("，");

    if (!reported) {
      console.log("\n会消失的资源：");
      reported = true;
    }
    console.log(`  ${type.padEnd(10)} ${list.length} 个，其中 ${withLoot} 个有货   ${contents || "全空"}`);

    const decays = list.map(object => object.decayTime ?? 0).filter(time => time > 0);
    if (decays.length) {
      console.log(`    最早 ${fmt(Math.min(...decays))} tick 消失，最晚 ${fmt(Math.max(...decays))} tick`);
    }
  }
}

/**
 * 墙碍不碍事，只看两件事：挡没挡住 bunker 的地皮，挡没挡住去矿和去控制器的路。
 * 不挡的话它就是白捡的防御工事，一段都不用拆。
 */
function analyseBlocking(terrain: Uint8Array, objects: RoomObject[], walls: WallObject[]): void {
  const spawn = objects.find(object => object.type === "spawn");
  if (!spawn) {
    console.log("\n房间里还没有 spawn，无法判断阻挡情况");
    return;
  }

  const anchor = { x: spawn.x - FIRST_SPAWN_OFFSET.dx, y: spawn.y - FIRST_SPAWN_OFFSET.dy };
  console.log(`\nspawn 在 (${spawn.x},${spawn.y})，反推锚点 (${anchor.x},${anchor.y})`);

  const wallAt = new Map<string, WallObject>();
  for (const wall of walls) wallAt.set(`${wall.x},${wall.y}`, wall);

  const inFootprint: WallObject[] = [];
  for (const structure of BUNKER_STRUCTURES) {
    const wall = wallAt.get(`${anchor.x + structure.dx},${anchor.y + structure.dy}`);
    if (wall) inFootprint.push(wall);
  }

  if (inFootprint.length === 0) {
    console.log("  bunker 的 128 格地皮上没有墙，基地照常铺开");
  } else {
    const lost: Record<string, number> = {};
    for (const structure of BUNKER_STRUCTURES) {
      if (wallAt.has(`${anchor.x + structure.dx},${anchor.y + structure.dy}`)) {
        lost[structure.type] = (lost[structure.type] ?? 0) + 1;
      }
    }

    const thinnest = Math.min(...inFootprint.map(wall => wall.hits ?? 0));
    console.log(`  bunker 地皮上压着 ${inFootprint.length} 段墙，最薄的一段 ${fmt(thinnest)} 血`);
    console.log(`  被占掉的建筑位：${Object.entries(lost).map(([type, count]) => `${type}×${count}`).join("，")}`);
  }

  // 把墙当成地形障碍再走一遍，走不通就说明被围死了
  const blocked = Uint8Array.from(terrain);
  for (const wall of walls) blocked[wall.y * ROOM_SIZE + wall.x] = TERRAIN_WALL;

  const open = walkingDistanceFrom(terrain, anchor.x, anchor.y);
  const walled = walkingDistanceFrom(blocked, anchor.x, anchor.y);

  const targets = objects.filter(object => object.type === "source" || object.type === "controller");
  for (const target of targets) {
    // 能量源和控制器自己那一格往往嵌在墙里，creep 是站在旁边操作的，
    // 所以要看的是"能不能走到它旁边"
    const free = reachNextTo(open, target.x, target.y);
    const detour = reachNextTo(walled, target.x, target.y);
    const detourText = detour === UNREACHABLE ? "被墙封死" : `${detour} 步`;
    console.log(`  ${target.type} (${target.x},${target.y})：无视墙 ${free} 步，绕开墙 ${detourText}`);
  }

  // 把人造墙当地形再排一次名，看看这房间还剩下哪些位置放得下完整的 bunker
  const targetPositions = targets.map(target => ({ x: target.x, y: target.y }));
  const candidates = rankAnchors(blocked, targetPositions);

  if (candidates.length === 0) {
    console.log("\n  把这些墙算进地形之后，全房间没有一处放得下完整的 13x13 bunker");
  } else {
    console.log(`\n  避开所有墙还能放下完整 bunker 的位置有 ${candidates.length} 处，最好的几个：`);
    for (const candidate of candidates.slice(0, 3)) {
      const shift = Math.max(Math.abs(candidate.x - anchor.x), Math.abs(candidate.y - anchor.y));
      console.log(`    (${candidate.x},${candidate.y}) 总路程 ${candidate.steps} 步，离现在的锚点 ${shift} 格`);
    }
  }
}

function reachNextTo(distance: Uint16Array, x: number, y: number): number {
  let best = UNREACHABLE;

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= ROOM_SIZE || ny >= ROOM_SIZE) continue;
      best = Math.min(best, distance[ny * ROOM_SIZE + nx]);
    }
  }

  return best;
}

void main();
