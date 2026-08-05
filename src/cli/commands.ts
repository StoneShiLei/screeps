/**
 * 游戏控制台命令行。
 *
 * 每条命令挂在一张注册表上，help() 从表里自动生成用法，不用手写两份。
 * 命令返回字符串，游戏控制台会把返回值打出来。
 *
 * 这个目录原先叫 console，游戏里一加载就报 Unknown module。打包用的
 * node-resolve 默认内置模块优先，而 console 正是 Node 的内置模块名，于是
 * 整个导入被当成外部依赖，产物里留下一句原样的 require 没有被内联进来。
 * 起目录名时避开 console、path、util 这些内置模块名。
 */

import {
  LOG_LEVELS,
  VISUAL_MODULES,
  isLogLevel,
  isVisualModule,
  setLogLevel,
  setSay,
  setVisual,
  settings
} from "../utils/settings";
import { logisticsOf } from "../managers/logistics";
import { planRoom } from "../planner/roomPlanner";
import { roomPopulation } from "../managers/spawnManager";

export interface Command {
  usage: string;
  describe: string;
  run: (...args: string[]) => string;
}

/** debug.on/off 的通配参数，一次开关全部模块 */
const ALL = "all";

/** 命令注册表；help 和 installCommands 都读这一份 */
export const COMMANDS: Record<string, Command> = {
  help: {
    usage: "help()",
    describe: "列出全部命令和用法",
    run: () => helpText()
  },
  "debug.on": {
    usage: "debug.on(module)",
    describe: `打开可视化模块：${VISUAL_MODULES.join(" / ")} / ${ALL}`,
    run: module => toggleVisual(module, true)
  },
  "debug.off": {
    usage: "debug.off(module)",
    describe: `关闭可视化模块：${VISUAL_MODULES.join(" / ")} / ${ALL}`,
    run: module => toggleVisual(module, false)
  },
  "debug.level": {
    usage: "debug.level(name)",
    describe: `设置日志级别：${LOG_LEVELS.join(" / ")}`,
    run: level => {
      if (!isLogLevel(level)) return `未知级别 ${level}，可选：${LOG_LEVELS.join(", ")}`;
      setLogLevel(level);
      return `日志级别 → ${level}`;
    }
  },
  "debug.say": {
    usage: "debug.say(true|false)",
    describe: "开关 creep 头顶喊话",
    run: value => {
      const enabled = parseBool(value);
      if (enabled === undefined) return "用法：debug.say(true) 或 debug.say(false)";
      setSay(enabled);
      return `say → ${enabled ? "开" : "关"}`;
    }
  },
  "debug.status": {
    usage: "debug.status()",
    describe: "查看当前调试设置",
    run: () => statusText()
  },
  replan: {
    usage: "replan(room)",
    describe: "清掉锚点重新规划房间布局",
    run: roomName => {
      const room = resolveRoom(roomName);
      if (typeof room === "string") return room;

      clearOutposts(room);
      if (!planRoom(room)) return `${room.name} 规划失败，看日志`;
      return formatAnchor(room);
    }
  },
  cleanup: {
    usage: "cleanup()",
    describe: "清理已死 creep 和不再属于自己的房间的 Memory",
    run: () => {
      let creeps = 0;
      for (const name in Memory.creeps) {
        if (!(name in Game.creeps)) {
          delete Memory.creeps[name];
          creeps++;
        }
      }

      let rooms = 0;
      for (const name in Memory.rooms) {
        if (!Game.rooms[name]?.controller?.my) {
          delete Memory.rooms[name];
          rooms++;
        }
      }

      return `清理完成：creep Memory ${creeps} 条，房间 Memory ${rooms} 条`;
    }
  },
  kill: {
    usage: "kill(role, room?)",
    describe: "按角色自杀 creep；不写房间就全图杀",
    run: (role, roomName) => {
      if (!role) return "用法：kill(role, room?)";
      if (!isCreepRole(role)) return `未知角色 ${role}`;

      let killed = 0;
      for (const creep of Object.values(Game.creeps)) {
        if (creep.memory.role !== role) continue;
        if (roomName && creep.memory.room !== roomName) continue;
        creep.suicide();
        killed++;
      }

      return `已下令 ${killed} 个 ${role} 自杀${roomName ? `（${roomName}）` : ""}`;
    }
  },
  quota: {
    usage: "quota(room?)",
    describe: "查看各角色配额与实到人数",
    run: roomName => {
      const room = resolveRoom(roomName);
      if (typeof room === "string") return room;

      const { counts, quota } = roomPopulation(room);
      const lines = (Object.keys(quota) as CreepRole[]).map(
        role => `  ${role.padEnd(10)} ${counts[role]}/${quota[role]}`
      );
      return `${room.name} 人口\n${lines.join("\n")}`;
    }
  },
  logistics: {
    usage: "logistics(room?)",
    describe: "打印供需快照",
    run: roomName => {
      const room = resolveRoom(roomName);
      if (typeof room === "string") return room;

      const { supplies, demands } = logisticsOf(room);
      const demandLines = demands.map(entry => `  -${entry.amount} @(${entry.x},${entry.y}) p${entry.priority}`);
      const supplyLines = supplies.map(entry => `  +${entry.amount} @(${entry.x},${entry.y}) p${entry.priority}`);
      return [
        `${room.name} 物流`,
        `需求 ${demands.length}`,
        ...(demandLines.length ? demandLines : ["  （无）"]),
        `供给 ${supplies.length}`,
        ...(supplyLines.length ? supplyLines : ["  （无）"])
      ].join("\n");
    }
  }
};

