/**
 * 房间里的某个东西够不够得着，够不着的话拆哪几段墙最省。
 *
 * 前人废弃的基地常常把控制器圈在墙里，预定员站在外面干瞪眼。这个脚本把人造墙
 * 当成"能过但要先拆掉"的格子跑一遍 Dijkstra：走空地不花钱，穿墙花的是血量，
 * 所以算出来的最短路径正好就是最省力的爆破方案。
 *
 * 用法：npx ts-node tools/breach-plan.ts E28S35 controller [起点x 起点y]
 * 不给起点就从房间四边出发，也就是允许绕出房间从别的边再进来。
 */

import { ROOM_SIZE, TERRAIN_WALL, decodeTerrain } from "../src/planner/terrain";
import { RoomObject, fetchObjects, fetchTerrain } from "./api";

interface Wall extends RoomObject {
  hits?: number;
}

/** 站不上去的建筑，和游戏里的 OBSTACLE_OBJECT_TYPES 一致 */
const OBSTACLES = new Set([
  "spawn",
  "extension",
  "link",
  "storage",
  "tower",
  "observer",
  "powerSpawn",
  "powerBank",
  "lab",
  "terminal",
  "nuker",
  "factory",
  "invaderCore",
  "controller"
]);

/** 能打穿的东西：走过去得先把它拆了，代价就是血量 */
const BREACHABLE = new Set(["constructedWall", "rampart"]);

const roomName = process.argv[2] ?? "E28S35";
const targetType = process.argv[3] ?? "controller";
const startX = process.argv[4] === undefined ? undefined : Number(process.argv[4]);
const startY = process.argv[5] === undefined ? undefined : Number(process.argv[5]);

/** 够大就行，但必须塞得进 Int32：拿 MAX_SAFE_INTEGER 会被截断成 -1 */
const INFINITY = 1e9;

async function main(): Promise<void> {
  const [terrainString, objects] = await Promise.all([fetchTerrain(roomName), fetchObjects(roomName)]);
  const terrain = decodeTerrain(terrainString);

  const target = objects.find(object => object.type === targetType);
  if (!target) {
    console.log(`${roomName} 里没有 ${targetType}`);
    return;
  }

  const { cost, blocked } = buildGrid(terrain, objects);

  const fromEdges = startX === undefined || startY === undefined;
  const starts = fromEdges ? entryTiles(cost, blocked) : [startY * ROOM_SIZE + startX];
  console.log(`\n${roomName} 的 ${targetType} 在 (${target.x},${target.y})`);
  console.log(fromEdges ? `出发点：房间四边共 ${starts.length} 格可站\n` : `出发点：(${startX},${startY})\n`);

  const { distance, from } = dijkstra(cost, blocked, starts);

  const spots = reachableSpots(distance, blocked, target);
  if (spots.length === 0) {
    console.log("  它周围一格全是岩石或建筑，谁都站不上去——这个目标碰不到，和墙没关系");
    return;
  }

  const spot = spots[0];
  const route = tracePath(from, spot);

  if (spot.cost === 0) {
    console.log(`  路是通的：走到 (${spot.x},${spot.y}) 要 ${route.length - 1} 步，一段墙都不用拆`);
    console.log(`  路线 ${route.map(step => `${step.x},${step.y}`).join(" → ")}`);
    return;
  }

  if (spot.cost >= INFINITY) {
    console.log("  连拆墙都到不了：目标那一带被岩石彻底隔开，只能从别的房间绕进来");
    return;
  }

  console.log(`  最省的落脚点 (${spot.x},${spot.y})，要打穿 ${fmt(spot.cost)} 血，走 ${route.length - 1} 步`);

  const walls = pathWalls(from, cost, spot);
  console.log(`  拦路的墙 ${walls.length} 段：`);
  for (const wall of walls) console.log(`    (${wall.x},${wall.y})  ${fmt(wall.hits)} 血`);

  report(walls);
}

/** 每格的通行代价：0 是随便走，正数是要先拆掉的血量，blocked 是压根过不去 */
function buildGrid(terrain: Uint8Array, objects: RoomObject[]): { cost: Int32Array; blocked: Uint8Array } {
  const cost = new Int32Array(ROOM_SIZE * ROOM_SIZE);
  const blocked = new Uint8Array(ROOM_SIZE * ROOM_SIZE);

  for (let i = 0; i < terrain.length; i++) {
    if (terrain[i] === TERRAIN_WALL) blocked[i] = 1;
  }

  for (const object of objects) {
    const index = object.y * ROOM_SIZE + object.x;

    if (BREACHABLE.has(object.type)) {
      cost[index] = Math.max(cost[index], (object as Wall).hits ?? 1);
      continue;
    }
    if (OBSTACLES.has(object.type)) blocked[index] = 1;
  }

  return { cost, blocked };
}

