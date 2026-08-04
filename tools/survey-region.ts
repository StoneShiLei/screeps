/**
 * 大范围普查：只查房间归属不分析地形，用来快速找出还没被占满的区域。
 *
 * 一次 map-stats 能查几百个房间，比逐个拉地形快两个数量级，
 * 所以可以先用它把几千个房间扫一遍，圈定范围后再用 scan-rooms 细看。
 *
 * 用法：
 *   $env:TS_NODE_PROJECT="tsconfig.test.json"
 *   npx ts-node -r tsconfig-paths/register tools/survey-region.ts W 0 59 S 0 59
 */

import { fetchMapStats } from "./api";

/** 坐标是 10 的倍数的是高速路；每个扇区中间 9 个房间由 Source Keeper 看守 */
function isClaimable(x: number, y: number): boolean {
  const mx = x % 10;
  const my = y % 10;
  if (mx === 0 || my === 0) return false;
  return !(mx >= 4 && mx <= 6 && my >= 4 && my <= 6);
}

async function main(): Promise<void> {
  const [horizontal, xFromRaw, xToRaw, vertical, yFromRaw, yToRaw] = process.argv.slice(2);
  if (!horizontal) {
    console.log("用法: ts-node tools/survey-region.ts <W|E> <x起> <x止> <N|S> <y起> <y止>");
    return;
  }

  const xFrom = Number(xFromRaw);
  const xTo = Number(xToRaw);
  const yFrom = Number(yFromRaw);
  const yTo = Number(yToRaw);

  const names: string[] = [];
  for (let x = xFrom; x <= xTo; x++) {
    for (let y = yFrom; y <= yTo; y++) {
      names.push(`${horizontal}${x}${vertical}${y}`);
    }
  }

  console.log(`查询 ${names.length} 个房间...`);
  const stats = await fetchMapStats(names);
  const now = Date.now();

  console.log("\n. 可以去   N 新手区（GCL 4 以上进不去）   o 高速路或 SK 房   数字 已占领房间的 RCL   空白 地图外\n");

  // 表头：x 坐标的十位和个位
  let tens = "     ";
  let ones = "     ";
  for (let x = xFrom; x <= xTo; x++) {
    tens += Math.floor(x / 10) % 10;
    ones += x % 10;
  }
  console.log(tens);
  console.log(ones);

  const sectors = new Map<string, { free: number; novice: number; owned: number }>();

  for (let y = yFrom; y <= yTo; y++) {
    let line = `${vertical}${String(y).padStart(2)}  `;
    for (let x = xFrom; x <= xTo; x++) {
      const info = stats[`${horizontal}${x}${vertical}${y}`];
      const sector = `${Math.floor(x / 10)}-${Math.floor(y / 10)}`;
      const bucket = sectors.get(sector) ?? { free: 0, novice: 0, owned: 0 };

      if (!info || info.status !== "normal") {
        line += " ";
        continue;
      }

      if (info.own) {
        line += Math.min(info.own.level, 9);
        bucket.owned++;
      } else if (!isClaimable(x, y)) {
        line += "o";
      } else if (info.novice && info.novice > now) {
        // 新手区只对 GCL 4 以下开放，对我们等于不存在
        line += "N";
        bucket.novice++;
      } else {
        line += ".";
        bucket.free++;
      }

      sectors.set(sector, bucket);
    }
    console.log(line);
  }

  const ranked = [...sectors.entries()]
    .map(([sector, counts]) => ({ sector, ...counts }))
    .filter(s => s.free >= 5)
    .sort((a, b) => b.free - a.free);

  console.log("\n各扇区实际可去的无主房间数（已排除新手区，扇区编号是 x十位-y十位）：");
  for (const s of ranked.slice(0, 15)) {
    const total = s.free + s.owned;
    const rate = total ? s.owned / total : 0;
    const bar = "#".repeat(Math.round(rate * 20)).padEnd(20, "-");
    const [sx, sy] = s.sector.split("-");
    console.log(
      `  ${horizontal}${sx}0${vertical}${sy}0 一带  ${bar} 占领率 ${(rate * 100).toFixed(0).padStart(3)}%   ` +
        `可去 ${String(s.free).padStart(2)}   已占 ${String(s.owned).padStart(2)}   新手区 ${s.novice}`
    );
  }
}

void main();
