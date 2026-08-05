/**
 * 临时诊断脚本：放大看房间的某一小块，把地形、建筑和血量都摆出来。
 *
 * 用法：npx ts-node tools/peek.ts E28S35 32 10
 */

import { ROOM_SIZE, TERRAIN_WALL, decodeTerrain } from "../src/planner/terrain";
import { fetchObjects, fetchTerrain } from "./api";

const roomName = process.argv[2] ?? "E28S35";
const centerX = Number(process.argv[3] ?? 25);
const centerY = Number(process.argv[4] ?? 25);
const radius = Number(process.argv[5] ?? 8);

const ICONS: Record<string, string> = {
  constructedWall: "#",
  rampart: "R",
  controller: "C",
  creep: "@",
  road: ".",
  container: "c",
  extension: "e",
  spawn: "S",
  tower: "T",
  storage: "G",
  terminal: "N",
  source: "$",
  mineral: "M",
  extractor: "X",
  energy: "*"
};

async function main(): Promise<void> {
  const [terrainString, objects] = await Promise.all([fetchTerrain(roomName), fetchObjects(roomName)]);
  const terrain = decodeTerrain(terrainString);

  const at = new Map<string, { type: string; hits?: number; name?: string }>();
  for (const object of objects) at.set(`${object.x},${object.y}`, object as never);

  let header = "    ";
  for (let x = centerX - radius; x <= centerX + radius; x++) header += String(Math.abs(x) % 10);
  console.log(`\n${roomName} 以 (${centerX},${centerY}) 为中心\n`);
  console.log(header);

  for (let y = centerY - radius; y <= centerY + radius; y++) {
    let row = `${String(y).padStart(3)} `;
    for (let x = centerX - radius; x <= centerX + radius; x++) {
      if (x < 0 || y < 0 || x >= ROOM_SIZE || y >= ROOM_SIZE) {
        row += " ";
        continue;
      }
      const object = at.get(`${x},${y}`);
      row += object ? ICONS[object.type] ?? "?" : terrain[y * ROOM_SIZE + x] === TERRAIN_WALL ? "▓" : "·";
    }
    console.log(row);
  }

  console.log("");
  for (const object of objects) {
    if (object.type !== "constructedWall" && object.type !== "rampart") continue;
    if (Math.abs(object.x - centerX) > radius || Math.abs(object.y - centerY) > radius) continue;

    const hits = (object as { hits?: number }).hits ?? 0;
    console.log(`  ${object.type} (${object.x},${object.y})  ${hits.toLocaleString("en-US")} 血`);
  }
}

void main();
