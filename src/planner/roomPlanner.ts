/**
 * 房间布局模块：算出 bunker 该放哪、画出来给人看、按等级把工地拍下去。
 *
 * 规划结果只往 Memory 里存一个锚点坐标，其余上百个建筑位置都由布局表加偏移算出来，
 * 所以 Memory 占用极小，也不用担心存量随房间数增长。
 */

import { BUNKER_STRUCTURES, FIRST_SPAWN_OFFSET } from "./bunkerLayout";
import { canPlaceBunker, rankAnchors, structuresForLevel } from "./bunkerPlanner";
import { terrainOfRoom } from "./terrain";

/** 在房间里放一个名字以此开头的旗子，就会触发规划并显示布局 */
export const PLANNER_FLAG_PREFIX = "plan";

/** 同时最多留几个工地，太多会分散 builder 的注意力，也拖慢建造速度 */
const MAX_CONSTRUCTION_SITES = 5;

/** 每隔多少 tick 检查一次要不要拍新工地 */
const BUILD_CHECK_INTERVAL = 10;

/**
 * 先建关键设施，道路排最后——早期能量紧张，路是锦上添花。
 *
 * 这里写字符串字面量而不是 STRUCTURE_SPAWN 之类的全局常量：那些常量只在游戏运行时存在，
 * 模块顶层引用它们会让单元测试在加载阶段就崩掉。字面量的类型检查效果完全一样。
 */
const BUILD_PRIORITY: BuildableStructureConstant[] = [
  "spawn",
  "tower",
  "extension",
  "storage",
  "container",
  "terminal",
  "link",
  "lab",
  "powerSpawn",
  "nuker",
  "observer",
  "road"
];

const ICON: Partial<Record<BuildableStructureConstant, string>> = {
  spawn: "🏠",
  extension: "🔸",
  tower: "🗼",
  storage: "📦",
  terminal: "📮",
  lab: "🧪",
  link: "🔗",
  nuker: "☢",
  powerSpawn: "⚛",
  observer: "👁",
  container: "🛢"
};

export function runRoomPlanner(room: Room): void {
  const flag = findPlannerFlag(room);

  if (flag && !room.memory.anchor) {
    planRoom(room);
  }

  if (flag) {
    visualizePlan(room);
  }

  if (room.memory.anchor) {
    maintainConstructionSites(room);
  }
}

function findPlannerFlag(room: Room): Flag | undefined {
  return room.find(FIND_FLAGS).find(flag => flag.name.startsWith(PLANNER_FLAG_PREFIX));
}

/**
 * 算出锚点存进 Memory。这一步开销较大，但只在放旗子那一下跑一次，
 * 之后每 tick 都是直接读 Memory。
 */
export function planRoom(room: Room): boolean {
  const sources = room.find(FIND_SOURCES);
  const controller = room.controller;

  if (!controller) {
    console.log(`[规划] ${room.name} 没有控制器，无法规划`);
    return false;
  }

  // 房间里已经有 spawn 的话，锚点只能由它反推。
  // 重新算最优位置的话，算出来的锚点多半和现有 spawn 对不上，整个布局就歪了。
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (spawn) {
    const anchor = {
      x: spawn.pos.x - FIRST_SPAWN_OFFSET.dx,
      y: spawn.pos.y - FIRST_SPAWN_OFFSET.dy
    };
    room.memory.anchor = anchor;

    const fits = canPlaceBunker(terrainOfRoom(room.name), anchor.x, anchor.y);
    console.log(
      `[规划] ${room.name} 锚点由已有 spawn 反推为 (${anchor.x},${anchor.y})` +
        (fits ? "" : "，注意：这个位置地形放不下完整 bunker，部分建筑会被墙挡住")
    );
    return true;
  }

  const started = Game.cpu.getUsed();
  const targets = [...sources.map(s => s.pos), controller.pos].map(pos => ({ x: pos.x, y: pos.y }));
  const candidates = rankAnchors(terrainOfRoom(room.name), targets);

  if (candidates.length === 0) {
    console.log(`[规划] ${room.name} 地形放不下 bunker`);
    return false;
  }

  const best = candidates[0];
  room.memory.anchor = { x: best.x, y: best.y };

  console.log(
    `[规划] ${room.name} 锚点定在 (${best.x},${best.y})，总路程 ${best.cost}，` +
      `候选位置 ${candidates.length} 个，耗时 ${(Game.cpu.getUsed() - started).toFixed(1)} CPU`
  );
  return true;
}

/** 把完整布局画在房间里，已经建好的用绿色标出来 */
export function visualizePlan(room: Room): void {
  const anchor = room.memory.anchor;
  if (!anchor) return;

  const visual = room.visual;
  const level = room.controller?.level ?? 0;

  for (const structure of BUNKER_STRUCTURES) {
    const x = anchor.x + structure.dx;
    const y = anchor.y + structure.dy;
    const unlocked = structure.rcl <= level;

    if (structure.type === "road") {
      visual.circle(x, y, { radius: 0.12, fill: unlocked ? "#888888" : "#3a3a3a", stroke: undefined });
      continue;
    }

    visual.text(ICON[structure.type] ?? "?", x, y, {
      font: unlocked ? 0.7 : 0.5,
      opacity: unlocked ? 1 : 0.35
    });
  }

  visual.text("锚点", anchor.x, anchor.y + 0.3, { font: 0.4, color: "#ffff00" });
}

/**
 * 按当前等级把还没建的东西拍成工地。
 *
 * 不是一次性全拍下去：同时开太多工地会让 builder 来回跑，也会把能量摊薄，
 * 所以每次只补到上限，并且按优先级来。
 */
function maintainConstructionSites(room: Room): void {
  if (Game.time - (room.memory.lastBuildCheck ?? 0) < BUILD_CHECK_INTERVAL) return;
  room.memory.lastBuildCheck = Game.time;

  const anchor = room.memory.anchor;
  if (!anchor) return;

  const existing = room.find(FIND_MY_CONSTRUCTION_SITES).length;
  if (existing >= MAX_CONSTRUCTION_SITES) return;

  const level = room.controller?.level ?? 0;
  const wanted = structuresForLevel(level).sort(
    (a, b) => BUILD_PRIORITY.indexOf(a.type) - BUILD_PRIORITY.indexOf(b.type)
  );

  let placed = existing;

  for (const structure of wanted) {
    if (placed >= MAX_CONSTRUCTION_SITES) break;

    const x = anchor.x + structure.dx;
    const y = anchor.y + structure.dy;
    if (isAlreadyThere(room, x, y, structure.type)) continue;

    const result = room.createConstructionSite(x, y, structure.type);
    if (result === OK) {
      placed++;
    } else if (result === ERR_RCL_NOT_ENOUGH) {
      // 该类型这一级的名额用完了，跳过同类型剩下的
      continue;
    }
  }
}

function isAlreadyThere(room: Room, x: number, y: number, type: BuildableStructureConstant): boolean {
  const position = room.getPositionAt(x, y);
  if (!position) return true;

  const built = position.lookFor(LOOK_STRUCTURES).some(s => s.structureType === type);
  if (built) return true;

  return position.lookFor(LOOK_CONSTRUCTION_SITES).length > 0;
}
