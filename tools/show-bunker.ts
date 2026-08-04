/**
 * 把 bunker 布局画成 ASCII 图，确认某一级该长什么样。
 *
 * 用法：
 *   $env:TS_NODE_PROJECT="tsconfig.test.json"
 *   npx ts-node -r tsconfig-paths/register tools/show-bunker.ts 8
 */

import { BUNKER_STRUCTURES, FIRST_SPAWN_OFFSET } from "planner/bunkerLayout";
import { structuresForLevel } from "planner/bunkerPlanner";

const SYMBOL: Record<string, string> = {
  spawn: "S",
  extension: "e",
  tower: "T",
  storage: "G",
  terminal: "M",
  lab: "L",
  link: "K",
  nuker: "N",
  powerSpawn: "P",
  observer: "O",
  container: "C",
  road: "."
};

const LABEL: Record<string, string> = {
  spawn: "S 出生点",
  extension: "e 扩展",
  tower: "T 防御塔",
  storage: "G 仓库",
  terminal: "M 终端",
  lab: "L 实验室",
  link: "K 链接",
  nuker: "N 核弹",
  powerSpawn: "P 能量塔",
  observer: "O 观察者",
  container: "C 容器",
  road: ". 道路"
};

function render(level: number): void {
  const structures = structuresForLevel(level);
  const grid = new Map<string, string>();
  const counts: Record<string, number> = {};

  // 道路先画，建筑覆盖在上面
  const sorted = [...structures].sort((a, b) => (a.type === "road" ? -1 : b.type === "road" ? 1 : 0));
  for (const structure of sorted) {
    grid.set(`${structure.dx},${structure.dy}`, SYMBOL[structure.type] ?? "?");
    counts[structure.type] = (counts[structure.type] ?? 0) + 1;
  }

  const bound = Math.max(...BUNKER_STRUCTURES.map(s => Math.max(Math.abs(s.dx), Math.abs(s.dy))));

  console.log(`\nbunker RCL${level}   占地 ${bound * 2 + 1}x${bound * 2 + 1}   + 是锚点\n`);

  for (let dy = -bound; dy <= bound; dy++) {
    let line = "  ";
    for (let dx = -bound; dx <= bound; dx++) {
      const here = grid.get(`${dx},${dy}`);
      if (here) line += here + " ";
      else if (dx === 0 && dy === 0) line += "+ ";
      else line += "  ";
    }
    console.log(line);
  }

  console.log("\n建筑统计：");
  let total = 0;
  for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    if (type !== "road") total += count;
    console.log(`  ${LABEL[type].padEnd(10)} ${count}`);
  }
  console.log(`  ${"建筑合计".padEnd(9)} ${total}（不含道路）`);
  console.log(`\n第一个 spawn 在锚点偏移 (${FIRST_SPAWN_OFFSET.dx}, ${FIRST_SPAWN_OFFSET.dy})`);
}

render(Number(process.argv[2] ?? 8));
