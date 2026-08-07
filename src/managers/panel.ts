/**
 * 房间状态面板：钉在左上角，分区展示，不挡作业区。
 *
 * 扫一眼：升级进度、能量水位、物流堵不堵、孵化紧不紧、外矿在不在干活。
 * 默认挂 panel 开关，关掉就不画。
 */

import { CROWDED, spawnLoadOf } from "./spawnLoad";
import { DEMAND_PRIORITY, LogisticsEntry, SUPPLY_PRIORITY, logisticsOf } from "./logistics";
import {
  NEUTRAL_SOURCE_RATE,
  RESERVED_SOURCE_RATE,
  activeRemoteSources,
  isRemotePaused,
  isReserved,
  reserveLeft
} from "./remote";
import { decodeCells } from "../planner/roads";
import { expansionStatus } from "./expansion";
import { hostilesIn } from "../roles/defender";
import { isVisualOn } from "../utils/settings";
import { lootStatus } from "./loot";
import { pendingSiteCount } from "../planner/roomPlanner";
import { spawnQueue } from "./spawnManager";

/** 每隔这么多 tick 采一次升级进度 */
const SAMPLE_INTERVAL = 50;

/** 指数平滑：新采样权重 */
const RATE_SMOOTHING = 0.3;

/** 降级倒计时低于此值标红（约 1 天） */
const DOWNGRADE_WARN_TICKS = 20000;

const SECONDS_PER_TICK = 3.2;

const BAR_WIDTH = 10;

const BACKLOG_WARN = 1500;
const STORAGE_LOW = 10000;

/** 字号：标题 / 正文 / 脚注（按房间默认缩放也能扫一眼） */
const FONT_HEAD = 0.72;
const FONT_BODY = 0.62;
const FONT_FOOT = 0.52;

const LINE_HEAD = 0.8;
const LINE_BODY = 0.7;
const LINE_FOOT = 0.58;

const PAD_X = 0.22;
const PAD_Y = 0.12;
const ACCENT_W = 0.07;

/** 面板色板：深底 + 冷灰字，状态用绿/琥珀/红 */
const C = {
  bg: "#0d1117",
  border: "#30363d",
  accent: "#58a6ff",
  accentWarn: "#d29922",
  accentBad: "#f85149",
  head: "#e6edf3",
  body: "#c9d1d9",
  muted: "#8b949e",
  ok: "#3fb950",
  warn: "#d29922",
  bad: "#f85149",
  info: "#79c0ff",
  job: "#a5d6ff"
};

export function drawRoomPanel(room: Room): void {
  if (!isVisualOn("panel")) return;

  const controller = room.controller;
  if (!controller) return;

  sampleProgress(room, controller);

  const lines = buildLines(room, controller);
  if (lines.length === 0) return;

  const visual = room.visual;
  const height = linesHeight(lines);
  const width = panelWidth(lines);
  const { x, y } = panelOrigin(width, height);

  const accent = panelAccent(lines);
  const top = y - FONT_HEAD + 0.08;
  const boxH = height + PAD_Y * 2 + 0.08;

  // 底卡
  visual.rect(x - PAD_X, top, width + PAD_X * 2, boxH, {
    fill: C.bg,
    opacity: 0.78,
    stroke: C.border,
    strokeWidth: 0.04
  });

  // 左侧状态条
  visual.rect(x - PAD_X, top, ACCENT_W, boxH, {
    fill: accent,
    opacity: 0.95,
    stroke: undefined
  });

  let cursor = y;
  for (const line of lines) {
    if (line.divider) {
      visual.line(x, cursor - 0.12, x + width - PAD_X, cursor - 0.12, {
        color: C.border,
        width: 0.03,
        opacity: 0.7
      });
      cursor += LINE_FOOT * 0.35;
      continue;
    }

    const size = line.size ?? FONT_BODY;
    visual.text(line.text, x + 0.05, cursor, {
      align: "left",
      font: size,
      color: line.color,
      opacity: 0.96
    });
    cursor += lineHeight(line);
  }
}

/**
 * 面板左上角落点。纯函数方便单测。
 */
export function panelOrigin(width: number, height: number): { x: number; y: number } {
  void width;
  void height;
  return { x: PAD_X + ACCENT_W + 0.06, y: FONT_HEAD + 0.2 };
}

/**
 * 按最长那行估底框宽度（考虑字号与全角字符）。
 */
