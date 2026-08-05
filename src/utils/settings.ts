/**
 * 调试设置：存在 Memory 里，代码上传不会丢。
 *
 * 可视化、say、日志级别各自独立开关——排查物流时只开 logistics，
 * 屏幕不会同时被路径线和规划图洗一遍。
 */

export type LogLevel = "error" | "warn" | "info" | "debug";

export type VisualModule = "movement" | "logistics" | "planner" | "spawn" | "panel";

export const LOG_LEVELS: LogLevel[] = ["error", "warn", "info", "debug"];

export const VISUAL_MODULES: VisualModule[] = ["movement", "logistics", "planner", "spawn", "panel"];

/** 数字越小越严重，过滤时拿来比较 */
export const LOG_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

export interface DebugSettings {
  level: LogLevel;
  visuals: Record<VisualModule, boolean>;
  say: boolean;
}

const DEFAULTS: DebugSettings = {
  // 日常跑着看 info 够了；开 debug 会刷屏
  level: "info",
  visuals: {
    movement: false,
    logistics: false,
    planner: false,
    spawn: true,
    // 面板信息密度适中，默认开着扫一眼就知道房间状态
    panel: true
  },
  say: false
};

/**
 * 读整份设置，缺字段的用默认值补齐。
 *
 * 会拼出一个新对象，只给 debug.status() 这种一次性的地方用。每 tick 都要问
 * 的开关走下面那三个单值函数，别用这个——它们在热路径上，多一次对象分配
 * 都是白烧的 CPU，而省 CPU 正是这套开关存在的理由。
 */
export function settings(): DebugSettings {
  return { level: logLevel(), say: sayEnabled(), visuals: currentVisuals() };
}

/**
 * 单个可视化模块开不开。
 *
 * 纯读，不碰 Memory 的写入路径：这函数每个 creep 每 tick 都要问一遍，
 * 顺手初始化 Memory 的话等于每 tick 都去查一次"初始化过没有"。
 */
export function isVisualOn(module: VisualModule): boolean {
  const stored = Memory.settings?.visuals?.[module];
  return typeof stored === "boolean" ? stored : DEFAULTS.visuals[module];
}

export function sayEnabled(): boolean {
  const stored = Memory.settings?.say;
  return typeof stored === "boolean" ? stored : DEFAULTS.say;
}

export function logLevel(): LogLevel {
  const stored = Memory.settings?.level;
  return isLogLevel(stored) ? stored : DEFAULTS.level;
}

export function setLogLevel(level: LogLevel): void {
  ensureStored().level = level;
}

export function setSay(enabled: boolean): void {
  ensureStored().say = enabled;
}

export function setVisual(module: VisualModule, enabled: boolean): void {
  const stored = ensureStored();
  if (!stored.visuals) stored.visuals = { ...DEFAULTS.visuals };
  stored.visuals[module] = enabled;
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && LOG_LEVELS.includes(value as LogLevel);
}

export function isVisualModule(value: unknown): value is VisualModule {
  return typeof value === "string" && VISUAL_MODULES.includes(value as VisualModule);
}

function ensureStored(): NonNullable<Memory["settings"]> {
  if (!Memory.settings) Memory.settings = cloneDefaults();
  return Memory.settings;
}

function cloneDefaults(): DebugSettings {
  return {
    level: DEFAULTS.level,
    say: DEFAULTS.say,
    visuals: { ...DEFAULTS.visuals }
  };
}

function currentVisuals(): Record<VisualModule, boolean> {
  const stored = Memory.settings?.visuals;
  const result = { ...DEFAULTS.visuals };
  if (!stored) return result;

  for (const module of VISUAL_MODULES) {
    const value = stored[module];
    if (typeof value === "boolean") result[module] = value;
  }

  return result;
}
