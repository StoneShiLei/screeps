/**
 * 房间状态面板：画在控制器上方。
 *
 * 扫一眼就知道升级还要多久、快不降级、人口够不够。开销不大，但默认
 * 仍挂在 panel 开关上，关掉就彻底不画。
 */

import { CROWDED, spawnLoadOf } from "./spawnLoad";
import { SUPPLY_PRIORITY, logisticsOf } from "./logistics";
import { isRemotePaused, reserveLeft } from "./remote";
import { decodeCells } from "../planner/roads";
import { expansionStatus } from "./expansion";
import { isVisualOn } from "../utils/settings";
import { lootStatus } from "./loot";
import { pendingSiteCount } from "../planner/roomPlanner";
import { roomPopulation } from "./spawnManager";

/** 每隔这么多 tick 采一次升级进度，太密了噪声大，太稀了反应慢 */
const SAMPLE_INTERVAL = 50;

/** 指数平滑系数：新采样占多少权重 */
const RATE_SMOOTHING = 0.3;

/** 降级倒计时低于这个值就标红（约 1 天，按 3 秒一 tick） */
const DOWNGRADE_WARN_TICKS = 20000;

/** 官方大约 3.2 秒一个 tick，用来把 tick 换成小时 */
const SECONDS_PER_TICK = 3.2;

const BAR_WIDTH = 10;

/** 待运量超过这个数就标黄，大致相当于一个搬运工来回一趟的运力 */
const BACKLOG_WARN = 1500;

const FONT_SIZE = 0.4;
const LINE_HEIGHT = 0.45;
const PADDING = 0.2;
const ROOM_SIZE = 50;

export function drawRoomPanel(room: Room): void {
  if (!isVisualOn("panel")) return;

  const controller = room.controller;
  if (!controller) return;

  sampleProgress(room, controller);

  const lines = buildLines(room, controller);
  const visual = room.visual;
  const height = lines.length * LINE_HEIGHT;
  const width = panelWidth(lines);

  // 控制器可能就贴在房间边上，画到墙外面等于白画
  const above = controller.pos.y - 1.2 - height;
  const y = above >= LINE_HEIGHT ? above : controller.pos.y + 1.5;
  const x = Math.max(0, Math.min(controller.pos.x, ROOM_SIZE - width - PADDING));

  // 半透明底，字叠在地形上也能看清
  visual.rect(x - PADDING, y - FONT_SIZE + 0.05, width, height + 0.4, {
    fill: "#000000",
    opacity: 0.45,
    stroke: undefined
  });

  for (let i = 0; i < lines.length; i++) {
    visual.text(lines[i].text, x, y + i * LINE_HEIGHT, {
      align: "left",
      font: FONT_SIZE,
      color: lines[i].color,
      opacity: 0.95
    });
  }
}

/**
 * 按最长那行估底框宽度。
 *
 * 汉字大致是一个字号宽，ASCII 半个多一点。估得不准也没关系，
 * 这只是块背景板，宁可略宽也别让字戳出去。
 */
export function panelWidth(lines: PanelLine[]): number {
  let widest = 0;

  for (const line of lines) {
    let width = 0;
    for (const character of line.text) {
      width += character.charCodeAt(0) > 0x2e80 ? FONT_SIZE : FONT_SIZE * 0.55;
    }
    widest = Math.max(widest, width);
  }

  return widest + PADDING * 2;
}

export interface PanelLine {
  text: string;
  color: string;
}