export function panelWidth(lines: PanelLine[]): number {
  let widest = 0;

  for (const line of lines) {
    if (line.divider) continue;
    const size = line.size ?? FONT_BODY;
    let width = 0;
    for (const character of line.text) {
      width += charWidth(character, size);
    }
    widest = Math.max(widest, width);
  }

  return widest + 0.15;
}

export interface PanelLine {
  text: string;
  color: string;
  size?: number;
  /** 画一条细分隔，不算文字行 */
  divider?: boolean;
}

function buildLines(room: Room, controller: StructureController): PanelLine[] {
  const lines: PanelLine[] = [];
  const level = controller.level;
  const progress = controller.progress;
  const total = controller.progressTotal || 1;
  const ratio = progress / total;
  const percent = Math.floor(ratio * 100);

  // —— 标题：房间 · 等级 · 进度条 ——
  lines.push({
    text: `${room.name}  RCL${level}  ${progressBar(ratio)} ${percent}%`,
    color: C.head,
    size: FONT_HEAD
  });

  // —— 进度副行：ETA + 降级 ——
  const downgrade = controller.ticksToDowngrade;
  const dgColor = downgrade < DOWNGRADE_WARN_TICKS ? C.bad : C.muted;
  if (level < 8) {
    const eta = estimateTicksToLevel(room.memory.progressSample, progress, total);
    const etaText = eta === undefined ? "—" : formatDuration(eta);
    lines.push({
      text: `ETA ${etaText}   降级 ${formatDuration(downgrade)}`,
      color: dgColor === C.bad ? C.bad : C.muted,
      size: FONT_BODY
    });
  } else {
    lines.push({
      text: `已满级   降级 ${formatDuration(downgrade)}`,
      color: dgColor,
      size: FONT_BODY
    });
  }

  lines.push({ text: "", color: C.muted, divider: true });

  // —— 能量：孵化槽 + 仓 ——
  const energyText = `${room.energyAvailable}/${room.energyCapacityAvailable}`;
  const stored = room.storage?.store[RESOURCE_ENERGY];
  const storeBit =
    stored === undefined ? "" : `   仓 ${compactNumber(stored)}${stored < STORAGE_LOW ? "!" : ""}`;
  lines.push({
    text: `能 ${energyText}${storeBit}`,
    color: energyColor(room.energyAvailable, room.energyCapacityAvailable),
    size: FONT_BODY
  });

  // —— 物流三件套 ——
  lines.push(logisticsLine(room));

  // —— 孵化 + 各角色现役/编制 ——
  lines.push(spawnLine(room));

  const { next, slots } = spawnQueue(room);
  for (const line of populationLines(slots)) lines.push(line);

  const deficits = slots.filter(slot => slot.deficit > 0);
  if (deficits.length > 0) {
    const queue = deficits
      .map(slot => {
        const mark = slot.role === next ? "▸" : "";
        const times = slot.deficit > 1 ? `×${slot.deficit}` : "";
        return `${mark}${shortRole(slot.role)}${times}`;
      })
      .join(" ");
    lines.push({ text: `队 ${queue}`, color: C.warn, size: FONT_BODY });
  }

  // —— 建造 / 路（有事才显示） ——
  const build = buildLine(room);
  if (build) lines.push(build);

  // —— 外矿 ——
  const remotes = remoteLine(room);
  if (remotes) lines.push(remotes);

  // —— 进行中的工程 ——
  const expansion = expansionStatus(room);
  if (expansion) lines.push({ text: `分房 ${expansion}`, color: C.job, size: FONT_BODY });

  const loot = lootStatus(room);
  if (loot) lines.push({ text: `搬运 ${loot}`, color: C.warn, size: FONT_BODY });

  // —— 防御相关（异常才占行） ——
  const towers = towerLine(room);
  if (towers) lines.push(towers);

  const threat = threatLine(room);
  if (threat) lines.push(threat);

  const safe = safeModeLine(controller);
  if (safe) lines.push(safe);

  lines.push({ text: "", color: C.muted, divider: true });

  // —— 脚注：CPU / 桶 / tick ——
  const cpu = Game.cpu.getUsed();
  const bucket = Game.cpu.bucket;
  lines.push({
    text: `CPU ${cpu.toFixed(1)}/${Game.cpu.limit}  ·  桶 ${compactNumber(bucket)}  ·  t${Game.time}`,
    color: bucket < 2000 ? C.bad : C.muted,
    size: FONT_FOOT
  });

  return lines;
}

