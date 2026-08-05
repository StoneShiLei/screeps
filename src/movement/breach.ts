/**
 * 挡路的墙：够不着目标的时候，拆哪一段最省。
 *
 * 外矿房间里常有前人废弃的基地。他们当年为了防守把控制器所在的那片凹地封了起来，
 * 人走了墙还在——中立房间的墙既不衰减也没人修，就那么永久堵着。预定员走到墙外
 * 两格就再也过不去，PathFinder 这时返回的是"尽力靠近"的半成品路径，于是它站在
 * 石头边上把 600 tick 的寿命耗完，一句报错都没有。
 *
 * 这里换一种问法：不问"走不走得通"，而问"愿意拆的话最少要砸掉多少血量"。把墙当成
 * 能过但很贵的格子跑一遍寻路，代价最低的那条路自然就是最省力的爆破方案，路上第一
 * 段墙就是该派人去拆的目标。
 */

/**
 * 血量换算成通行代价的比例。
 *
 * CostMatrix 每格上限 254，除以一千正好能表示到 25 万血；再厚的墙一律按最贵算，
 * 反正那种厚度已经超出值得拆的范围了。
 *
 * 除法而不是一律给个固定高价，是为了让寻路自己挑薄的那段：几百格的绕路
 * 也比多砸十万血便宜。
 */
const HITS_PER_COST = 1000;

/** 墙的代价上限，留 1 给"踩上去"本身 */
const MAX_WALL_COST = 253;

/** 房内搜索的算力上限。绕整个房间也就几千 ops，给足一点免得又拿到半成品 */
const MAX_OPS = 6000;

export interface BreachPlan {
  /** 路上第一段挡路的墙，先拆它 */
  wall: Structure;
  /** 这条路上所有墙的血量总和，用来判断值不值得动手 */
  hits: number;
  /** 要拆几段 */
  walls: number;
}

/**
 * 从 from 走到 target 附近，最省的爆破方案。
 *
 * 返回 undefined 有两种情况：路本来就通（那就不该调这个函数），或者连拆墙都到不了
 * （目标那片地方被天然岩石彻底隔开，只能从别的房间绕进去）。两种都不该派拆迁工。
 */
export function planBreach(from: RoomPosition, target: RoomPosition, range = 1): BreachPlan | undefined {
  const room = Game.rooms[target.roomName];
  if (!room) return undefined;

  const result = PathFinder.search(
    from,
    { pos: target, range },
    {
      plainCost: 2,
      swampCost: 10,
      maxOps: MAX_OPS,
      // 只在本房间里想办法。跨房绕行是另一回事：那条路可能要穿三个房间，
      // 而带 CLAIM 的 creep 只活 600 tick，走到就该死了
      maxRooms: 1,
      roomCallback: () => breachMatrix(room)
    }
  );

  if (result.incomplete) return undefined;

  const walls: Structure[] = [];
  let hits = 0;

  for (const step of result.path) {
    const wall = breachableAt(room, step);
    if (!wall) continue;

    walls.push(wall);
    hits += wall.hits;
  }

  if (walls.length === 0) return undefined;

  return { wall: walls[0], hits, walls: walls.length };
}

/**
 * 和平时寻路用的矩阵同一套地形，唯一区别是墙不再是死路。
 *
 * 不复用 costMatrixFor 的缓存：那份矩阵把墙标成 255，是全房间寻路的公共依据，
 * 在上面改一格会污染所有人的路。这个函数一百 tick 才调一次，重算得起。
 */
function breachMatrix(room: Room): CostMatrix {
  const matrix = new PathFinder.CostMatrix();
  const terrain = room.getTerrain();

  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < 50; x++) {
      const tile = terrain.get(x, y);
      if (tile === TERRAIN_MASK_WALL) continue;
      matrix.set(x, y, tile === TERRAIN_MASK_SWAMP ? 10 : 2);
    }
  }

  for (const structure of room.find(FIND_STRUCTURES)) {
    const { x, y } = structure.pos;

    if (isBreachable(structure)) {
      matrix.set(x, y, 1 + Math.min(MAX_WALL_COST, Math.ceil(structure.hits / HITS_PER_COST)));
      continue;
    }

    if (structure.structureType === STRUCTURE_ROAD) {
      if (matrix.get(x, y) !== 255) matrix.set(x, y, 1);
      continue;
    }

    if (structure.structureType === STRUCTURE_CONTAINER) continue;

    matrix.set(x, y, 255);
  }

  return matrix;
}

function breachableAt(room: Room, pos: RoomPosition): Structure | undefined {
  return room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y).find(isBreachable);
}

/**
 * 拆得动的东西。
 *
 * 只认墙和 rampart：别人的 extension、storage 之类拆了也不通路（拆一个还有一片），
 * 而且那属于打人家基地，不是开条路过去。
 */
function isBreachable(structure: Structure): boolean {
  return structure.structureType === STRUCTURE_WALL || structure.structureType === STRUCTURE_RAMPART;
}

/** 这段墙还在不在。拆完了、或者被别人拆了，记录就该作废 */
export function wallStillThere(roomName: string, spot: { x: number; y: number }): Structure | undefined {
  const room = Game.rooms[roomName];
  if (!room) return undefined;

  return room.lookForAt(LOOK_STRUCTURES, spot.x, spot.y).find(isBreachable);
}
