/**
 * 孵化管理：维持每个房间各类 creep 的数量。
 * 加新角色时，改 CREEP_QUOTA 和 SPAWN_PRIORITY 两张表就够了。
 */

/** 每个房间期望的各角色数量 */
const CREEP_QUOTA: Record<CreepRole, number> = {
  harvester: 3,
  upgrader: 3
};

/**
 * 缺人时的补充顺序。harvester 排在最前面，
 * 因为没有它往 spawn 里送能量，后面谁都孵化不出来。
 */
const SPAWN_PRIORITY: CreepRole[] = ["harvester", "upgrader"];

/** 一组 [WORK, CARRY, MOVE] 的造价 */
const BODY_UNIT_COST = 200;

/** 体型最多重复几组，避免 creep 太大导致孵化时间过长 */
const MAX_BODY_UNITS = 3;

export function runSpawnManager(room: Room): void {
  const spawns = room.find(FIND_MY_SPAWNS);
  if (spawns.length === 0) return;

  showSpawningProgress(spawns);

  const idleSpawn = spawns.find(spawn => !spawn.spawning);
  if (!idleSpawn) return;

  const counts = countByRole(room);
  const role = SPAWN_PRIORITY.find(candidate => counts[candidate] < CREEP_QUOTA[candidate]);
  if (!role) return;

  spawnCreep(idleSpawn, role, counts.harvester === 0);
}

function spawnCreep(spawn: StructureSpawn, role: CreepRole, isEmergency: boolean): void {
  const room = spawn.room;
  // 正常情况按房间能量上限造尽量大的 creep；房间里一个 harvester 都不剩时，
  // 没人往 extension 填能量，只能用当前可用能量造个小的先把生产链救活。
  const budget = isEmergency ? room.energyAvailable : room.energyCapacityAvailable;
  const body = buildWorkerBody(budget);
  const name = `${role}_${Game.time}`;

  const result = spawn.spawnCreep(body, name, {
    memory: { role, room: room.name, working: false }
  });

  if (result === OK) {
    console.log(`[${room.name}] 孵化 ${name}，体型 ${body.length} 部件${isEmergency ? "（应急）" : ""}`);
  }
}

function buildWorkerBody(energyBudget: number): BodyPartConstant[] {
  const units = Math.max(1, Math.min(MAX_BODY_UNITS, Math.floor(energyBudget / BODY_UNIT_COST)));

  const body: BodyPartConstant[] = [];
  for (let i = 0; i < units; i++) {
    body.push(WORK, CARRY, MOVE);
  }
  return body;
}

function countByRole(room: Room): Record<CreepRole, number> {
  const counts: Record<CreepRole, number> = { harvester: 0, upgrader: 0 };

  for (const creep of Object.values(Game.creeps)) {
    if (creep.memory.room !== room.name) continue;
    // 旧版本代码留下的 creep 可能带着已经不存在的角色名
    if (creep.memory.role in counts) counts[creep.memory.role]++;
  }

  return counts;
}

function showSpawningProgress(spawns: StructureSpawn[]): void {
  for (const spawn of spawns) {
    if (!spawn.spawning) continue;
    spawn.room.visual.text(`孵化中 ${spawn.spawning.name}`, spawn.pos.x + 1, spawn.pos.y, {
      align: "left",
      opacity: 0.7
    });
  }
}
