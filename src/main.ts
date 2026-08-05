import { cleanupCreepMemory, cleanupRoomMemory } from "utils/memory";
import { evade, reportThreat, runDefender } from "roles/defender";
import { runRemoteManager, watchRemote } from "managers/remote";
import { ErrorMapper } from "utils/ErrorMapper";
import { announce } from "utils/logger";
import { drawRoomPanel } from "managers/panel";
import { installCommands } from "cli/commands";
import { runBuilder } from "roles/builder";
import { runDismantler } from "roles/dismantler";
import { runHarvester } from "roles/harvester";
import { runHauler } from "roles/hauler";
import { runMiner } from "roles/miner";
import { runRemoteHauler } from "roles/remoteHauler";
import { runRemoteMiner } from "roles/remoteMiner";
import { runReserver } from "roles/reserver";
import { runRoomPlanner } from "planner/roomPlanner";
import { runScout } from "roles/scout";
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
    if (!room.controller || !room.controller.my) {
      // 有视野的外矿房间只做观察：敌情和归属变化要趁有人在场时记下来
      watchRemote(room);
      continue;
    }

    reportThreat(room);
    runTowers(room);
    // 名单要在孵化之前定好，配额是照名单算的
    runRemoteManager(room);
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
      case "scout":
        runScout(creep);
        break;
      case "remoteMiner":
        runRemoteMiner(creep);
        break;
      case "remoteHauler":
        runRemoteHauler(creep);
        break;
      case "reserver":
        runReserver(creep);
        break;
      case "dismantler":
        runDismantler(creep);
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