function buildLines(room: Room, controller: StructureController): PanelLine[] {
  const lines: PanelLine[] = [];
  const level = controller.level;
  const progress = controller.progress;
  const total = controller.progressTotal || 1;
  const percent = Math.floor((progress / total) * 100);
  const bar = progressBar(progress / total);

  lines.push({ text: `RCL${level} ${bar} ${percent}%`, color: "#ffffff" });

  if (level < 8) {
    const eta = estimateTicksToLevel(room.memory.progressSample, progress, total);
    lines.push({
      text: eta === undefined ? "ETA —" : `ETA ${formatDuration(eta)}`,
      color: "#aaaaaa"
    });
  } else {
    lines.push({ text: "已满级", color: "#88ff88" });
  }

  const downgrade = controller.ticksToDowngrade;
  const downgradeColor = downgrade < DOWNGRADE_WARN_TICKS ? "#ff6666" : "#88ff88";
  lines.push({ text: `降级 ${formatDuration(downgrade)}`, color: downgradeColor });

  lines.push({
    text: `能量 ${room.energyAvailable}/${room.energyCapacityAvailable}`,
    color: "#ffcc66"
  });

  const { counts, quota } = roomPopulation(room);
  const pop = (Object.keys(quota) as CreepRole[])
    .filter(role => quota[role] > 0 || counts[role] > 0)
    .map(role => `${shortRole(role)}${counts[role]}/${quota[role]}`)
    .join(" ");
  lines.push({ text: pop || "无人", color: "#cccccc" });

  lines.push(logisticsLine(room));
  lines.push(spawnLine(room));

  // 分母是"这一级还差多少栋"。只看活动工地数看不出进度：工地一次只开五个，
  // 五个满着既可能是还剩五栋，也可能是还剩五十栋
  const sites = room.find(FIND_MY_CONSTRUCTION_SITES).length;
  const pending = pendingSiteCount(room);
  lines.push({ text: `工地 ${sites}/${pending}`, color: pending > 0 ? "#ffff88" : "#888888" });

  const roads = roadLine(room);
  if (roads) lines.push(roads);

  const remotes = remoteLine(room);
  if (remotes) lines.push(remotes);

  // 分房和搬仓库都是有始有终的工程，进行中才占一行
  const expansion = expansionStatus(room);
  if (expansion) lines.push({ text: `分房 ${expansion}`, color: "#88ccff" });

  const loot = lootStatus(room);
  if (loot) lines.push({ text: `搬运 ${loot}`, color: "#ffdd44" });

  const cpu = Game.cpu.getUsed();
  const bucket = Game.cpu.bucket;
  lines.push({
    text: `CPU ${cpu.toFixed(1)}/${Game.cpu.limit} 桶 ${bucket}`,
    color: bucket < 2000 ? "#ff6666" : "#88ccff"
  });

  return lines;
}

/**
 * 物流一行：等着被运走的货，和等着被填满的坑。
 *
 * 这两个数就是判断运力够不够的全部依据。待运一直压着不降，说明 hauler 太少
 * 或者跑太远；缺口一直是零而待运很高，那是能量没处送——多半该多派升级工了。
 *
 * 待运只算地上的和矿边容器里的，storage 里的存货不算：那是攒着备用的，
 * 不是积压。口径和 spawnManager 决定 hauler 人数时用的完全一致。
 */
function logisticsLine(room: Room): PanelLine {
  const { supplies, demands } = logisticsOf(room);

  const waiting = supplies
    .filter(entry => entry.priority <= SUPPLY_PRIORITY.source)
    .reduce((sum, entry) => sum + entry.amount, 0);
  const missing = demands.reduce((sum, entry) => sum + entry.amount, 0);

  return {
    text: `待运 ${waiting} 缺口 ${missing}`,
    color: waiting > BACKLOG_WARN ? "#ffaa44" : "#aaccaa"
  };
}

/**
 * 孵化一行：spawn 忙成什么样，编制吃掉了多少预算。
 *
 * 一个 spawn 一轮寿命只造得出 500 个部件，这是常驻人口的硬上限，跟能量多少无关。
 * 撞上之后每多派一个人，就有别处的人死了补不上，而账面上一点征兆都没有——能量
 * 看着够用，人却总是差几个。所以这两个数得摆在明面上。
 *
 * 忙碌率明显低于编制比例，说明 spawn 想造却造不出来，那是能量没跟上；忙碌率贴着
 * 满而编制还有余量，说明有人死得太勤，多半是在外面被打了。
 */
function spawnLine(room: Room): PanelLine {
  const load = spawnLoadOf(room);
  const ratio = load.capacity > 0 ? load.parts / load.capacity : 0;

  return {
    text: `孵化 ${Math.round(load.busy * 100)}% 编制 ${Math.round(load.parts)}/${Math.round(load.capacity)}`,
    color: ratio > CROWDED ? "#ffaa44" : "#aaccaa"
  };
}

/**
 * 外矿一行：哪几个房间在采，冷却中的标出来。
 *
 * 外矿房间平时没视野，出了问题（被人占了、进了入侵者）在地图上一点征兆都没有，
 * 只能靠这行看出来"名单里有三个，实际在产的只有一个"。
 */
function remoteLine(room: Room): PanelLine | undefined {
  const remotes = room.memory.remotes;
  if (!remotes || remotes.length === 0) return undefined;

  const parts: string[] = [];
  let idle = 0;

  for (const name of remotes) {
    const paused = isRemotePaused(name);
    if (paused) idle++;

    parts.push(`${name}${remoteMark(name, paused)}`);
  }

  return {
    text: `外矿 ${parts.join(" ")}`,
    color: idle > 0 ? "#ffaa44" : "#aaccaa"
  };
}

