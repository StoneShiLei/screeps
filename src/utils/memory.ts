/**
 * Memory 清理。
 *
 * creep 死了、房间丢了，Memory 里的记录都不会自动消失，不清就一直堆着，
 * 而 Memory 是按序列化后的长度收费的。
 *
 * 主循环每 tick 跑一遍，控制台的 cleanup 命令也用同一份实现——两处各写一遍的
 * 结果一定是某天改了一处忘了另一处，然后手动清理把外矿记录清掉了。
 */

/** 清掉已死 creep 的记录，返回清了几条 */
export function cleanupCreepMemory(): number {
  let removed = 0;

  for (const name in Memory.creeps) {
    if (!(name in Game.creeps)) {
      delete Memory.creeps[name];
      removed++;
    }
  }

  return removed;
}

/**
 * 清掉已经和自己无关的房间记录，比如 respawn 之后的旧家，返回清了几条。
 *
 * 不能只看"现在有没有视野"：外矿和邻房绝大多数时候是没视野的，而那份记录
 * 恰恰是派人出门的前提。外矿的能量源位置删了就得重新侦察；邻房"这里被人占了"
 * 的结论删了，几百 tick 后侦察兵会再跑一趟把同一件事重新发现一遍。
 */
export function cleanupRoomMemory(): number {
  const neighbours = ownedNeighbours();
  let removed = 0;

  for (const name in Memory.rooms) {
    if (Game.rooms[name]?.controller?.my) continue;
    if (neighbours.has(name) && Memory.rooms[name].scouted !== undefined) continue;

    const home = Memory.rooms[name].home;
    if (home && Game.rooms[home]?.controller?.my) continue;

    delete Memory.rooms[name];
    removed++;
  }

  return removed;
}

/** 己方房间的全部邻房，它们的侦察记录值得留着 */
function ownedNeighbours(): Set<string> {
  const result = new Set<string>();

  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;

    for (const name of Object.values(Game.map.describeExits(room.name) ?? {})) {
      if (name) result.add(name);
    }
  }

  return result;
}
