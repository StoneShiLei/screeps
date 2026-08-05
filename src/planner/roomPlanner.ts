/**
 * 房间布局模块：算出 bunker 该放哪、画出来给人看、按等级把工地拍下去。
 *
 * 规划结果只往 Memory 里存一个锚点坐标，其余上百个建筑位置都由布局表加偏移算出来，
 * 所以 Memory 占用极小，也不用担心存量随房间数增长。
 */

import { BUNKER_STRUCTURES, BunkerStructure, FIRST_SPAWN_OFFSET } from "./bunkerLayout";
import { Coord, planOutposts } from "./outposts";
import { TerrainGrid, terrainOfRoom } from "./terrain";
import { canPlaceBunker, isBunkerCell, rankAnchors } from "./bunkerPlanner";
import { decodeCells, planRoads } from "./roads";
import { isVisualOn } from "../utils/settings";
import { log } from "../utils/logger";

/** 在房间里放一个名字以此开头的旗子，就会触发规划并显示布局 */
export const PLANNER_FLAG_PREFIX = "plan";

/** 同时最多留几个工地，太多会分散 builder 的注意力，也拖慢建造速度 */
const MAX_CONSTRUCTION_SITES = 5;

/** 每隔多少 tick 检查一次要不要拍新工地 */
const BUILD_CHECK_INTERVAL = 10;

/** bunker 从锚点往外铺几格 */
const BUNKER_RADIUS = BUNKER_STRUCTURES.reduce(
  (max, structure) => Math.max(max, Math.abs(structure.dx), Math.abs(structure.dy)),
  0
);

const ROOM_EDGE = 49;

/**
 * 能量源旁的容器排在所有东西前面，连 extension 都要让路。
 *
 * 它一建好，矿工就能上岗：三个 WORK 钉在矿边每 tick 稳挖 6 点，而三个来回
 * 跑的 harvester 加起来也就 3 点上下。先把这条产线接通，后面所有建设都快一倍。
 */
const MINING_CONTAINER_PRIORITY = -1;

/** bunker 内部的缓冲容器，早期没有 storage 和 link 配合，建了也是空放着 */
const BUNKER_CONTAINER_PRIORITY = 99;

/**
 * 本地推后布局表给的解锁等级。只能往后推，不能提前。
 *
 * 布局表把 bunker 内部容器标成 2 级，但它们是给 storage 和 link 当缓冲的，
 * 而 storage 要 4 级。提前建出来没人往里放东西，却照样每 100 tick 掉血，
 * 等于花钱雇 builder 去修一个空盒子。7 级那个容器不受影响，取较大值就是 7。
 */
const UNLOCK_OVERRIDE: Partial<Record<BuildableStructureConstant, number>> = {
  container: 4
};

/** 这个建筑实际几级才开工 */
export function unlockLevel(structure: BunkerStructure): number {
  return Math.max(structure.rcl, UNLOCK_OVERRIDE[structure.type] ?? 0);
}

/**
 * 几级开始铺路。
 *
 * 和 bunker 内部那圈路（布局表里定的 4 级）保持一致，是因为道路的收益算的是
 * 整条路线：hauler 带几个 MOVE，取决于跑完全程要攒多少疲劳。基地外面铺好了、
 * 里面还没铺，它照样得按最坏情况配 1:1 的 MOVE，外面那几格就白花了。
 * 半条路等于没路，所以两段要么一起有，要么一起没有。
 *
 * 定在 4 级而不是提前，是因为内部那七十多格路本身就是两万多能量的工程，
 * 3 级时每 tick 才二十点收入，这笔钱砸进 extension 和 tower 的回报高得多。
 * 4 级解锁 storage，能量才真正宽裕起来。
 */
const ROAD_MIN_LEVEL = 4;

/**
 * 沼泽段是唯一的例外，可以提前单独铺。
 *
 * 上面那套"半条路等于没路"的道理对平地成立，对沼泽不成立：平地一格才省
 * 一点疲劳，要连成片才看得出来；沼泽一格省九点，孤零零铺一格也立刻见效，
 * 因为它本身就是整条路线上的瓶颈。
 */
