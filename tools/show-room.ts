/**
 * 把房间地形和距离变换结果打印成 ASCII 图，用来肉眼核对算法有没有算错。
 *
 * 用法：
 *   $env:TS_NODE_PROJECT="tsconfig.test.json"
 *   npx ts-node -r tsconfig-paths/register tools/show-room.ts W12S29
 */

import { ROOM_SIZE, TERRAIN_SWAMP, TERRAIN_WALL, decodeTerrain, distanceTransform, findOpenSpots } from "planner/terrain";
import { fetchObjects, fetchTerrain } from "./api";

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) {
    console.log("用法: ts-node tools/show-room.ts <房间名>");
    return;
  }

  const terrain = decodeTerrain(await fetchTerrain(name));
  const dt = distanceTransform(terrain);
  const best = findOpenSpots(dt, 1)[0];

  const marks = new Map<number, string>();
  for (const obj of await fetchObjects(name)) {
    if (obj.type === "source") marks.set(obj.y * ROOM_SIZE + obj.x, "S");
    if (obj.type === "controller") marks.set(obj.y * ROOM_SIZE + obj.x, "C");
    if (obj.type === "mineral") marks.set(obj.y * ROOM_SIZE + obj.x, "M");
  }

  console.log(`\n${name}  最开阔点 (${best.x},${best.y}) 开阔度 ${best.clearance}`);
  console.log("# 墙  ~ 沼泽  . 平原  S 能量源  C 控制器  M 矿  X 最开阔点\n");

  for (let y = 0; y < ROOM_SIZE; y++) {
    let line = "";
    for (let x = 0; x < ROOM_SIZE; x++) {
      const i = y * ROOM_SIZE + x;
      if (x === best.x && y === best.y) line += "X";
      else if (marks.has(i)) line += marks.get(i);
      else if (terrain[i] === TERRAIN_WALL) line += "#";
      else if (terrain[i] === TERRAIN_SWAMP) line += "~";
      else line += ".";
    }
    console.log(line);
  }

  console.log("\n距离变换，每格到最近墙的距离，超过 9 显示为 +：\n");
  for (let y = 0; y < ROOM_SIZE; y++) {
    let line = "";
    for (let x = 0; x < ROOM_SIZE; x++) {
      const value = dt[y * ROOM_SIZE + x];
      line += value === 0 ? "#" : value > 9 ? "+" : String(value);
    }
    console.log(line);
  }
}

void main();
