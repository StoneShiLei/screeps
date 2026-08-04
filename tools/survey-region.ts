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

  console.log("\n. 无主可占领   o 无主但不可占领   数字 已占领房间的 RCL   空白 地图外\n");

  // 表头：x 坐标的十位和个位
  let tens = "     ";
  let ones = "     ";
  for (let x = xFrom; x <= xTo; x++) {
    tens += Math.floor(x / 10) % 10;
    ones += x % 10;
  }
  console.log(tens);
  console.log(ones);

  const sectorFree = new Map<string, { free: number; owned: number }>();

  for (let y = yFrom; y <= yTo; y++) {
    let line = `${vertical}${String(y).padStart(2)}  `;
    for (let x = xFrom; x <= xTo; x++) {
      const info = stats[`${horizontal}${x}${vertical}${y}`];
      const sector = `${Math.floor(x / 10)}-${Math.floor(y / 10)}`;
      const bucket = sectorFree.get(sector) ?? { free: 0, owned: 0 };

      if (!info || info.status !== "normal") {
        line += " ";
      } else if (info.own) {
        line += Math.min(info.own.level, 9);
        bucket.owned++;
        sectorFree.set(sector, bucket);
      } else if (isClaimable(x, y)) {
        line += ".";
        bucket.free++;
        sectorFree.set(sector, bucket);
      } else {
        line += "o";
      }
    }
    console.log(line);
  }

  const ranked = [...sectorFree.entries()]
    .map(([sector, counts]) => ({ sector, ...counts, rate: counts.owned / (counts.free + counts.owned) }))
    .filter(s => s.free + s.owned >= 10)
    .sort((a, b) => a.rate - b.rate);

  console.log("\n各扇区占领率（越低越空，扇区编号是 x十位-y十位）：");
  for (const s of ranked.slice(0, 12)) {
    const bar = "#".repeat(Math.round(s.rate * 20)).padEnd(20, "-");
    console.log(
      `  ${horizontal}${s.sector.split("-")[0]}0${vertical}${s.sector.split("-")[1]}0 一带  ` +
        `${bar} ${(s.rate * 100).toFixed(0).padStart(3)}%   无主 ${String(s.free).padStart(2)} / 已占 ${s.owned}`
    );
  }
}

void main();