function logisticsLine(room: Room): PanelLine {
  const { supplies, demands } = logisticsOf(room);

  const waiting = supplies
    .filter(entry => entry.priority <= SUPPLY_PRIORITY.source)
    .reduce((sum, entry) => sum + entry.amount, 0);

  const missing = urgentDemand(demands);
  const usable = usableEnergy(supplies);

  let color = C.body;
  if (waiting > BACKLOG_WARN || missing > 300) color = C.warn;
  if (missing > 800) color = C.bad;

  return {
    text: `待运 ${compactNumber(waiting)}  缺口 ${compactNumber(missing)}  可用 ${compactNumber(usable)}`,
    color,
    size: FONT_BODY
  };
}

/** spawn / extension / tower 还缺多少 */
export function urgentDemand(demands: LogisticsEntry[]): number {
  return demands
    .filter(entry => entry.priority <= DEMAND_PRIORITY.tower)
    .reduce((sum, entry) => sum + entry.amount, 0);
}

/** 房间里能取出来干活的能量 */
export function usableEnergy(supplies: LogisticsEntry[]): number {
  return supplies.reduce((sum, entry) => sum + entry.amount, 0);
}

function spawnLine(room: Room): PanelLine {
  const load = spawnLoadOf(room);
  const ratio = load.capacity > 0 ? load.parts / load.capacity : 0;

  return {
    text: `孵化 ${Math.round(load.busy * 100)}%  ·  编制 ${Math.round(load.parts)}/${Math.round(load.capacity)}`,
    color: ratio > CROWDED ? C.warn : C.body,
    size: FONT_BODY
  };
}

/**
 * 各角色现役/编制明细。字号放大后一行容易超宽，超过一半角色就拆两行。
 */
function populationLines(slots: { role: CreepRole; count: number; quota: number }[]): PanelLine[] {
  const parts = slots
    .filter(slot => slot.quota > 0 || slot.count > 0)
    .map(slot => `${shortRole(slot.role)}${slot.count}/${slot.quota}`);

  if (parts.length === 0) return [{ text: "无人", color: C.muted, size: FONT_BODY }];

  // 字号放大后角色一多会戳出底框，拆两行比缩成总数清楚
  if (parts.length > 7) {
    const mid = Math.ceil(parts.length / 2);
    return [
      { text: parts.slice(0, mid).join(" "), color: C.body, size: FONT_BODY },
      { text: parts.slice(mid).join(" "), color: C.body, size: FONT_BODY }
    ];
  }

  return [{ text: parts.join(" "), color: C.body, size: FONT_BODY }];
}

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

  const income = remoteIncome(room);
  const incomeBit = income > 0 ? `  ≈${income}e/t` : "";

  return {
    text: `外矿 ${parts.join(" ")}${incomeBit}`,
    color: idle > 0 ? C.warn : C.body,
    size: FONT_BODY
  };
}

/** 正在采的外矿源合计再生 */
export function remoteIncome(home: Room): number {
  let income = 0;
  for (const entry of activeRemoteSources(home)) {
    income += isReserved(entry.roomName) ? RESERVED_SOURCE_RATE : NEUTRAL_SOURCE_RATE;
  }
  return income;
}

function remoteMark(roomName: string, paused: boolean): string {
  if (paused) return "·停";

  const visible = Game.rooms[roomName];
  if (visible && hostilesIn(visible).length > 0) return "·抗";

  const memory = Memory.rooms[roomName];
  if (memory?.unusable === "core" && memory.coreLevel === 0) return "·核";

  const breach = memory?.breach;
  if (breach) return breach.wall ? `·墙${Math.ceil(breach.hits / 1000)}k` : "·封";

  const left = reserveLeft(roomName);
  return left > 0 ? `·订${Math.round(left / 100)}` : "";
}

function buildLine(room: Room): PanelLine | undefined {
  const sites = room.find(FIND_MY_CONSTRUCTION_SITES).length;
  const pending = pendingSiteCount(room);
  const road = roadProgress(room);

  if (pending <= 0 && sites <= 0 && !road) return undefined;

  const bits: string[] = [];
  if (pending > 0 || sites > 0) bits.push(`工地 ${sites}/${pending}`);
  if (road) bits.push(`路 ${road.built}/${road.total}`);

  const done = pending <= 0 && (!road || road.built === road.total);
  return {
    text: bits.join("  ·  "),
    color: done ? C.ok : C.warn,
    size: FONT_BODY
  };
}

function roadProgress(room: Room): { built: number; total: number } | undefined {
  if (!room.memory.roads) return undefined;

  const cells = decodeCells(room.memory.roads);
  if (cells.length === 0) return undefined;

  const built = cells.filter(cell =>
    room.lookForAt(LOOK_STRUCTURES, cell.x, cell.y).some(structure => structure.structureType === STRUCTURE_ROAD)
  ).length;

  return { built, total: cells.length };
}

