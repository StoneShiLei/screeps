/**
 * 从 Overmind 仓库拉取 bunker 布局，转换成本项目用的扁平格式，
 * 生成 src/planner/bunkerLayout.ts。
 *
 * Overmind 原始数据是"每个 RCL 一份完整快照"，冗余且不好用。
 * 这里压成一条条 { 相对坐标, 建筑类型, 最低 RCL } 的记录，
 * 游戏里升级时按 rcl 过滤一遍就是该拍的工地。
 *
 * 用法：
 *   $env:TS_NODE_PROJECT="tsconfig.test.json"
 *   npx ts-node -r tsconfig-paths/register tools/import-bunker.ts
 */

import { writeFileSync } from "fs";

const SOURCE_URL = "https://raw.githubusercontent.com/bencbartlett/Overmind/master/src/roomPlanner/layouts/bunker.ts";

interface RawLevel {
  buildings?: Record<string, { pos: { x: number; y: number }[] }>;
}

/** 从 TS 源码里抠出 bunkerLayout 对象并转成 JSON 可解析的形式 */
function extractLayout(source: string): Record<string, RawLevel> & { data: { anchor: { x: number; y: number } } } {
  const marker = "export const bunkerLayout: StructureLayout = ";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error("没找到 bunkerLayout 定义，Overmind 的源码结构可能变了");

  let depth = 0;
  let end = -1;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error("bunkerLayout 的大括号没有闭合");

  // 源码是 TS 对象字面量：单引号字符串，键有的裸写（data、anchor、数字等级）
  const body = source
    .slice(source.indexOf("{", start), end)
    .replace(/'/g, '"')
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*|\d+)\s*:/g, '$1"$2":');

  return JSON.parse(body);
}

interface Entry {
  type: string;
  rcl: number;
}

async function main(): Promise<void> {
  const source = await (await fetch(SOURCE_URL)).text();
  const layout = extractLayout(source);
  const anchor = layout.data.anchor;

  // 每个坐标在各等级分别是什么建筑
  const history = new Map<string, Entry[]>();

  for (let rcl = 1; rcl <= 8; rcl++) {
    const buildings = layout[String(rcl)]?.buildings;
    if (!buildings) continue;

    for (const [type, group] of Object.entries(buildings)) {
      for (const pos of group.pos) {
        const key = `${pos.x},${pos.y}`;
        const entries = history.get(key) ?? [];
        entries.push({ type, rcl });
        history.set(key, entries);
      }
    }
  }

  // 取每格的最终类型，以及它以该类型首次出现的等级
  const records: { dx: number; dy: number; type: string; rcl: number }[] = [];

  for (const [key, entries] of history) {
    const [x, y] = key.split(",").map(Number);
    const finalType = entries[entries.length - 1].type;
    const firstRcl = Math.min(...entries.filter(e => e.type === finalType).map(e => e.rcl));
    records.push({ dx: x - anchor.x, dy: y - anchor.y, type: finalType, rcl: firstRcl });
  }

  records.sort((a, b) => a.rcl - b.rcl || a.type.localeCompare(b.type) || a.dy - b.dy || a.dx - b.dx);

  const byType = new Map<string, number>();
  for (const r of records) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);

  const lines = records.map(r => `  { type: "${r.type}", dx: ${r.dx}, dy: ${r.dy}, rcl: ${r.rcl} }`);

  const output = `/**
 * bunker 布局数据，由 tools/import-bunker.ts 从 Overmind 自动生成，不要手改。
 * 来源：${SOURCE_URL}
 *
 * 坐标是相对锚点的偏移。锚点是 bunker 的正中心，第一个 spawn 落在锚点右侧 4 格。
 * rcl 字段表示这个位置最早在几级可以建，升级时按它过滤就是当次要拍的工地。
 */

export interface BunkerStructure {
  type: BuildableStructureConstant;
  dx: number;
  dy: number;
  rcl: number;
}

/** bunker 整体占 ${records.length} 格 */
export const BUNKER_STRUCTURES: BunkerStructure[] = [
${lines.join(",\n")}
];

/** 第一个 spawn 相对锚点的位置，respawn 放 spawn 时要对准这里 */
export const FIRST_SPAWN_OFFSET = { dx: ${records.find(r => r.type === "spawn" && r.rcl === 1)?.dx ?? 0}, dy: ${
    records.find(r => r.type === "spawn" && r.rcl === 1)?.dy ?? 0
  } };
`;

  writeFileSync("src/planner/bunkerLayout.ts", output, "utf8");

  console.log(`已生成 src/planner/bunkerLayout.ts，共 ${records.length} 格\n`);
  for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(12)} ${count}`);
  }

  console.log("\n各等级新增格数：");
  for (let rcl = 1; rcl <= 8; rcl++) {
    const count = records.filter(r => r.rcl === rcl).length;
    if (count) console.log(`  RCL${rcl}: +${count}`);
  }
}

void main();
