/**
 * 现役人员名单：名字里带着孵化时的 tick，一眼能看出最近在造什么。
 *
 * 用法：npx ts-node tools/roster.ts E28S36
 */

import { SHARD, apiGet, fetchObjects } from "./api";

const roomName = process.argv[2] ?? "E28S36";

interface CreepObject {
  type: string;
  name?: string;
  x: number;
  y: number;
  body?: { type: string }[];
  store?: Record<string, number>;
  energy?: number;
  energyCapacity?: number;
  structureType?: string;
}

async function main(): Promise<void> {
  const [objects, time] = await Promise.all([
    fetchObjects(roomName) as Promise<CreepObject[]>,
    apiGet<{ time: number }>(`/game/time?shard=${SHARD}`)
  ]);

  console.log(`\n${roomName} 当前 tick ${time.time}\n`);

  const creeps = objects.filter(object => object.type === "creep" && object.name);
  const rows = creeps
    .map(creep => {
      const born = Number(creep.name?.split("_")[1] ?? 0);
      return { creep, born };
    })
    .sort((a, b) => b.born - a.born);

  console.log("现役（按孵化时间倒序）：");
  for (const { creep, born } of rows) {
    const parts = (creep.body ?? []).map(part => part.type[0]).join("");
    console.log(`  ${(creep.name ?? "").padEnd(24)} 出生于 ${born}（${time.time - born} tick 前）  ${parts}`);
  }

  let energy = 0;
  let capacity = 0;
  for (const object of objects) {
    if (object.type !== "spawn" && object.type !== "extension") continue;

    energy += object.store?.energy ?? object.energy ?? 0;
    capacity += object.energyCapacity ?? (object.type === "spawn" ? 300 : 50);
  }
  console.log(`\nspawn + extension 能量 ${energy}/${capacity}`);

  const sites = objects.filter(object => object.type === "constructionSite");
  console.log(`工地 ${sites.length} 个`);
}

void main();
