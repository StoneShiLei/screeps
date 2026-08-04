/**
 * 孵化管理：维持每个房间的 creep 数量。
 * 目前只管 harvester，后面加新角色时在这里扩展配额表即可。
 */

/** 每个房间期望的 harvester 数量 */
const HARVESTER_TARGET = 4;

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

  const harvesters = countCreeps(room, "harvester");
  if (harvesters >= HARVESTER_TARGET) return;

  spawnHarvester(idleSpawn, harvesters === 0);
}

function spawnHarvester(spawn: StructureSpawn, isEmergency: boolean): void {
  const room = spawn.room;
  // 正常情况按房间上限造尽量大的 creep；房间里一个 harvester 都不剩时，
  // 能量填不满 extension，只能用当前可用能量造个小的先把生产链救活。
  const budget = isEmergency ? room.energyAvailable : room.energyCapacityAvailable;
  const body = buildWorkerBody(budget);
  const name = `harvester_${Game.time}`;

  const result = spawn.spawnCreep(body, name, {
    memory: { role: "harvester", room: room.name, working: false }
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

function countCreeps(room: Room, role: CreepRole): number {
  return Object.values(Game.creeps).filter(creep => creep.memory.role === role && creep.memory.room === room.name)
    .length;
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
