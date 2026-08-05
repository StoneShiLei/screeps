/**
 * 房间通行代价矩阵。
 *
 * 存在的首要理由是让 creep 认路。PathFinder 默认平地 1、沼泽 5，road 没有任何
 * 折扣——走路和走平地一样贵，creep 就不会为了踩上去多绕一步，几百点能量铺的路
 * 等于白铺。这里把平地抬到 2、沼泽抬到 10，road 保持 1，路的优势才真正成立。
 *
 * 矩阵只描述地形和建筑，不含 creep。把 creep 画进去会让路径每 tick 都变，
 * 缓存全废，而且绕开同伴几乎总是比等它让开更亏——避让是交通层的事。
 */

/** road 上移动只要 1 点疲劳，代价定为 1 是基准 */
const ROAD_COST = 1;

/** 平地定 2 而不是 1，是为了让 road 有一半的折扣可拿 */
const PLAIN_COST = 2;

/** 沼泽实际是平地的 5 倍，按同样比例放大 */
const SWAMP_COST = 10;

/**
 * 缓存最多留这么多 tick。
 *
 * 建筑数量指纹能抓到造好和拆掉，抓不到工地转成建筑这种数量不变的情况，
 * 所以再加一道时间兜底。几十 tick 的偏差对寻路无关紧要。
 */
const MAX_CACHE_AGE = 100;

interface CachedMatrix {
  matrix: CostMatrix;
  tick: number;
  fingerprint: number;
}

/** 放在模块级而不是 Memory：纯计算结果，global 重置了重算一遍就是了 */
const cache: Record<string, CachedMatrix> = {};

export function costMatrixFor(room: Room): CostMatrix {
  const fingerprint = fingerprintOf(room);
  const cached = cache[room.name];

  if (cached && cached.fingerprint === fingerprint && Game.time - cached.tick < MAX_CACHE_AGE) {
    return cached.matrix;
  }

  const matrix = buildMatrix(room);
  cache[room.name] = { matrix, tick: Game.time, fingerprint };
  return matrix;
}

/**
 * 建筑或工地一有增减就重算。
 *
 * 只数个数不比较位置：数量不变而位置变化的情况只有"拆一个同时建一个"，
 * 罕见到不值得为它每 tick 遍历一遍全房间做哈希。
 */
function fingerprintOf(room: Room): number {
  return room.find(FIND_STRUCTURES).length * 1000 + room.find(FIND_CONSTRUCTION_SITES).length;
}

function buildMatrix(room: Room): CostMatrix {
  const matrix = new PathFinder.CostMatrix();
  const terrain = room.getTerrain();

  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < 50; x++) {
      const tile = terrain.get(x, y);
      if (tile === TERRAIN_MASK_WALL) continue; // 墙用默认的 255，不用显式写
      matrix.set(x, y, tile === TERRAIN_MASK_SWAMP ? SWAMP_COST : PLAIN_COST);
    }
  }

  for (const structure of room.find(FIND_STRUCTURES)) {
    applyStructure(matrix, structure.structureType, structure.pos, isWalkableRampart(structure));
  }

  // 自己的工地也要绕开：站在上面会挡住 builder，而且建成的一瞬间就成了障碍
  for (const site of room.find(FIND_MY_CONSTRUCTION_SITES)) {
    applyStructure(matrix, site.structureType, site.pos, false);
  }

  return matrix;
}

function applyStructure(
  matrix: CostMatrix,
  type: StructureConstant,
  pos: RoomPosition,
  walkableRampart: boolean
): void {
  if (type === STRUCTURE_ROAD) {
    // 路上盖着别的建筑时不能因为有路就当它能走，而 find 返回的顺序是不保证的，
    // 所以这里让障碍优先，两种遍历顺序结果都一样
    if (matrix.get(pos.x, pos.y) === 255) return;

    // 路铺在沼泽上时这一步最关键：把 10 降到 1，creep 才肯从沼泽里绕上来
    matrix.set(pos.x, pos.y, ROAD_COST);
    return;
  }

  // 容器可以站人，矿工就站在上面挖；己方 rampart 底下也能过
  if (type === STRUCTURE_CONTAINER || walkableRampart) return;

  matrix.set(pos.x, pos.y, 255);
}

function isWalkableRampart(structure: Structure): boolean {
  return structure.structureType === STRUCTURE_RAMPART && (structure as StructureRampart).my;
}