function towerLine(room: Room): PanelLine | undefined {
  const towers = room.find(FIND_MY_STRUCTURES, {
    filter: (structure): structure is StructureTower => structure.structureType === STRUCTURE_TOWER
  });
  if (towers.length === 0) return undefined;

  let energy = 0;
  let capacity = 0;
  for (const tower of towers) {
    energy += tower.store[RESOURCE_ENERGY] ?? 0;
    capacity += tower.store.getCapacity(RESOURCE_ENERGY) ?? 0;
  }

  const ratio = capacity > 0 ? energy / capacity : 0;
  // 塔水位健康时不占行；偏低或有威胁时才提醒
  const threatened = hostilesIn(room).length > 0;
  if (ratio >= 0.6 && !threatened) return undefined;

  return {
    text: `塔×${towers.length} ${Math.round(ratio * 100)}%  ${compactNumber(energy)}/${compactNumber(capacity)}`,
    color: ratio < 0.3 ? C.bad : ratio < 0.6 ? C.warn : C.ok,
    size: FONT_BODY
  };
}

function threatLine(room: Room): PanelLine | undefined {
  const hostiles = hostilesIn(room);
  if (hostiles.length === 0) return undefined;

  return {
    text: `⚠ 威胁 ${hostiles.length}`,
    color: C.bad,
    size: FONT_BODY
  };
}

function safeModeLine(controller: StructureController): PanelLine | undefined {
  if (controller.safeMode) {
    return { text: `安全模式 ${formatDuration(controller.safeMode)}`, color: C.ok, size: FONT_BODY };
  }

  const cooldown = controller.safeModeCooldown ?? 0;
  if (cooldown > 0) {
    return { text: `安全冷却 ${formatDuration(cooldown)}`, color: C.warn, size: FONT_BODY };
  }

  // 平时不显示「安全×N」——满员时无信息量；只在 0 次时警告
  if (controller.safeModeAvailable === 0) {
    return { text: "安全次数耗尽", color: C.bad, size: FONT_BODY };
  }

  return undefined;
}

function energyColor(available: number, capacity: number): string {
  if (capacity <= 0) return C.warn;
  const ratio = available / capacity;
  if (ratio < 0.25) return C.bad;
  if (ratio < 0.6) return C.warn;
  return C.ok;
}

function panelAccent(lines: PanelLine[]): string {
  if (lines.some(line => line.color === C.bad && !line.divider)) return C.accentBad;
  if (lines.some(line => line.color === C.warn && !line.divider)) return C.accentWarn;
  return C.accent;
}

function linesHeight(lines: PanelLine[]): number {
  let height = 0;
  for (const line of lines) height += lineHeight(line);
  return height;
}

function lineHeight(line: PanelLine): number {
  if (line.divider) return LINE_FOOT * 0.35;
  if (line.size === FONT_HEAD) return LINE_HEAD;
  if (line.size === FONT_FOOT) return LINE_FOOT;
  return LINE_BODY;
}

function charWidth(character: string, fontSize: number): number {
  const code = character.charCodeAt(0);
  // 汉字、全角标点、方块进度条按整字宽
  if (code > 0x2e80 || (code >= 0x2500 && code <= 0x259f)) return fontSize;
  return fontSize * 0.55;
}

/**
 * 大数缩写，面板上 12400 → 12.4k，少占宽度。
 */
export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (abs < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

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

  if (controller.progress < previous.progress) {
    room.memory.progressSample = { tick: Game.time, progress: controller.progress, rate: previous.rate };
    return;
  }

  const instant = (controller.progress - previous.progress) / elapsed;
  const rate = previous.rate === 0 ? instant : previous.rate * (1 - RATE_SMOOTHING) + instant * RATE_SMOOTHING;

  room.memory.progressSample = { tick: Game.time, progress: controller.progress, rate };
}

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

export function formatDuration(ticks: number): string {
  if (!Number.isFinite(ticks) || ticks < 0) return "—";

  const seconds = ticks * SECONDS_PER_TICK;
  if (seconds < 60) return `${Math.round(ticks)}t`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = seconds / 3600;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export function progressBar(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * BAR_WIDTH);
  return `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
}

function shortRole(role: CreepRole): string {
  const names: Record<CreepRole, string> = {
    harvester: "采",
    miner: "矿",
    hauler: "运",
    builder: "建",
    upgrader: "升",
    defender: "卫",
    guardian: "援",
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
