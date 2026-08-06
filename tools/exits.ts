/**
 * 几个房间各有哪几条边能走通，以及通向谁。
 *
 * 被围住的时候这是最要紧的一张表：能走出去的边就那么几条，每条通向谁决定了
 * 分房、外矿、撤退路线的全部可能。
 *
 * 用法：npx ts-node tools/exits.ts E28S36 E28S35 E27S36
 */

import { fetchMapStats, fetchTerrain, fetchUsername } from "./api";
import { decodeTerrain } from "../src/planner/terrain";

const rooms = process.argv.slice(2);
const SIZE = 50;
const WALL = 1;

function parse(name: string): { h: string; x: number; v: string; y: number } {
  const match = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
  if (!match) throw new Error(`房间名格式不对: ${name}`);
  return { h: match[1], x: Number(match[2]), v: match[3], y: Number(match[4]) };
}

function shift(name: string, dx: number, dy: number): string {
  const { h, x, v, y } = parse(name);
  return `${h}${x + dx}${v}${y + dy}`;
}

/** 坐标是 10 的倍数是高速路；扇区中间 9 个房间有 Source Keeper */
function kindOf(name: string): string {
  const { x, y } = parse(name);
  const mx = x % 10;
  const my = y % 10;
  if (mx === 0 || my === 0) return "高速路";
  if (mx >= 4 && mx <= 6 && my >= 4 && my <= 6) return "SK房";
  return "";
}

async function main(): Promise<void> {
  const neighbors = new Set<string>();
  const report: { room: string; lines: string[] }[] = [];

  for (const name of rooms) {
    const grid = decodeTerrain(await fetchTerrain(name));
    const lines: string[] = [];

    const edges: [string, number, number, (i: number) => number][] = [
      ["上", 0, -1, i => i],
      ["下", 0, 1, i => 49 * SIZE + i],
      ["左", -1, 0, i => i * SIZE],
      ["右", 1, 0, i => i * SIZE + 49]
    ];

    for (const [side, dx, dy, indexOf] of edges) {
      let gaps = 0;
      for (let i = 1; i < SIZE - 1; i++) if (grid[indexOf(i)] !== WALL) gaps++;

      const target = shift(name, dx, dy);
      if (gaps === 0) {
        lines.push(`  ${side} 实心岩石，走不通`);
        continue;
      }

      neighbors.add(target);
      lines.push(`  ${side} → ${target}（${gaps} 格出口）`);
    }

    report.push({ room: name, lines });
  }

  const stats = await fetchMapStats([...neighbors]);
  const owners = new Map<string, string>();
  for (const status of Object.values(stats)) if (status.own) owners.set(status.own.user, "");
  for (const id of owners.keys()) owners.set(id, await fetchUsername(id));

  for (const entry of report) {
    console.log(`\n${entry.room}`);
    for (const line of entry.lines) {
      const target = /→ (\S+)（/.exec(line)?.[1];
      console.log(target ? `${line} ${describe(target, stats, owners)}` : line);
    }
  }
}

function describe(
  name: string,
  stats: Record<string, { status?: string; own?: { user: string; level: number } }>,
  owners: Map<string, string>
): string {
  const kind = kindOf(name);
  const own = stats[name]?.own;
  if (!own) return kind ? `【${kind}】` : "【无主】";

  const who = owners.get(own.user) ?? own.user;
  return own.level === 0 ? `【${who} 预定】` : `【${who} RCL${own.level}】`;
}

void main();