const SWAMP_ROAD_MIN_LEVEL = 3;

/** 路点画得比结构图标小，但得比地形噪点大，不然在深色地面上看不见 */
const ROAD_DOT_RADIUS = 0.22;

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

/**
 * 沼泽段的路排在其余路面前面。
 *
 * 平地走一步两点疲劳，铺上路降到一点，省一点；沼泽是十点降到一点，省九点。
 * 而沼泽路的造价只有平地的五倍——五倍的钱买九倍的收益，同样的预算先砸这里。
 */
const SWAMP_ROAD_PRIORITY = BUILD_PRIORITY.indexOf("road") - 0.5;

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

  // 已经有 spawn 时锚点是反推出来的，几乎不花 CPU，可以自动规划；
  // 没有 spawn 就得全房间搜索最优位置，那个开销大，留给旗子手动触发。
  if (!room.memory.anchor && (flag || room.find(FIND_MY_SPAWNS).length > 0)) {
    planRoom(room);
  } else if (
    room.memory.anchor &&
    (!room.memory.miningSpots || !room.memory.upgradeStations || room.memory.roads === undefined)
  ) {
    // 锚点是老版本代码存下的，落点、站位或主干道还没算过，补上
    planOutpostsFor(room, terrainOfRoom(room.name), room.memory.anchor);
  }

  // 旗子和调试开关两个条件并存：旗子是临时查看，开关是常开着盯着看
  if (flag || isVisualOn("planner")) {
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
    log.warn("规划", `${room.name} 没有控制器，无法规划`);
    return false;
  }

  const terrain = terrainOfRoom(room.name);

  // 房间里已经有 spawn 的话，锚点只能由它反推。
  // 重新算最优位置的话，算出来的锚点多半和现有 spawn 对不上，整个布局就歪了。
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (spawn) {
    const inferred = {
      x: spawn.pos.x - FIRST_SPAWN_OFFSET.dx,
      y: spawn.pos.y - FIRST_SPAWN_OFFSET.dy
    };
    room.memory.anchor = inferred;

    const fits = canPlaceBunker(terrain, inferred.x, inferred.y);
    if (fits) {
      log.info("规划", `${room.name} 锚点由已有 spawn 反推为 (${inferred.x},${inferred.y})`);
    } else {
      log.warn(
        "规划",
        `${room.name} 锚点由已有 spawn 反推为 (${inferred.x},${inferred.y})，地形放不下完整 bunker，部分建筑会被墙挡住`
      );
    }
    planOutpostsFor(room, terrain, inferred);
    return true;
  }

  const started = Game.cpu.getUsed();
  const targets = [...sources.map(s => s.pos), controller.pos].map(pos => ({ x: pos.x, y: pos.y }));
  const candidates = rankAnchors(terrain, targets);

  if (candidates.length === 0) {
    log.warn("规划", `${room.name} 地形放不下 bunker`);
    return false;
  }

  const best = candidates[0];
  const anchor = { x: best.x, y: best.y };
  room.memory.anchor = anchor;

  log.info(
    "规划",
    `${room.name} 锚点定在 (${best.x},${best.y})，总路程 ${best.cost}，候选位置 ${candidates.length} 个，耗时 ${(
      Game.cpu.getUsed() - started
    ).toFixed(1)} CPU`
  );
  planOutpostsFor(room, terrain, anchor);
  return true;
}

