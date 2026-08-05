/**
 * 全图搜索：找出离强邻居最远的无主房间。
 *
 * "区域占领率低"是个有误导性的指标——空房间常常恰好被几个大玩家圈在中间。
 * 真正要紧的是这个房间离最近的 RCL7+ 基地有几格，所以这里直接按那个距离排序。
 *
 * 用法：
 *   $env:TS_NODE_PROJECT="tsconfig.test.json"
 *   npx ts-node -r tsconfig-paths/register tools/find-safe-rooms.ts [取前几名]
 */

import { RoomStatus, fetchMapStatsCached, fetchUsername } from "./api";

/** 视为威胁的等级门槛，RCL7 起有第三座塔和满编攻击部队 */
const THREAT_LEVEL = 7;

const HALF = 60;

interface GlobalCoord {
  gx: number;
  gy: number;
}

/** 房间名转连续坐标，W0 与 E0 相邻，这样能正确跨象限算距离 */
function toGlobal(name: string): GlobalCoord {
  const match = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
  if (!match) throw new Error(`房间名格式不对: ${name}`);

  const x = Number(match[2]);
  const y = Number(match[4]);
  return {
    gx: match[1] === "E" ? x : -x - 1,
    gy: match[3] === "S" ? y : -y - 1
  };
}

function toRoomName({ gx, gy }: GlobalCoord): string {
  const horizontal = gx >= 0 ? `E${gx}` : `W${-gx - 1}`;
  const vertical = gy >= 0 ? `S${gy}` : `N${-gy - 1}`;
  return horizontal + vertical;
}

function isClaimable(name: string): boolean {
  const match = /^[WE](\d+)[NS](\d+)$/.exec(name);
  if (!match) return false;
  const mx = Number(match[1]) % 10;
  const my = Number(match[2]) % 10;
  if (mx === 0 || my === 0) return false;
  return !(mx >= 4 && mx <= 6 && my >= 4 && my <= 6);
}

async function main(): Promise<void> {
  const topN = Number(process.argv[2] ?? 25);

  const allRooms: string[] = [];
  for (let gx = -HALF; gx < HALF; gx++) {
    for (let gy = -HALF; gy < HALF; gy++) {
      allRooms.push(toRoomName({ gx, gy }));
    }
  }

  console.log(`全图 ${allRooms.length} 个房间`);
  const stats = await fetchMapStatsCached(allRooms);
  const now = Date.now();

  // 先把所有威胁点收集起来
  const threats: (GlobalCoord & { room: string; level: number; user: string })[] = [];
  for (const [name, info] of Object.entries(stats)) {
    if (info?.own && info.own.level >= THREAT_LEVEL) {
      threats.push({ ...toGlobal(name), room: name, level: info.own.level, user: info.own.user });
    }
  }

  console.log(`其中 RCL${THREAT_LEVEL} 以上的基地 ${threats.length} 个\n`);

  const candidates: { name: string; distance: number; nearest: string; nearestLevel: number; user: string }[] = [];

  for (const [name, info] of Object.entries(stats)) {
    if (!info || info.status !== "normal" || info.own || !isClaimable(name)) continue;
    // 新手区只对 GCL 4 以下开放
    if (info.novice && info.novice > now) continue;

    const here = toGlobal(name);
    let best = Infinity;
    let nearest = threats[0];

    for (const threat of threats) {
      const distance = Math.max(Math.abs(threat.gx - here.gx), Math.abs(threat.gy - here.gy));
      if (distance < best) {
        best = distance;
        nearest = threat;
        if (best <= 1) break;
      }
    }

    candidates.push({
      name,
      distance: best,
      nearest: nearest.room,
      nearestLevel: nearest.level,
      user: nearest.user
    });
  }

  candidates.sort((a, b) => b.distance - a.distance);

  const distribution = new Map<number, number>();
  for (const c of candidates) distribution.set(c.distance, (distribution.get(c.distance) ?? 0) + 1);

  console.log("离最近强邻居的距离分布：");
  for (const [distance, count] of [...distribution.entries()].sort((a, b) => b[0] - a[0])) {
    console.log(`  ${String(distance).padStart(2)} 格外: ${count} 个房间`);
  }

  console.log(`\n最偏僻的 ${topN} 个无主房间：`);
  console.log("房间      离最近强邻居  最近的是");
  for (const c of candidates.slice(0, topN)) {
    const who = await fetchUsername(c.user);
    console.log(`${c.name.padEnd(9)} ${String(c.distance).padStart(6)} 格     ${c.nearest} RCL${c.nearestLevel} ${who}`);
  }
}

void main();
