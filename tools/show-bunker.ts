/**
 * 把 Overmind 的 bunker 布局画成 ASCII 图，用来评估要不要采用它。
 *
 * 数据来自 bencbartlett/Overmind 的 src/roomPlanner/layouts/bunker.ts，
 * 锚点在 (25,25)，整体占 13x13（x 和 y 都是 19..31）。
 *
 * 用法：
 *   $env:TS_NODE_PROJECT="tsconfig.test.json"
 *   npx ts-node -r tsconfig-paths/register tools/show-bunker.ts [rcl]
 */

type Coords = [number, number][];

export const ANCHOR = { x: 25, y: 25 };

/** 每级新解锁后该级的完整建筑清单（不是增量） */
export const BUNKER: Record<number, Partial<Record<string, Coords>>> = {
  2: {
    spawn: [[29, 25]],
    extension: [
      [28, 26],
      [28, 27],
      [27, 27],
      [27, 28],
      [29, 26]
    ],
    container: [[27, 30]]
  },
  4: {
    spawn: [[29, 25]],
    storage: [[24, 25]],
    tower: [[25, 26]],
    extension: [
      [30, 24],
      [30, 25],
      [30, 26],
      [28, 26],
      [29, 27],
      [28, 27],
      [27, 27],
      [27, 28],
      [28, 28],
      [29, 28],
      [28, 29],
      [27, 29],
      [26, 28],
      [24, 30],
      [25, 30],
      [26, 30],
      [29, 26],
      [24, 29],
      [30, 27],
      [25, 29]
    ],
    container: [[27, 30]],
    road: [
      [24, 23],
      [25, 22],
      [26, 23],
      [27, 24],
      [28, 25],
      [27, 26],
      [26, 27],
      [25, 28],
      [24, 27],
      [23, 26],
      [22, 25],
      [23, 24],
      [24, 21],
      [26, 29],
      [31, 23],
      [31, 24],
      [31, 25],
      [31, 26],
      [31, 27],
      [19, 23],
      [19, 24],
      [19, 25],
      [19, 26],
      [19, 27],
      [23, 19],
      [24, 19],
      [25, 19],
      [26, 19],
      [27, 19],
      [23, 31],
      [24, 31],
      [25, 31],
      [26, 31],
      [27, 31],
      [21, 21],
      [29, 21],
      [21, 29],
      [29, 29],
      [23, 25],
      [27, 25],
      [29, 24],
      [21, 26],
      [30, 23],
      [20, 27],
      [23, 20],
      [22, 20],
      [20, 22],
      [30, 22],
      [28, 20],
      [20, 28],
      [22, 30],
      [28, 30],
      [30, 28],
      [23, 29],
      [24, 28]
    ]
  },
  8: {
    spawn: [
      [29, 25],
      [26, 24],
      [25, 21]
    ],
    storage: [[24, 25]],
    terminal: [[26, 25]],
    nuker: [[24, 24]],
    powerSpawn: [[24, 26]],
    observer: [[21, 25]],
    link: [[26, 26]],
    tower: [
      [27, 25],
      [23, 25],
      [25, 27],
      [25, 23],
      [25, 24],
      [25, 26]
    ],
    lab: [
      [26, 22],
      [27, 23],
      [28, 24],
      [27, 22],
      [27, 21],
      [28, 22],
      [28, 23],
      [29, 23],
      [28, 21],
      [29, 22]
    ],
    container: [
      [27, 30],
      [23, 20]
    ],
    extension: [
      [24, 22],
      [23, 23],
      [22, 24],
      [22, 23],
      [23, 22],
      [23, 21],
      [22, 22],
      [21, 23],
      [24, 20],
      [25, 20],
      [26, 20],
      [30, 24],
      [30, 25],
      [30, 26],
      [20, 24],
      [20, 25],
      [20, 26],
      [22, 21],
      [21, 22],
      [28, 26],
      [29, 27],
      [28, 27],
      [27, 27],
      [27, 28],
      [28, 28],
      [29, 28],
      [28, 29],
      [27, 29],
      [26, 28],
      [22, 26],
      [23, 27],
      [24, 28],
      [23, 28],
      [22, 27],
      [21, 27],
      [22, 28],
      [23, 29],
      [22, 29],
      [21, 28],
      [24, 30],
      [25, 30],
      [26, 30],
      [29, 26],
      [21, 24],
      [26, 21],
      [24, 29],
      [23, 30],
      [20, 23],
      [27, 20],
      [30, 27],
      [25, 29]
    ],
    road: [
      [24, 23],
      [25, 22],
      [26, 23],
      [27, 24],
      [28, 25],
      [27, 26],
      [26, 27],
      [25, 28],
      [24, 27],
      [23, 26],
      [22, 25],
      [23, 24],
      [28, 20],
      [30, 22],
      [24, 21],
      [30, 28],
      [28, 30],
      [26, 29],
      [20, 22],
      [22, 20],
      [20, 28],
      [22, 30],
      [24, 19],
      [26, 19],
      [27, 19],
      [31, 23],
      [31, 24],
      [31, 25],
      [31, 26],
      [31, 27],
      [27, 31],
      [26, 31],
      [24, 31],
      [23, 31],
      [19, 27],
      [19, 26],
      [19, 25],
      [19, 24],
      [25, 19],
      [19, 23],
      [25, 31],
      [23, 19],
      [29, 21],
      [21, 21],
      [21, 29],
      [29, 29],
      [21, 26],
      [29, 24],
      [30, 23],
      [20, 27]
    ]
  }
};

/** 渲染用的单字符符号，road 用点，空白表示这格不属于 bunker */
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

function render(rcl: number): void {
  const layout = BUNKER[rcl];
  if (!layout) {
    console.log(`没有 RCL${rcl} 的数据，可用的是 ${Object.keys(BUNKER).join(" / ")}`);
    return;
  }

  const grid = new Map<string, string>();
  const counts: Record<string, number> = {};

  // road 先画，让建筑覆盖在上面
  const order = ["road", ...Object.keys(layout).filter(k => k !== "road")];
  for (const type of order) {
    for (const [x, y] of layout[type] ?? []) {
      grid.set(`${x},${y}`, SYMBOL[type]);
      counts[type] = (counts[type] ?? 0) + 1;
    }
  }

  const min = 19;
  const max = 31;

  console.log(`\nOvermind bunker  RCL${rcl}   占地 ${max - min + 1}x${max - min + 1}   锚点在中心 (${ANCHOR.x},${ANCHOR.y})\n`);
  console.log("     " + Array.from({ length: max - min + 1 }, (_unused, i) => (i % 10).toString()).join(" "));

  for (let y = min; y <= max; y++) {
    let line = `  ${String(y - min).padStart(2)} `;
    for (let x = min; x <= max; x++) {
      const here = grid.get(`${x},${y}`) ?? " ";
      const isAnchor = x === ANCHOR.x && y === ANCHOR.y;
      line += (isAnchor && here === " " ? "+" : here) + " ";
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
}

if (require.main === module) {
  render(Number(process.argv[2] ?? 8));
}