/** 算出 bunker 之外那几个 container 的落点并存进 Memory */
function planOutpostsFor(room: Room, terrain: TerrainGrid, anchor: Coord): void {
  const controller = room.controller;
  if (!controller) return;

  const sources = room.find(FIND_SOURCES).map(source => ({
    id: source.id as string,
    x: source.pos.x,
    y: source.pos.y
  }));

  const plan = planOutposts(terrain, anchor, sources, { x: controller.pos.x, y: controller.pos.y });
  room.memory.miningSpots = plan.miningSpots;
  room.memory.upgradeSpot = plan.upgradeSpot;
  room.memory.upgradeStations = plan.upgradeStations;

  const mining = Object.values(plan.miningSpots)
    .map(spot => `(${spot.x},${spot.y})`)
    .join(" ");
  const upgrade = plan.upgradeSpot ? `(${plan.upgradeSpot.x},${plan.upgradeSpot.y})` : "无";
  log.info("规划", `${room.name} 采集点 ${mining || "无"}，升级点 ${upgrade}，站位 ${plan.upgradeStations.length} 个`);

  // 路要接到容器和站位上，所以得等上面那些落点定下来才能算
  room.memory.roads = planRoads(room, anchor);
  log.info("规划", `${room.name} 主干道 ${room.memory.roads.length / 2} 格`);
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
    const unlocked = unlockLevel(structure) <= level;

    if (structure.type === "road") {
      drawRoadDot(room, x, y, unlocked);
      continue;
    }

    visual.text(ICON[structure.type] ?? "?", x, y, {
      font: unlocked ? 0.7 : 0.5,
      opacity: unlocked ? 1 : 0.35
    });
  }

  drawRoads(room, level);

  for (const spot of Object.values(room.memory.miningSpots ?? {})) {
    visual.text("⛏", spot.x, spot.y, { font: 0.7 });
  }

  for (const station of room.memory.upgradeStations ?? []) {
    visual.circle(station.x, station.y, { radius: 0.35, fill: "transparent", stroke: "#88ff88", opacity: 0.5 });
  }

  const upgradeSpot = room.memory.upgradeSpot;
  if (upgradeSpot) {
    visual.text("⚡", upgradeSpot.x, upgradeSpot.y, { font: 0.7 });
  }

  visual.text("锚点", anchor.x, anchor.y + 0.3, { font: 0.4, color: "#ffff00" });
}

/**
 * 画主干道。
 *
 * 已经建好的画实心，还没到等级的画暗一点，沼泽段单独描一圈——
 * 那几格造价是平地的五倍，值得一眼看出来有几格踩在沼泽上。
 */
function drawRoads(room: Room, level: number): void {
  if (!room.memory.roads) return;

  const terrain = room.getTerrain();

  for (const cell of decodeCells(room.memory.roads)) {
    const swamp = terrain.get(cell.x, cell.y) === TERRAIN_MASK_SWAMP;
    const unlocked = level >= (swamp ? SWAMP_ROAD_MIN_LEVEL : ROAD_MIN_LEVEL);
    const built = drawRoadDot(room, cell.x, cell.y, unlocked);

    if (swamp && !built) {
      room.visual.circle(cell.x, cell.y, { radius: 0.4, fill: "transparent", stroke: "#6b8f3a", opacity: 0.5 });
    }
  }
}

/**
 * 画一个路点，返回这格是否已经建好。
 *
 * 主干道和 bunker 内部路共用，之前两处各画各的，未建成那档都是 #3a3a3a，
 * 在深色地形上跟没画一样。整体提亮一档并加大半径。
 */
function drawRoadDot(room: Room, x: number, y: number, unlocked: boolean): boolean {
  const built = !!room
    .getPositionAt(x, y)
    ?.lookFor(LOOK_STRUCTURES)
    .some(structure => structure.structureType === "road");

  room.visual.circle(x, y, {
    radius: ROAD_DOT_RADIUS,
    fill: built ? "#dddddd" : unlocked ? "#999999" : "#666666",
    stroke: undefined
  });

  return built;
}

/**
 * 按当前等级把还没建的东西拍成工地。
 *
 * 不是一次性全拍下去：同时开太多工地会让 builder 来回跑，也会把能量摊薄，
 * 所以每次只留最急的那几个。
 *
 * 每轮都重算一遍该建什么，而不是拍完就不管了。位置的优劣会变——比如挡在
 * 上面的旧墙刚被拆掉，那个位置才第一次变得可建——重算才能让它补上队。
 */