/** 房间四边上能站的格子，creep 就是从这些地方进来的 */
function entryTiles(cost: Int32Array, blocked: Uint8Array): number[] {
  const tiles: number[] = [];

  for (let i = 0; i < ROOM_SIZE; i++) {
    for (const index of [i, (ROOM_SIZE - 1) * ROOM_SIZE + i, i * ROOM_SIZE, i * ROOM_SIZE + ROOM_SIZE - 1]) {
      if (!blocked[index] && cost[index] === 0 && !tiles.includes(index)) tiles.push(index);
    }
  }

  return tiles;
}

/**
 * 从起点到每一格要打穿多少血量。
 *
 * 权重是"踩上这格要先拆掉的血量"，岩石一律不通——岩石是拆不掉的，
 * 把它当成高价格子会得出一条根本走不了的路线。
 */
function dijkstra(
  cost: Int32Array,
  blocked: Uint8Array,
  starts: number[]
): { distance: Int32Array; from: Int32Array } {
  const distance = new Int32Array(ROOM_SIZE * ROOM_SIZE).fill(INFINITY);
  const from = new Int32Array(ROOM_SIZE * ROOM_SIZE).fill(-1);
  const queue: number[] = [];

  for (const start of starts) {
    if (blocked[start]) continue;
    distance[start] = cost[start];
    queue.push(start);
  }

  while (queue.length > 0) {
    // 房间只有 2500 格，线性找最小值也就几百万次比较，脚本跑一次无所谓
    let pick = 0;
    for (let i = 1; i < queue.length; i++) {
      if (distance[queue[i]] < distance[queue[pick]]) pick = i;
    }
    const current = queue.splice(pick, 1)[0];

    const x = current % ROOM_SIZE;
    const y = Math.floor(current / ROOM_SIZE);

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;

        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= ROOM_SIZE || ny >= ROOM_SIZE) continue;

        const next = ny * ROOM_SIZE + nx;
        if (blocked[next]) continue;

        const candidate = distance[current] + cost[next];
        if (candidate >= distance[next]) continue;

        distance[next] = candidate;
        from[next] = current;
        queue.push(next);
      }
    }
  }

  return { distance, from };
}

/** 目标周围能站的格子，按要打穿的血量排序 */
function reachableSpots(
  distance: Int32Array,
  blocked: Uint8Array,
  target: RoomObject
): { x: number; y: number; cost: number }[] {
  const spots: { x: number; y: number; cost: number }[] = [];

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = target.x + dx;
      const y = target.y + dy;
      if (x < 0 || y < 0 || x >= ROOM_SIZE || y >= ROOM_SIZE) continue;

      const index = y * ROOM_SIZE + x;
      if (blocked[index]) continue;

      spots.push({ x, y, cost: distance[index] });
    }
  }

  return spots.sort((a, b) => a.cost - b.cost);
}

/** 回溯整条路线 */
function tracePath(from: Int32Array, spot: { x: number; y: number }): { x: number; y: number }[] {
  const steps: { x: number; y: number }[] = [];

  let current = spot.y * ROOM_SIZE + spot.x;
  while (current !== -1) {
    steps.push({ x: current % ROOM_SIZE, y: Math.floor(current / ROOM_SIZE) });
    current = from[current];
  }

  return steps.reverse();
}

/** 回溯路径，把踩过的墙挑出来 */
function pathWalls(
  from: Int32Array,
  cost: Int32Array,
  spot: { x: number; y: number }
): { x: number; y: number; hits: number }[] {
  const walls: { x: number; y: number; hits: number }[] = [];

  let current = spot.y * ROOM_SIZE + spot.x;
  while (current !== -1) {
    if (cost[current] > 0) {
      walls.push({ x: current % ROOM_SIZE, y: Math.floor(current / ROOM_SIZE), hits: cost[current] });
    }
    current = from[current];
  }

  return walls.reverse();
}

function report(walls: { hits: number }[]): void {
  const total = walls.reduce((sum, wall) => sum + wall.hits, 0);

  console.log("\n  拆迁工要干多久：");
  for (const work of [5, 10, 20]) {
    // 一个 WORK 每 tick 拆 50 点血
    const ticks = Math.ceil(total / (work * 50));
    console.log(`    ${String(work).padStart(2)} 个 WORK：${fmt(ticks)} tick（${(ticks / 1500).toFixed(1)} 条命）`);
  }
}

function fmt(value: number): string {
  return value.toLocaleString("en-US");
}

void main();
