import { ErrorMapper } from "utils/ErrorMapper";
import { runBuilder } from "roles/builder";
import { runHarvester } from "roles/harvester";
import { runRoomPlanner } from "planner/roomPlanner";
import { runSpawnManager } from "managers/spawnManager";
import { runUpgrader } from "roles/upgrader";

// ErrorMapper 用 source map 把报错行号还原成 TypeScript 源码的位置，
// 否则游戏控制台里显示的都是打包后 main.js 的行号。
export const loop = ErrorMapper.wrapLoop(() => {
  cleanupCreepMemory();

  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    // 只处理自己占领的房间，路过的、侦查到的房间先忽略
    if (!room.controller || !room.controller.my) continue;
    runSpawnManager(room);
    runRoomPlanner(room);
  }

  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    if (creep.spawning) continue;

    switch (creep.memory.role) {
      case "harvester":
        runHarvester(creep);
        break;
      case "upgrader":
        runUpgrader(creep);
        break;
      case "builder":
        runBuilder(creep);
        break;
      default:
        creep.say("无角色");
    }
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