export function helpText(): string {
  const lines = Object.values(COMMANDS).map(command => `  ${command.usage.padEnd(28)} ${command.describe}`);
  return `可用命令：\n${lines.join("\n")}`;
}

/**
 * 把命令挂到 global 上。
 *
 * Screeps 的控制台只认 global 上的东西；挂载本身必然碰到 any，
 * 这里集中关掉那几条规则，别的地方仍按严格模式写。
 */
export function installCommands(): void {
  /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
  const g: any = global;

  g.help = () => COMMANDS.help.run();
  g.debug = {
    on: (module: string) => COMMANDS["debug.on"].run(module),
    off: (module: string) => COMMANDS["debug.off"].run(module),
    level: (name: string) => COMMANDS["debug.level"].run(name),
    say: (value: boolean | string) => COMMANDS["debug.say"].run(String(value)),
    status: () => COMMANDS["debug.status"].run()
  };
  g.replan = (room?: string) => COMMANDS.replan.run(room ?? "");
  g.cleanup = () => COMMANDS.cleanup.run();
  g.kill = (role: string, room?: string) => COMMANDS.kill.run(role, room ?? "");
  g.quota = (room?: string) => COMMANDS.quota.run(room ?? "");
  g.logistics = (room?: string) => COMMANDS.logistics.run(room ?? "");
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
}

function clearOutposts(room: Room): void {
  delete room.memory.anchor;
  delete room.memory.miningSpots;
  delete room.memory.upgradeSpot;
  delete room.memory.upgradeStations;
}

function formatAnchor(room: Room): string {
  const anchor = room.memory.anchor;
  if (!anchor) return `${room.name} 规划失败，看日志`;
  return `${room.name} 已重新规划，锚点 (${anchor.x},${anchor.y})`;
}

function toggleVisual(module: string, enabled: boolean): string {
  if (module === ALL) {
    for (const each of VISUAL_MODULES) setVisual(each, enabled);
    return `全部可视化 → ${enabled ? "开" : "关"}`;
  }

  if (!isVisualModule(module)) return `未知模块 ${module}，可选：${VISUAL_MODULES.join(", ")}, ${ALL}`;
  setVisual(module, enabled);
  return `${module} → ${enabled ? "开" : "关"}`;
}

function statusText(): string {
  const current = settings();
  const visuals = VISUAL_MODULES.map(module => `  ${module.padEnd(10)} ${current.visuals[module] ? "开" : "关"}`).join(
    "\n"
  );
  return `日志级别：${current.level}\nsay：${current.say ? "开" : "关"}\n可视化：\n${visuals}`;
}

function parseBool(value: string): boolean | undefined {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function isCreepRole(value: string): value is CreepRole {
  return ["harvester", "upgrader", "builder", "miner", "hauler", "defender"].includes(value);
}

/** 没写房间名时用唯一的己方房间；有多个就要求写清楚 */
function resolveRoom(roomName?: string): Room | string {
  if (roomName) {
    const room = Game.rooms[roomName];
    if (!room?.controller?.my) return `房间 ${roomName} 不存在或不属于自己`;
    return room;
  }

  const owned = Object.values(Game.rooms).filter(room => room.controller?.my);
  if (owned.length === 0) return "没有己方房间";
  if (owned.length > 1) return `有多个房间，请写明：${owned.map(room => room.name).join(", ")}`;
  return owned[0];
}