function maintainConstructionSites(room: Room): void {
  if (Game.time - (room.memory.lastBuildCheck ?? 0) < BUILD_CHECK_INTERVAL) return;
  room.memory.lastBuildCheck = Game.time;

  const anchor = room.memory.anchor;
  if (!anchor) return;

  clearInheritedWalls(room, anchor);

  const level = room.controller?.level ?? 0;
  const wanted: PlannedSite[] = [...outpostSites(room), ...bunkerSites(anchor, level), ...roadSites(room, level)];
  wanted.sort((a, b) => buildOrder(a) - buildOrder(b));

  const batch = wanted.filter(site => !isBuilt(room, site)).slice(0, MAX_CONSTRUCTION_SITES);

  releaseIdleSites(room, batch);

  for (const site of batch) {
    if (siteAt(room, site)) continue;
    room.createConstructionSite(site.x, site.y, site.type);
  }
}

function bunkerSites(anchor: Coord, level: number): PlannedSite[] {
  return BUNKER_STRUCTURES.filter(structure => unlockLevel(structure) <= level).map(structure => ({
    x: anchor.x + structure.dx,
    y: anchor.y + structure.dy,
    type: structure.type,
    // bunker 内部那两个容器要等 storage 和 link 到位才派得上用场，早期排最后，
    // 免得占着工地名额，把控制器旁边那个真正有用的容器一直挤在队尾
    priority: structure.type === "container" ? BUNKER_CONTAINER_PRIORITY : undefined
  }));
}

/**
 * 撤掉那些排不进当前批次、又还没动工的工地。
 *
 * 工地名额有限，被无关紧要的东西占满时，真正着急的就一直排不上队。
 * 已经投了建造进度的一律不动——撤了那些能量就白花了。
 */
function releaseIdleSites(room: Room, batch: PlannedSite[]): void {
  for (const site of room.find(FIND_MY_CONSTRUCTION_SITES)) {
    if (site.progress > 0) continue;
    if (batch.some(planned => planned.x === site.pos.x && planned.y === site.pos.y)) continue;

    site.remove();
    log.info("规划", `${room.name} 撤掉 (${site.pos.x},${site.pos.y}) 的 ${site.structureType} 工地，先让位给更急的`);
  }
}

/**
 * 拆掉前人留在规划位置上的墙。
 *
 * 房间控制器归自己之后，房间里任何建筑都能直接 destroy，不用派 creep 去啃——
 * dismantle 那套只在别人的房间里才需要。所以几千万血的老墙也是一条指令的事。
 *
 * 只拆压在自己地皮上的那些。destroy 不可逆，而重建一段墙要几十万能量，
 * 圈在外面的旧墙留着就是白捡的防御工事。
 */
function clearInheritedWalls(room: Room, anchor: Coord): void {
  const top = Math.max(anchor.y - BUNKER_RADIUS, 0);
  const left = Math.max(anchor.x - BUNKER_RADIUS, 0);
  const bottom = Math.min(anchor.y + BUNKER_RADIUS, ROOM_EDGE);
  const right = Math.min(anchor.x + BUNKER_RADIUS, ROOM_EDGE);

  const blockers: Structure[] = [];

  for (const found of room.lookForAtArea(LOOK_STRUCTURES, top, left, bottom, right, true)) {
    if (found.structure.structureType !== "constructedWall") continue;
    if (!isBunkerCell(anchor.x, anchor.y, found.x, found.y)) continue;
    blockers.push(found.structure);
  }

  // 外围那几个 container 的落点和升级站位都不在 bunker 地皮里，得单独看一眼。
  // 选址只看得见地形，看不见建筑，所以压在站位上的旧墙得在这里补拆——
  // 不拆的话规划以为有九个站位，实际站得下的只有六个。
  const outposts: Coord[] = [...outpostSites(room), ...(room.memory.upgradeStations ?? [])];
  for (const site of outposts) {
    const position = room.getPositionAt(site.x, site.y);
    const wall = position?.lookFor(LOOK_STRUCTURES).find(s => s.structureType === "constructedWall");
    if (wall) blockers.push(wall);
  }

  if (blockers.length === 0) return;

  let removed = 0;
  for (const blocker of blockers) {
    // 房间里有敌人时拆不了，等下次检查
    if (blocker.destroy() === OK) removed++;
  }

  if (removed > 0) {
    log.info("规划", `${room.name} 拆掉 ${removed} 段压在基地地皮上的旧墙`);
  }
}

