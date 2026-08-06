// 只能用游戏的全局 API 和我们挂在 global 上的 CLI 命令：打包之后整份代码是
// 一个 main.js，游戏里 require("managers/xxx") 那种路径并不存在。
const home = Game.rooms.E28S36;
const spawn = home.find(FIND_MY_SPAWNS)[0];
const colony = Game.rooms.E28S35;

Memory.probe = {
  energy: home.energyAvailable + "/" + home.energyCapacityAvailable,
  spawning: spawn.spawning ? spawn.spawning.name : "空闲",
  pop: quota("E28S36"),
  load: load("E28S36"),
  expansion: expand(),
  loot: loot(),
  colony: colony
    ? {
        level: colony.controller.level,
        my: colony.controller.my,
        sites: colony.find(FIND_MY_CONSTRUCTION_SITES).length,
        intruders: colony.find(FIND_HOSTILE_CREEPS).length,
        hostileStructures: colony.find(FIND_HOSTILE_STRUCTURES).length
      }
    : "无视野"
};
