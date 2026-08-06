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
import { cancelExpansion, expansionStatus, startExpansion } from "../managers/expansion";
import { cleanupCreepMemory, cleanupRoomMemory } from "../utils/memory";
import { enableRemote, isRemotePaused, reserveLeft } from "../managers/remote";
import { loadByRole, spawnLoadOf } from "../managers/spawnLoad";
import { lootPiles, lootStatus, startLoot, stopLoot } from "../managers/loot";
import { flagHelpText } from "../managers/flags";
import { logisticsOf } from "../managers/logistics";
import { planRoom } from "../planner/roomPlanner";
import { spawnQueue } from "../managers/spawnManager";

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
  flaghelp: {
    usage: "flaghelp()",
    describe: "列出可以用旗子下达的任务",
    run: () => flagHelpText()
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
    run: () => `清理完成：creep Memory ${cleanupCreepMemory()} 条，房间 Memory ${cleanupRoomMemory()} 条`
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
    describe: "按孵化优先级查看配额与缺口（★ = 下一个造谁）",
    run: roomName => {
      const room = resolveRoom(roomName);
      if (typeof room === "string") return room;

      const { next, slots } = spawnQueue(room);
      const lines = slots.map(slot => {
        const mark = slot.role === next ? "★" : " ";
        const gap = slot.deficit > 0 ? `  缺${slot.deficit}` : "";
        return ` ${mark}${slot.role.padEnd(12)} ${slot.count}/${slot.quota}${gap}`;
      });
      return `${room.name} 孵化队列${next ? `（下一个 ${next}）` : "（满编）"}\n${lines.join("\n")}`;
    }
  },
  load: {
    usage: "load(room?)",
    describe: "查看孵化预算被哪些角色占着",
    run: roomName => {
      const room = resolveRoom(roomName);
      if (typeof room === "string") return room;
      return loadText(room);
    }
  },
  remote: {
    usage: "remote(room?)",
    describe: "查看外矿名单与邻房侦察结果",
    run: roomName => {
      const room = resolveRoom(roomName);
      if (typeof room === "string") return room;
      return remoteText(room);
    }
  },
  "remote.add": {
    usage: "remote.add(target, room?)",
    describe: "手动把某个房间加进外矿名单，被别人预定的也收",
    run: (target, roomName) => {
      if (!target) return "用法：remote.add(target, room?)";

      const room = resolveRoom(roomName);
      if (typeof room === "string") return room;

      const memory = Memory.rooms[target];
      if (!memory?.scouted) return `${target} 还没侦察过，等 scout 去过再加`;
      // 预定是唯一能人为推翻的一档：预定不阻止采矿，反而把源容量抬到 3000
      if (memory.unusable && memory.unusable !== "reserved") return `${target} 不可用：${memory.unusable}`;

      if ((room.memory.remotes ?? []).includes(target)) return `${target} 已经在名单里`;

      const shared = memory.unusable === "reserved";
      enableRemote(room, target, shared);

      const note = shared ? "（被别人预定着，只采矿不派预定员）" : "";
      return `${room.name} 外矿名单 → ${(room.memory.remotes ?? []).join(" ")}${note}`;
    }
  },
  "remote.drop": {
    usage: "remote.drop(target, room?)",
    describe: "把某个房间从外矿名单里去掉",
    run: (target, roomName) => {
      if (!target) return "用法：remote.drop(target, room?)";

      const room = resolveRoom(roomName);
      if (typeof room === "string") return room;

      const remotes = room.memory.remotes ?? [];
      const index = remotes.indexOf(target);
      if (index < 0) return `${target} 不在名单里`;

      remotes.splice(index, 1);
      delete Memory.rooms[target]?.home;
      // 手动放行的标记跟着一起撤，否则下次自动挑选会把这个预定房又收回来
      delete Memory.rooms[target]?.forced;

      // 认了这个房间的外派人员得放掉，否则它们会一直往一个不再采的房间跑
      for (const creep of Object.values(Game.creeps)) {
        if (creep.memory.targetRoom === target) delete creep.memory.targetRoom;
      }

      return `${room.name} 外矿名单 → ${remotes.length > 0 ? remotes.join(" ") : "（空）"}`;
    }
  },
  rescout: {
    usage: "rescout(target?)",
    describe: "清掉侦察记录，让 scout 重新去看；不写房间就清全部邻房",
    run: target => {
      let cleared = 0;

      for (const name in Memory.rooms) {
        if (target && name !== target) continue;
        if (Game.rooms[name]?.controller?.my) continue;

        delete Memory.rooms[name].scouted;
        delete Memory.rooms[name].unusable;
        cleared++;
      }

      return `已清 ${cleared} 个房间的侦察记录`;
    }
  },
  expand: {
    usage: "expand(target, room?)",
    describe: "开分房：占领 target 并派拓荒者把第一个 spawn 建起来",
    run: (target, roomName) => {
      // 查进度时认得出是哪个房间在开分房；要新开一个就得写明由谁出资
      const room = target ? resolveRoom(roomName) : resolveDirective(roomName, each => !!each.memory.expansion);
      if (typeof room === "string") return room;
      if (!target) return expansionStatus(room) ?? `${room.name} 没在开分房，用法：expand(target)`;

      return startExpansion(room, target);
    }
  },
  "expand.cancel": {
    usage: "expand.cancel(room?)",
    describe: "取消开分房，已派出的人转回本土",
    run: roomName => {
      const room = resolveDirective(roomName, each => !!each.memory.expansion);
      if (typeof room === "string") return room;
      return cancelExpansion(room);
    }
  },
  loot: {
    usage: "loot(target, room?)",
    describe: "搬空无主房间里前人留下的仓库；不写 target 就看进度",
    run: (target, roomName) => {
      const room = target ? resolveRoom(roomName) : resolveDirective(roomName, each => !!each.memory.loot);
      if (typeof room === "string") return room;
      if (!target) return lootStatus(room) ?? `${room.name} 没在搬东西，用法：loot(target)`;

      return startLoot(room, target);
    }
  },
  "loot.stop": {
    usage: "loot.stop(room?)",
    describe: "停止搬运",
    run: roomName => {
      const room = resolveDirective(roomName, each => !!each.memory.loot);
      if (typeof room === "string") return room;
      return stopLoot(room);
    }
  },
  "loot.scan": {
    usage: "loot.scan(target)",
    describe: "列出某个房间里能搬走的建筑和存量（需要有视野）",
    run: target => {
      const room = Game.rooms[target];
      if (!room) return `${target} 现在没有视野，等有人过去再看`;

      const piles = lootPiles(room);
      if (piles.length === 0) return `${target} 没有可搬的东西`;

      const lines = piles.map(pile => {
        const { structure } = pile;
        const contents = (Object.keys(structure.store) as ResourceConstant[])
          .filter(type => structure.store[type] > 0)
          .map(type => `${type} ${structure.store[type]}`)
          .join("，");
        return `  ${structure.structureType.padEnd(12)} (${structure.pos.x},${structure.pos.y})`.padEnd(28) + contents;
      });

      const total = piles.reduce((sum, pile) => sum + pile.amount, 0);
      return [`${target} 可搬 ${total}`, ...lines].join("\n");
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

/**
 * 孵化预算的明细。
 *
 * 一个 spawn 一轮寿命只造得出 500 个部件，这是常驻人口的硬上限。真到了不够用的
 * 那天，要砍谁就得看这张表——单位是部件当量，带 CLAIM 的按 2.5 倍算，因为它
 * 600 tick 就得换一个人。
 */
function loadText(room: Room): string {
  const load = spawnLoadOf(room);
  const byRole = loadByRole(room);

  const lines = (Object.keys(byRole) as CreepRole[])
    .sort((a, b) => (byRole[b] ?? 0) - (byRole[a] ?? 0))
    .map(role => {
      const parts = byRole[role] ?? 0;
      const share = load.capacity > 0 ? Math.round((parts / load.capacity) * 100) : 0;
      return `  ${role.padEnd(12)} ${parts.toFixed(0).padStart(4)} 当量  ${share}%`;
    });

  return [
    `${room.name} 孵化预算`,
    `  编制 ${load.parts.toFixed(0)}/${load.capacity}（${Math.round((load.parts / (load.capacity || 1)) * 100)}%）`,
    `  实测忙碌率 ${Math.round(load.busy * 100)}%`,
    ...lines
  ].join("\n");
}

/**
 * 外矿现状：名单在采什么，邻房各是什么情况。
 *
 * 邻房那一段是给"为什么不开外矿"用的——名单空着的时候，一眼能看出是还没侦察、
 * 还是都被人占了、还是太远。
 */
function remoteText(room: Room): string {
  const remotes = room.memory.remotes ?? [];
  const lines = [`${room.name} 外矿 ${remotes.length} 个`];

  for (const name of remotes) {
    const memory = Memory.rooms[name];
    const count = Object.keys(memory?.sources ?? {}).length;
    const state = isRemotePaused(name) ? "遇袭冷却中" : "采集中";
    const left = reserveLeft(name);
    // 容量写出来是因为这直接决定了矿工体型和运输队人数
    const reserve = left > 0 ? `已预定 剩 ${left} tick 源 3000 容量` : "未预定 源 1500 容量";
    lines.push(`  ${name} 源 ${count} 个 ${state} ${reserve}`);

    const breach = memory?.breach;
    if (breach) {
      lines.push(
        breach.wall
          ? `    控制器被墙封住：拆 ${breach.walls} 段共 ${breach.hits} 血，从 (${breach.wall.x},${breach.wall.y}) 开刀`
          : "    控制器被岩石隔开，拆墙也进不去，只能不预定"
      );
    }
  }

  lines.push("邻房");
  for (const name of Object.values(Game.map.describeExits(room.name) ?? {})) {
    if (!name) continue;

    const memory = Memory.rooms[name];
    if (!memory?.scouted) {
      lines.push(`  ${name} 未侦察`);
      continue;
    }

    const count = Object.keys(memory.sources ?? {}).length;
    const verdict = memory.unusable ?? (remotes.includes(name) ? "已启用" : "可用");
    lines.push(`  ${name} 源 ${count} 个 ${verdict}`);
  }

  return lines.join("\n");
}

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
  g.flaghelp = () => COMMANDS.flaghelp.run();
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
  g.load = (room?: string) => COMMANDS.load.run(room ?? "");
  g.logistics = (room?: string) => COMMANDS.logistics.run(room ?? "");

  // remote 既能直接调用又挂着子命令，函数上挂属性是控制台里最顺手的写法
  const remote = (room?: string) => COMMANDS.remote.run(room ?? "");
  remote.add = (target: string, room?: string) => COMMANDS["remote.add"].run(target, room ?? "");
  remote.drop = (target: string, room?: string) => COMMANDS["remote.drop"].run(target, room ?? "");
  g.remote = remote;
  g.rescout = (target?: string) => COMMANDS.rescout.run(target ?? "");

  const expand = (target?: string, room?: string) => COMMANDS.expand.run(target ?? "", room ?? "");
  expand.cancel = (room?: string) => COMMANDS["expand.cancel"].run(room ?? "");
  g.expand = expand;

  const loot = (target?: string, room?: string) => COMMANDS.loot.run(target ?? "", room ?? "");
  loot.stop = (room?: string) => COMMANDS["loot.stop"].run(room ?? "");
  loot.scan = (target: string) => COMMANDS["loot.scan"].run(target);
  g.loot = loot;
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
  return [
    "harvester",
    "upgrader",
    "builder",
    "miner",
    "hauler",
    "defender",
    "scout",
    "remoteMiner",
    "remoteHauler",
    "reserver",
    "dismantler",
    "claimer",
    "pioneer",
    "looter"
  ].includes(value);
}

/**
 * 查进度时不写房间名，就找那个正在干这件事的房间。
 *
 * 有第二个房间之后，"不写就用唯一那个"立刻失效了，每条命令都要补上房间名——
 * 而 expand() 和 loot() 这类查进度的命令本来只有一个房间在做，让人再敲一遍
 * 房间名纯属白费。只有真出现两个房间同时在做同一件事时才要求写明。
 */
function resolveDirective(roomName: string | undefined, active: (room: Room) => boolean): Room | string {
  if (roomName) return resolveRoom(roomName);

  const doing = Object.values(Game.rooms).filter(room => room.controller?.my && active(room));
  if (doing.length === 1) return doing[0];

  return resolveRoom(roomName);
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
