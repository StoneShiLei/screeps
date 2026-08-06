/**
 * 几个房间的归属原始数据，连新手区和 respawn 区的时间戳一起摆出来。
 *
 * 分房之前要确认的就是这些：谁在旁边、有没有保护区限制。
 *
 * 用法：npx ts-node tools/room-status.ts E29S36 E28S34
 */

import { fetchMapStats, fetchUsername } from "./api";

const rooms = process.argv.slice(2);

async function main(): Promise<void> {
  if (rooms.length === 0) {
    console.log("用法：npx ts-node tools/room-status.ts <房间名> ...");
    return;
  }

  const stats = await fetchMapStats(rooms);
  const now = Date.now();

  for (const name of rooms) {
    const status = stats[name];
    if (!status) {
      console.log(`${name} 查不到`);
      continue;
    }

    const owner = status.own ? await fetchUsername(status.own.user) : undefined;
    const parts = [`status=${status.status ?? "?"}`];

    if (status.own) {
      // level 0 是预定，不是占领
      parts.push(status.own.level === 0 ? `被 ${owner} 预定` : `${owner} 的房间 RCL${status.own.level}`);
    } else {
      parts.push("无主");
    }

    if (status.novice) parts.push(status.novice > now ? `新手区还剩 ${hours(status.novice - now)}` : "新手区已过期");
    if (status.respawnArea) {
      parts.push(status.respawnArea > now ? `respawn 区还剩 ${hours(status.respawnArea - now)}` : "respawn 区已过期");
    }

    console.log(`${name.padEnd(8)} ${parts.join("，")}`);
  }
}

function hours(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)} 小时`;
}

void main();
