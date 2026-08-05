/**
 * 把房间地形连同 bunker 的最佳摆放位置画成 ASCII 图。
 *
 * 用法：
 *   $env:TS_NODE_PROJECT="tsconfig.test.json"
 *   npx ts-node -r tsconfig-paths/register tools/show-room.ts W32S23
 */

import { BUNKER_STRUCTURES, FIRST_SPAWN_OFFSET } from "planner/bunkerLayout";
import { ROOM_SIZE, TERRAIN_SWAMP, TERRAIN_WALL, decodeTerrain } from "planner/terrain";
import { rankAnchors } from "planner/bunkerPlanner";
import { fetchObjects, fetchTerrain } from "./api";

/** 小写是规划出来的建筑，大写是房间自带的资源 */
const SYMBOL: Record<string, string> = {
  spawn: "s",
  extension: "e",
  tower: "t",
  storage: "g",
  terminal: "m",
  lab: "l",
  link: "k",
  nuker: "n",
  powerSpawn: "p",
  observer: "o",
  container: "c",
  road: "."
};

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) {
    console.log("用法: ts-node tools/show-room.ts <房间名>");
    return;
  }

  const terrain = decodeTerrain(await fetchTerrain(name));
  const objects = await fetchObjects(name);

  const sources = objects.filter(o => o.type === "source");
  const controller = objects.find(o => o.type === "controller");
  const mineral = objects.find(o => o.type === "mineral");

  const marks = new Map<number, string>();
  for (const source of sources) marks.set(source.y * ROOM_SIZE + source.x, "E");
  if (controller) marks.set(controller.y * ROOM_SIZE + controller.x, "C");
  if (mineral) marks.set(mineral.y * ROOM_SIZE + mineral.x, "M");

  if (!controller) {
    console.log(`${name} 没有控制器，不能占领`);
    return;
  }

  const targets = [...sources, controller].map(o => ({ x: o.x, y: o.y }));
  const ranked = rankAnchors(terrain, targets);

  if (ranked.length === 0) {
    console.log(`${name} 放不下 bunker`);
    return;
  }

  const best = ranked[0];
  const plan = new Map<number, string>();
  for (const structure of BUNKER_STRUCTURES) {
    const x = best.x + structure.dx;
    const y = best.y + structure.dy;
    plan.set(y * ROOM_SIZE + x, SYMBOL[structure.type] ?? "?");
  }

  const spawnX = best.x + FIRST_SPAWN_OFFSET.dx;
  const spawnY = best.y + FIRST_SPAWN_OFFSET.dy;

  console.log(`\n${name}`);
  console.log(`  锚点 (${best.x},${best.y})   第一个 spawn 放在 (${spawnX},${spawnY})   可选锚点 ${ranked.length} 个`);
  console.log(`\n  前几名位置的取舍（成本 = 步数 + 路上沼泽 + bunker沼泽/4）：`);
  console.log(`    锚点      成本  步数 到各点     路上沼泽 bunker沼泽`);
  for (const c of ranked.slice(0, 5)) {
    const mark = c === best ? "→" : " ";
    console.log(
      `  ${mark} (${String(c.x).padStart(2)},${String(c.y).padStart(2)})  ${c.cost.toFixed(1).padStart(6)} ` +
        `${String(c.steps).padStart(4)}  ${c.distances.join("/").padEnd(10)} ` +
        `${c.swampOnPath.toFixed(0).padStart(6)}   ${String(c.swampCells).padStart(6)}`
    );
  }
  console.log(`\n  # 墙   , 沼泽   E 能量源   C 控制器   M 矿`);
  console.log(`  s出生 e扩展 t塔 g仓库 m终端 l实验室 k链接 n核弹 p能量塔 o观察 c容器 .路\n`);

  let header = "     ";
  for (let x = 0; x < ROOM_SIZE; x++) header += x % 10;
  console.log(header);

  for (let y = 0; y < ROOM_SIZE; y++) {
    let line = `${String(y).padStart(3)}  `;
    for (let x = 0; x < ROOM_SIZE; x++) {
      const i = y * ROOM_SIZE + x;
      if (marks.has(i)) line += marks.get(i);
      else if (plan.has(i)) line += plan.get(i);
      else if (terrain[i] === TERRAIN_WALL) line += "#";
      else if (terrain[i] === TERRAIN_SWAMP) line += ",";
      else line += " ";
    }
    console.log(line);
  }
}

void main();