/**
 * 外矿房间名后面那个小标记。
 *
 * 停是遇袭冷却；墙是控制器被前人的墙圈住了，还剩多少血量要砸；订是预定剩余，
 * 这个数在掉就说明预定员没接上班，源正要缩回 1500 容量。
 */
function remoteMark(roomName: string, paused: boolean): string {
  if (paused) return "(停)";

  const breach = Memory.rooms[roomName]?.breach;
  if (breach) return breach.wall ? `(墙${Math.ceil(breach.hits / 1000)}k)` : "(封死)";

  const left = reserveLeft(roomName);
  return left > 0 ? `(订${Math.round(left / 100)})` : "";
}

/**
 * 主干道进度：规划了几格、已经建好几格。
 *
 * 地图上那几个路点混在地形里本来就不显眼，路又要到 3、4 级才解锁，
 * 中间这段时间光看图很难分清是"还没到等级"还是"压根没算出来"。
 */
function roadLine(room: Room): PanelLine | undefined {
  if (!room.memory.roads) return undefined;

  const cells = decodeCells(room.memory.roads);
  if (cells.length === 0) return undefined;

  const built = cells.filter(cell =>
    room.lookForAt(LOOK_STRUCTURES, cell.x, cell.y).some(structure => structure.structureType === STRUCTURE_ROAD)
  ).length;

  return {
    text: `主干道 ${built}/${cells.length}`,
    color: built === cells.length ? "#88ff88" : "#aaaaaa"
  };
}

/**
 * 采样升级进度，算出平滑后的每 tick 增量。
 *
 * 只存上次采样点和平滑速率三个数，不做通用统计系统。
 */
export function sampleProgress(room: Room, controller: StructureController): void {
  if (controller.level >= 8) {
    delete room.memory.progressSample;
    return;
  }

  const previous = room.memory.progressSample;
  if (!previous) {
    room.memory.progressSample = { tick: Game.time, progress: controller.progress, rate: 0 };
    return;
  }

  const elapsed = Game.time - previous.tick;
  if (elapsed < SAMPLE_INTERVAL) return;

  // 升级瞬间 progress 会归零，那一帧算出来的速率是负的，直接丢掉重采
  if (controller.progress < previous.progress) {
    room.memory.progressSample = { tick: Game.time, progress: controller.progress, rate: previous.rate };
    return;
  }

  const instant = (controller.progress - previous.progress) / elapsed;
  const rate = previous.rate === 0 ? instant : previous.rate * (1 - RATE_SMOOTHING) + instant * RATE_SMOOTHING;

  room.memory.progressSample = { tick: Game.time, progress: controller.progress, rate };
}

/**
 * 按平滑速率估距下一级还要多少 tick。
 *
 * 纯函数，方便单元测试；速率还没采出来时返回 undefined。
 */
export function estimateTicksToLevel(
  sample: RoomMemory["progressSample"],
  progress: number,
  total: number
): number | undefined {
  if (!sample || sample.rate <= 0) return undefined;

  const remaining = total - progress;
  if (remaining <= 0) return 0;

  return Math.ceil(remaining / sample.rate);
}

/** 把 tick 数格式化成可读时长 */
export function formatDuration(ticks: number): string {
  if (!Number.isFinite(ticks) || ticks < 0) return "—";

  const seconds = ticks * SECONDS_PER_TICK;
  if (seconds < 60) return `${Math.round(ticks)}t`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m / ${Math.round(ticks)}t`;

  const hours = seconds / 3600;
  if (hours < 48) return `${hours.toFixed(1)}h / ${Math.round(ticks)}t`;
  return `${(hours / 24).toFixed(1)}d / ${Math.round(ticks)}t`;
}

export function progressBar(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * BAR_WIDTH);
  return `[${"#".repeat(filled)}${"-".repeat(BAR_WIDTH - filled)}]`;
}

/** 面板本来就是中文的，角色也用单字，省得再回来查 L 是谁 */
function shortRole(role: CreepRole): string {
  const names: Record<CreepRole, string> = {
    harvester: "采",
    miner: "矿",
    hauler: "运",
    builder: "建",
    upgrader: "升",
    defender: "卫",
    scout: "探",
    remoteMiner: "外矿",
    remoteHauler: "外运",
    reserver: "订",
    dismantler: "拆",
    claimer: "占",
    pioneer: "拓",
    looter: "搬"
  };
  return names[role];
}
