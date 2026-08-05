import { evade, reportThreat, runDefender } from "roles/defender";
import { ErrorMapper } from "utils/ErrorMapper";
import { announce } from "utils/logger";
import { drawRoomPanel } from "managers/panel";
import { installCommands } from "cli/commands";
import { runBuilder } from "roles/builder";
import { runHarvester } from "roles/harvester";
import { runHauler } from "roles/hauler";
import { runMiner } from "roles/miner";
import { runRoomPlanner } from "planner/roomPlanner";
import { runSpawnManager } from "managers/spawnManager";
import { runTowers } from "managers/tower";
import { runTraffic } from "movement/traffic";
import { runUpgrader } from "roles/upgrader";
import { visualizeLogistics } from "managers/logistics";

// 控制台命令注册一次即可；global 重置时模块会重新加载，命令自动回来
installCommands();

// ErrorMapper 用 source map 把报错行号还原成 TypeScript 源码的位置，
// 否则游戏控制台里显示的都是打包后 main.js 的行号。
export const loop = ErrorMapper.wrapLoop(() => {
  cleanupCreepMemory();
  cleanupRoomMemory();

  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    // 只处理自己占领的房间，路过的、侦查到的房间先忽略
    if (!room.controller || !room.controller.my) continue;
    reportThreat(room);
    runTowers(room);
    runSpawnManager(room);
    runRoomPlanner(room);
  }

  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    if (creep.spawning) continue;

    if (creep.memory.role === "defender") {
      runDefender(creep);
      continue;
    }

    // 没塔的时候平民遇敌先跑，跑的这几 tick 什么活都不干
    if (evade(creep)) continue;

    switch (creep.memory.role) {
      case "harvester":
        runHarvester(creep);
        break;
      case "miner":
        runMiner(creep);
        break;
      case "hauler":
        runHauler(creep);
        break;
      case "upgrader":
        runUpgrader(creep);
        break;
      case "builder":
        runBuilder(creep);
        break;
      default:
        announce(creep, "无角色");
    }
  }

  // creep 在上面只登记了想去哪，这里才统一决定谁真的能动。
  // 必须等所有角色跑完，否则收不齐意图，就换不成位置。
  runTraffic();

  // 放在 creep 行动之后画，这样连线反映的是本 tick 最新的任务认领
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;
    visualizeLogistics(room);
    drawRoomPanel(room);
  }
});

/** creep 死亡后 Memory 不会自动清理，不处理会一直堆积 */
function cleanupCreepMemory(): void {
  for (const name in Memory.creeps) {
    if (!(name in Game.creeps)) {
      delete Memory.creeps[name];
    }
  }
}

/**
 * 丢掉已经不属于自己的房间的记录，比如 respawn 之后的旧家。
 *
 * 自己占领的房间一定有视野，所以在 Game.rooms 里找不到就是真的没了。
 * 以后要记录外派采集的房间时，这里得改成白名单判断。
 */
function cleanupRoomMemory(): void {
  for (const name in Memory.rooms) {
    if (!Game.rooms[name]?.controller?.my) {
      delete Memory.rooms[name];
    }
  }
}
