/**
 * 本地选房脚本：批量拉取房间地形，算出每个房间最开阔的位置有多大。
 *
 * 跑在 Node 里而不是游戏里，所以不消耗游戏 CPU，也不需要先占领房间——
 * Screeps 的地形和资源分布接口对任意房间都开放。
 *
 * 用法（token 从 screeps.json 读，不会出现在命令行里）：
 *   $env:TS_NODE_PROJECT="tsconfig.test.json"
 *   npx ts-node -r tsconfig-paths/register tools/scan-rooms.ts W10S27 W14S31
 */

import { readFileSync } from "fs";
import { decodeTerrain, distanceTransform, findOpenSpots } from "planner/terrain";

const API = "https://screeps.com/api";
const SHARD = "shard3";

type RoomKind = "普通" | "高速路" | "SK房" | "中心房";

interface RoomReport {
  name: string;
  kind: RoomKind;
  sources: number;
  mineral: string;
  clearance: number;
  spot: string;
  controller: string;
}

function loadToken(): string {
  const config = JSON.parse(readFileSync("screeps.json", "utf8"));
  return config.main.token;
}

/** W12S29 -> { x: 12, y: 29 } */
function parseRoomName(name: string): { x: number; y: number } {
  const match = /^[WE](\d+)[NS](\d+)$/.exec(name);
  if (!match) throw new Error(`房间名格式不对: ${name}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

/**
 * 判断房间类型。坐标是 10 的倍数的是高速路，没有 controller 不能占领；
 * 每个 10x10 扇区中间的 9 个房间是 SK 房和中心房，有 Source Keeper 看守，不适合当主基地。
 */
function classify(name: string): RoomKind {
  const { x, y } = parseRoomName(name);
  const mx = x % 10;
  const my = y % 10;

  if (mx === 0 || my === 0) return "高速路";
  if (mx >= 4 && mx <= 6 && my >= 4 && my <= 6) {
    return mx === 5 && my === 5 ? "中心房" : "SK房";
  }
  return "普通";
}

async function get(path: string, token: string): Promise<any> {
  const response = await fetch(`${API}${path}`, { headers: { "X-Token": token } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function inspectRoom(name: string, token: string): Promise<RoomReport> {
  const kind = classify(name);

  const terrainResponse = await get(`/game/room-terrain?room=${name}&shard=${SHARD}&encoded=1`, token);
  const terrain = decodeTerrain(terrainResponse.terrain[0].terrain);
  const best = findOpenSpots(distanceTransform(terrain), 1)[0];

  const objectsResponse = await get(`/game/room-objects?room=${name}&shard=${SHARD}`, token);
  const objects: any[] = objectsResponse.objects ?? [];
  const sources = objects.filter(o => o.type === "source");
  const controller = objects.find(o => o.type === "controller");
  const mineral = objects.find(o => o.type === "mineral");

  return {
    name,
    kind,
    sources: sources.length,
    mineral: mineral ? mineral.mineralType : "-",
    clearance: best ? best.clearance : 0,
    spot: best ? `${best.x},${best.y}` : "-",
    controller: controller ? `${controller.x},${controller.y}` : "-"
  };
}

/** 生成两个角坐标之间的所有房间名 */
function roomsInRange(from: string, to: string): string[] {
  const a = parseRoomName(from);
  const b = parseRoomName(to);
  const prefix = /^([WE])\d+([NS])\d+$/.exec(from);
  if (!prefix) throw new Error(`房间名格式不对: ${from}`);

  const names: string[] = [];
  for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) {
    for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) {
      names.push(`${prefix[1]}${x}${prefix[2]}${y}`);
    }
  }
  return names;
}

async function main(): Promise<void> {
  const [from, to] = process.argv.slice(2);
  if (!from) {
    console.log("用法: ts-node tools/scan-rooms.ts <起始房间> [结束房间]");
    return;
  }

  const token = loadToken();
  const names = to ? roomsInRange(from, to) : [from];
  console.log(`扫描 ${names.length} 个房间...\n`);

  const reports: RoomReport[] = [];
  for (const name of names) {
    try {
      reports.push(await inspectRoom(name, token));
    } catch (error) {
      console.log(`  ${name} 失败: ${(error as Error).message}`);
    }
    // 别把官方 API 打太狠
    await new Promise(resolve => setTimeout(resolve, 120));
  }

  const usable = reports.filter(r => r.kind === "普通" && r.sources === 2);
  usable.sort((a, b) => b.clearance - a.clearance);

  console.log("房间     类型    源  矿   开阔度  最开阔点  controller");
  for (const r of reports.sort((a, b) => b.clearance - a.clearance)) {
    const size = r.clearance * 2 - 1;
    console.log(
      `${r.name.padEnd(8)} ${r.kind.padEnd(5)} ${r.sources}   ${r.mineral.padEnd(4)} ` +
        `${String(r.clearance).padStart(2)} (${size}x${size})  ${r.spot.padEnd(8)} ${r.controller}`
    );
  }

  console.log(`\n双源普通房 ${usable.length} 个，开阔度分布：`);
  const buckets = new Map<number, number>();
  for (const r of usable) buckets.set(r.clearance, (buckets.get(r.clearance) ?? 0) + 1);
  for (const [clearance, count] of [...buckets.entries()].sort((a, b) => b[0] - a[0])) {
    console.log(`  能放下 ${clearance * 2 - 1}x${clearance * 2 - 1}: ${count} 个房间`);
  }
}

void main();
