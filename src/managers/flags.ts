/**
 * 旗子指令：在地图上插一面旗，代替敲一条控制台命令。
 *
 * 控制台命令要写房间名，而房间名恰恰是看着地图最不方便打出来的东西——你正指着
 * 那个房间，却要把它的名字念出来再敲进去。插旗把"指哪儿"和"干什么"合成了一个
 * 动作，而且不用管由谁承接：就近的己方房间自己会认领。
 *
 * 旗子是一次性的开关，不是状态。任务真正的记录在 Memory 里（`RoomMemory.expansion`、
 * `loot`、`remotes`），派完活旗子就删掉——留着的话它和 Memory 会各说一套，
 * 而两份状态迟早对不上。想看任务进度用 expand() / loot() / remote()。
 */

import { REMOTE_MIN_LEVEL, enableRemote } from "./remote";
import { log } from "../utils/logger";
import { startExpansion } from "./expansion";
import { startLoot } from "./loot";

interface FlagDirective {
  /** 旗子名以此开头就算这条指令，大小写不敏感 */
  prefix: string;
  describe: string;
  /** 返回一行说明写进日志；返回 undefined 表示条件不满足、旗子留着下次再试 */
  apply: (home: Room, target: string) => string | undefined;
  /**
   * 怎么挑承接的房间。外矿必须找开得起外矿的家，不能让旁边 RCL1 分房把名单抢走。
   */
  pickHome?: (target: string) => Room | undefined;
}

const DIRECTIVES: FlagDirective[] = [
  {
    prefix: "claim",
    describe: "占领这个房间当分房，就近的家出人",
    apply: (home, target) => startExpansion(home, target)
  },
  {
    prefix: "loot",
    describe: "把这个房间里前人留下的仓库搬空",
    apply: (home, target) => startLoot(home, target)
  },
  {
    prefix: "remote",
    describe: "把这个房间加进外矿名单（被别人预定的会派预定员去抢；被占领的加不了）",
    apply: (home, target) => addRemote(home, target),
    pickHome: nearestRemoteHome
  }
];

/**
 * 布局旗不在这里处理。
 *
 * 它和上面三条不是一类东西：那三条是"下达一次任务"，插完就该消失；布局旗是
 * 常驻的显示开关，拔掉才停。规划器自己每 tick 找它。
 */
const VIEWER_PREFIX = "plan";

export function runFlagDirectives(): void {
  for (const flag of Object.values(Game.flags)) {
    const directive = DIRECTIVES.find(candidate => flag.name.toLowerCase().startsWith(candidate.prefix));
    if (!directive) continue;

    const home = (directive.pickHome ?? nearestHome)(flag.pos.roomName);
    if (!home) {
      log.warn("旗子", `${flag.name} 在 ${flag.pos.roomName}，但附近没有己方房间能接这个活`);
      flag.remove();
      continue;
    }

    const result = directive.apply(home, flag.pos.roomName);
    if (result === undefined) continue;

    log.info("旗子", `${flag.name} → ${result}`);
    flag.remove();
  }
}

/**
 * 离目标最近的己方房间。
 *
 * 用地图上的直线房间距离而不是实际路程：路程要跨房间寻路，而这个判断每次插旗
 * 只做一次，多算的那点精度换不来什么——真正远得该换人接的情况，直线距离也看得出来。
 */
function nearestHome(target: string): Room | undefined {
  return pickNearest(target, () => true);
}

/**
 * 离目标最近、且开得起外矿的己方房间。
 *
 * E27S36 那种贴着新分房的外矿，若只按距离认领，会被 RCL1 的分房抢走名单——
 * 分房自己造不出远程矿工，主家又看不见，表现为"插了旗开不起外矿"。
 */
function nearestRemoteHome(target: string): Room | undefined {
  return pickNearest(target, room => (room.controller?.level ?? 0) >= REMOTE_MIN_LEVEL);
}

function pickNearest(target: string, accept: (room: Room) => boolean): Room | undefined {
  let best: Room | undefined;
  let bestDistance = Infinity;

  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my || !accept(room)) continue;

    const distance = Game.map.getRoomLinearDistance(room.name, target);
    if (distance < bestDistance) {
      best = room;
      bestDistance = distance;
    }
  }

  return best;
}

/**
 * 手动加外矿。
 *
 * 和自动挑选的区别：越过评分，指定一个具体房间。被别人预定的也收——那是抢预定
 * 的目标，预定员会去磨掉对方的预定再反手预定；被别人占领 / keeper / core / 没源
 * 的仍拒绝，那种不是预定员能搞定的。
 *
 * 返回 undefined 表示条件还不成熟、旗子留着下次再试（比如还没侦察过）。
 * 其他情况都返回说明文字并烧掉旗子——任务已经记进 Memory，旗子留着只会两套状态打架。
 */
function addRemote(home: Room, target: string): string | undefined {
  const memory = Memory.rooms[target];
  // 没侦察过就留着旗：scout 探完下一 tick 再兑现，别一把火把用户的意图烧了
  if (!memory?.scouted) return undefined;
  // reserved 放行：名单收下、派预定员去抢；其它 unusable 硬碰硬打不过
  if (memory.unusable && memory.unusable !== "reserved") {
    return `${target} 采不了：${memory.unusable}`;
  }

  const remotes = home.memory.remotes ?? [];
  if (remotes.includes(target) && memory.home === home.name) {
    return memory.unusable === "reserved"
      ? `${target} 已经在 ${home.name} 的外矿名单里（抢预定中）`
      : `${target} 已经在 ${home.name} 的外矿名单里`;
  }

  enableRemote(home, target);
  const list = (home.memory.remotes ?? []).join(" ");
  return memory.unusable === "reserved"
    ? `${home.name} 外矿名单 → ${list}（${target} 被别人预定，派预定员去抢）`
    : `${home.name} 外矿名单 → ${list}`;
}

/** 控制台的 flaghelp 用这张表生成说明，不手写第二份 */
export function flagHelpText(): string {
  const lines = DIRECTIVES.map(directive => `  ${directive.prefix.padEnd(8)} ${directive.describe}`);

  return [
    "在目标房间插一面旗，名字以下面的前缀开头即可（大小写不敏感，后面可以随便跟别的字）：",
    ...lines,
    `  ${VIEWER_PREFIX.padEnd(8)} 显示这个房间的建筑布局（常驻，拔掉才停）`,
    "",
    "承接的房间不用指定：离得最近的己方房间会自己认领。派完活旗子会自动消失，",
    "任务进度用 expand() / loot() / remote() 查。"
  ].join("\n");
}