interface PlannedSite {
  x: number;
  y: number;
  type: BuildableStructureConstant;
  /** 越小越先建。不填就按建筑类型的默认顺序排 */
  priority?: number;
}

/** bunker 布局表管不到的那几个 container：两个能量源旁边和控制器旁边 */
function outpostSites(room: Room): PlannedSite[] {
  const sites: PlannedSite[] = Object.values(room.memory.miningSpots ?? {}).map(spot => ({
    x: spot.x,
    y: spot.y,
    type: "container" as BuildableStructureConstant,
    priority: MINING_CONTAINER_PRIORITY
  }));

  // 控制器旁的容器省的是升级工的脚程，重要但不紧急，按普通容器排队
  const upgradeSpot = room.memory.upgradeSpot;
  if (upgradeSpot) {
    sites.push({ x: upgradeSpot.x, y: upgradeSpot.y, type: "container" });
  }

  return sites;
}

/**
 * 主干道的工地。
 *
 * 整条路一次性全丢进候选，但它们排在所有建筑之后，实际拍下去的只有
 * 工地名额剩下的那几个，建完一批下一轮再补——不会把名额从 extension 手里抢走。
 */
function roadSites(room: Room, level: number): PlannedSite[] {
  if (level < SWAMP_ROAD_MIN_LEVEL || !room.memory.roads) return [];

  const terrain = room.getTerrain();
  const sites: PlannedSite[] = [];

  for (const cell of decodeCells(room.memory.roads)) {
    const swamp = terrain.get(cell.x, cell.y) === TERRAIN_MASK_SWAMP;
    if (!swamp && level < ROAD_MIN_LEVEL) continue;

    sites.push({
      x: cell.x,
      y: cell.y,
      type: "road",
      priority: swamp ? SWAMP_ROAD_PRIORITY : undefined
    });
  }

  return sites;
}

function buildOrder(site: PlannedSite): number {
  return site.priority ?? BUILD_PRIORITY.indexOf(site.type);
}

/**
 * 一个已经存在的工地该排多靠前，给 builder 挑活用。
 *
 * 和拍工地时用的是同一套顺序。两处必须一致，否则会出现"优先拍下来的工地
 * 没人愿意先建"——排序白排了。
 */
export function constructionOrder(site: ConstructionSite): number {
  const defaultOrder = BUILD_PRIORITY.indexOf(site.structureType);
  if (site.structureType !== "container") return defaultOrder;

  // 三种容器的轻重差得很远：矿边的一建好矿工就能上岗，控制器旁的省升级工的脚程，
  // 而 bunker 内部那两个要等 storage 和 link 到位才有用
  const memory = site.room?.memory;
  const isAt = (spot?: Coord) => spot?.x === site.pos.x && spot?.y === site.pos.y;

  if (Object.values(memory?.miningSpots ?? {}).some(isAt)) return MINING_CONTAINER_PRIORITY;
  if (isAt(memory?.upgradeSpot)) return defaultOrder;

  return BUNKER_CONTAINER_PRIORITY;
}

function isBuilt(room: Room, site: PlannedSite): boolean {
  const position = room.getPositionAt(site.x, site.y);
  if (!position) return true;

  return position.lookFor(LOOK_STRUCTURES).some(structure => structure.structureType === site.type);
}

function siteAt(room: Room, site: PlannedSite): ConstructionSite | undefined {
  const position = room.getPositionAt(site.x, site.y);
  return position?.lookFor(LOOK_CONSTRUCTION_SITES)[0];
}
