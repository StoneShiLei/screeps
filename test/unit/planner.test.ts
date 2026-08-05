import { assert } from "chai";
import { BUNKER_STRUCTURES, FIRST_SPAWN_OFFSET } from "../../src/planner/bunkerLayout";
import { canPlaceBunker, isBunkerCell, rankAnchors, structuresForLevel } from "../../src/planner/bunkerPlanner";
import { planOutposts } from "../../src/planner/outposts";
import { unlockLevel } from "../../src/planner/roomPlanner";
import {
  ROOM_SIZE,
  TERRAIN_PLAIN,
  TERRAIN_SWAMP,
  TERRAIN_WALL,
  UNREACHABLE,
  countOpenSpots,
  decodeTerrain,
  distanceTransform,
  walkingDistanceFrom,
  weightedDistanceFrom
} from "../../src/planner/terrain";

/** 造一个全是平原的房间，方便单独验证某几格墙的影响 */
function emptyRoom(): Uint8Array {
  return new Uint8Array(ROOM_SIZE * ROOM_SIZE).fill(TERRAIN_PLAIN);
}

function setWall(terrain: Uint8Array, x: number, y: number): void {
  terrain[y * ROOM_SIZE + x] = TERRAIN_WALL;
}

describe("地形分析", () => {
  it("解析地形串时把墙和沼泽区分开", () => {
    const encoded = "0120".padEnd(ROOM_SIZE * ROOM_SIZE, "0");
    const terrain = decodeTerrain(encoded);

    assert.equal(terrain[0], 0, "0 应该是平原");
    assert.equal(terrain[1], 1, "1 应该是墙");
    assert.equal(terrain[2], 2, "2 应该是沼泽");
  });

  it("距离变换把房间外沿当作墙", () => {
    const dt = distanceTransform(emptyRoom());

    assert.equal(dt[0], 1, "贴着边界的格子离墙 1 步");
    // 中心到最近边界是 25 格
    assert.equal(dt[25 * ROOM_SIZE + 25], 25);
  });

  it("距离变换正确反映单个墙块的影响", () => {
    const terrain = emptyRoom();
    setWall(terrain, 10, 10);
    const dt = distanceTransform(terrain);

    assert.equal(dt[10 * ROOM_SIZE + 10], 0, "墙自身是 0");
    assert.equal(dt[11 * ROOM_SIZE + 11], 1, "紧邻墙的格子是 1（斜向也算相邻）");
    assert.equal(dt[13 * ROOM_SIZE + 10], 3);
  });

  it("距离变换的值等于该点能容纳的最大方块半径", () => {
    const terrain = emptyRoom();
    // 围出一个 9x9 的空腔：中心 (25,25)，四周墙在距离 5 处
    for (let i = 20; i <= 30; i++) {
      setWall(terrain, i, 20);
      setWall(terrain, i, 30);
      setWall(terrain, 20, i);
      setWall(terrain, 30, i);
    }

    const dt = distanceTransform(terrain);
    assert.equal(dt[25 * ROOM_SIZE + 25], 5, "半径 5 表示能放下 9x9");
  });

  it("广度优先搜索绕开墙壁计算步数", () => {
    const terrain = emptyRoom();
    const distance = walkingDistanceFrom(terrain, 10, 10);

    assert.equal(distance[10 * ROOM_SIZE + 10], 0);
    assert.equal(distance[10 * ROOM_SIZE + 15], 5, "同一行 5 格就是 5 步");
    assert.equal(distance[15 * ROOM_SIZE + 15], 5, "斜着走 5 步就能到，不是 10 步");
  });

  it("踏进一格沼泽记 5 点，平原记 1 点", () => {
    const terrain = emptyRoom();
    terrain[10 * ROOM_SIZE + 11] = TERRAIN_SWAMP;

    const distance = weightedDistanceFrom(terrain, 10, 10);

    assert.equal(distance[10 * ROOM_SIZE + 11], 5, "从紧邻的起点踏进沼泽就是 5");
    assert.equal(distance[10 * ROOM_SIZE + 12], 2, "绕开那格沼泽只要两步平原");
  });

  it("走廊里躲不开沼泽时如实算进成本", () => {
    // 用墙夹出一条一格宽的走廊，中间嵌一格沼泽，逼着必须踩过去
    const terrain = new Uint8Array(ROOM_SIZE * ROOM_SIZE).fill(TERRAIN_WALL);
    for (let x = 10; x <= 14; x++) terrain[10 * ROOM_SIZE + x] = TERRAIN_PLAIN;
    terrain[10 * ROOM_SIZE + 12] = TERRAIN_SWAMP;

    const weighted = weightedDistanceFrom(terrain, 10, 10);
    const steps = walkingDistanceFrom(terrain, 10, 10);

    assert.equal(steps[10 * ROOM_SIZE + 14], 4, "只数格子是 4 步");
    assert.equal(weighted[10 * ROOM_SIZE + 14], 8, "中间那格沼泽把成本从 4 抬到 8");
  });

  it("数得清一个点周围能站几个人", () => {
    const terrain = emptyRoom();

    assert.equal(countOpenSpots(terrain, 25, 25), 8, "空地周围八格全能站");
    assert.equal(countOpenSpots(terrain, 0, 0), 3, "房间角上只剩三格");

    setWall(terrain, 24, 25);
    setWall(terrain, 26, 25);
    assert.equal(countOpenSpots(terrain, 25, 25), 6);
  });

  it("被墙完全封死的区域标记为不可达", () => {
    const terrain = emptyRoom();
    for (let d = -1; d <= 1; d++) {
      setWall(terrain, 4 + d, 4);
      setWall(terrain, 4 + d, 6);
      setWall(terrain, 4, 5 + d);
      setWall(terrain, 6, 5 + d);
    }
    // (5,5) 现在被一圈墙围住
    const distance = walkingDistanceFrom(terrain, 25, 25);
    assert.equal(distance[5 * ROOM_SIZE + 5], UNREACHABLE);
  });
});

describe("bunker 布局", () => {
  it("布局数据完整且各类建筑不超过游戏上限", () => {
    const counts = new Map<string, number>();
    for (const structure of BUNKER_STRUCTURES) {
      counts.set(structure.type, (counts.get(structure.type) ?? 0) + 1);
    }

    assert.equal(BUNKER_STRUCTURES.length, 128);
    assert.equal(counts.get("spawn"), 3, "RCL8 最多 3 个 spawn");
    assert.equal(counts.get("tower"), 6, "RCL8 最多 6 座塔");
    assert.equal(counts.get("lab"), 10, "RCL8 最多 10 个实验室");
    assert.isAtMost(counts.get("extension") ?? 0, 60, "extension 不能超过 60");
  });

  it("等级过滤是累加的，且一级只有一个 spawn", () => {
    const level1 = structuresForLevel(1);
    assert.equal(level1.length, 1);
    assert.equal(level1[0].type, "spawn");

    assert.isAtLeast(structuresForLevel(2).length, level1.length);
    assert.equal(structuresForLevel(8).length, BUNKER_STRUCTURES.length);
  });

  it("bunker 内部容器推迟到 storage 那一级，别的建筑不受影响", () => {
    const early = BUNKER_STRUCTURES.find(structure => structure.type === "container" && structure.rcl === 2);
    const late = BUNKER_STRUCTURES.find(structure => structure.type === "container" && structure.rcl === 7);

    assert.isDefined(early, "布局表里本来就有个 2 级的容器，覆盖逻辑就是为它写的");
    assert.equal(unlockLevel(early!), 4, "没有 storage 配合的容器建出来只会白白 decay");
    assert.equal(unlockLevel(late!), 7, "只推后不提前，7 级那个还是 7 级");
  });

  it("覆盖只作用于容器，其它建筑照布局表的等级", () => {
    for (const structure of BUNKER_STRUCTURES) {
      if (structure.type === "container") continue;
      assert.equal(unlockLevel(structure), structure.rcl, structure.type);
    }
  });

  it("第一个 spawn 的偏移与布局数据一致", () => {
    const firstSpawn = BUNKER_STRUCTURES.find(s => s.type === "spawn" && s.rcl === 1);

    assert.isDefined(firstSpawn);
    assert.equal(FIRST_SPAWN_OFFSET.dx, firstSpawn!.dx);
    assert.equal(FIRST_SPAWN_OFFSET.dy, firstSpawn!.dy);
  });

  it("空旷房间放得下 bunker，贴边则放不下", () => {
    const terrain = emptyRoom();

    assert.isTrue(canPlaceBunker(terrain, 25, 25));
    assert.isFalse(canPlaceBunker(terrain, 2, 25), "太靠近房间边缘");
  });

  it("bunker 占用的格子里有墙就放不下", () => {
    const terrain = emptyRoom();
    const somewhere = BUNKER_STRUCTURES[40];
    setWall(terrain, 25 + somewhere.dx, 25 + somewhere.dy);

    assert.isFalse(canPlaceBunker(terrain, 25, 25));
  });

  it("锚点排序把综合成本最低的排在最前", () => {
    const terrain = emptyRoom();
    const targets = [
      { x: 20, y: 20 },
      { x: 30, y: 30 }
    ];

    const ranked = rankAnchors(terrain, targets);

    assert.isAbove(ranked.length, 0);
    for (let i = 1; i < ranked.length; i++) {
      assert.isAtMost(ranked[i - 1].cost, ranked[i].cost, "结果必须按成本升序");
    }
    // creep 能斜着走，两点相距 10 步，落在连线上的锚点总路程就等于这 10 步；
    // 全平原房间没有沼泽惩罚，综合成本就等于步数
    assert.equal(ranked[0].steps, 10);
    assert.equal(ranked[0].cost, 10);
    assert.equal(ranked[0].swampCells, 0);
  });

  it("同样距离时优先选沼泽少的位置", () => {
    const terrain = emptyRoom();
    const target = { x: 25, y: 25 };

    const clean = rankAnchors(terrain, [target]);
    const cleanBest = clean[0];

    // 把最优位置整片糊上沼泽，它就该让位给别人
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        terrain[(cleanBest.y + dy) * ROOM_SIZE + cleanBest.x + dx] = TERRAIN_SWAMP;
      }
    }

    const polluted = rankAnchors(terrain, [target]);
    const stillThere = polluted.find(c => c.x === cleanBest.x && c.y === cleanBest.y);

    assert.isDefined(stillThere, "沼泽不影响能否建造，位置仍然有效");
    assert.isAbove(stillThere!.swampCells, 100, "整片沼泽应该被统计出来");
    assert.notDeepEqual(
      { x: polluted[0].x, y: polluted[0].y },
      { x: cleanBest.x, y: cleanBest.y },
      "泡在沼泽里的位置不该再是第一名"
    );
  });

  it("全是墙的房间找不到任何锚点", () => {
    const terrain = new Uint8Array(ROOM_SIZE * ROOM_SIZE).fill(TERRAIN_WALL);
    assert.deepEqual(rankAnchors(terrain, [{ x: 25, y: 25 }]), []);
  });
});

describe("外围落点", () => {
  const anchor = { x: 25, y: 25 };

  it("采集点紧贴能量源，并且挑靠基地的那一侧", () => {
    const source = { id: "s1", x: 35, y: 25 };
    const { miningSpots } = planOutposts(emptyRoom(), anchor, [source], { x: 25, y: 40 });

    const spot = miningSpots.s1;
    assert.isDefined(spot, "能量源旁边必须有落点，否则矿工没地方站");
    assert.isAtMost(Math.max(Math.abs(spot.x - source.x), Math.abs(spot.y - source.y)), 1, "站远了就挖不到");
    assert.equal(spot.x, 34, "八个候选里应该挑离基地最近的那个");
  });

  it("两个能量源不会抢同一格", () => {
    const sources = [
      { id: "a", x: 30, y: 25 },
      { id: "b", x: 32, y: 25 }
    ];
    const { miningSpots } = planOutposts(emptyRoom(), anchor, sources, { x: 25, y: 40 });

    assert.notDeepEqual(miningSpots.a, miningSpots.b);
  });

  it("被墙围住的能量源没有落点", () => {
    const terrain = emptyRoom();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx !== 0 || dy !== 0) setWall(terrain, 35 + dx, 25 + dy);
      }
    }

    const { miningSpots } = planOutposts(terrain, anchor, [{ id: "s1", x: 35, y: 25 }], { x: 25, y: 40 });
    assert.isUndefined(miningSpots.s1);
  });

  it("升级点落在控制器两格以内，站上去就够得着", () => {
    const controller = { x: 25, y: 40 };
    const { upgradeSpot } = planOutposts(emptyRoom(), anchor, [], controller);

    assert.isDefined(upgradeSpot);
    const range = Math.max(Math.abs(upgradeSpot!.x - controller.x), Math.abs(upgradeSpot!.y - controller.y));
    assert.isAtMost(range, 2, "超过两格的话，贴着容器的位置就可能够不到控制器");
    assert.isAbove(range, 0, "不能直接压在控制器身上");
  });

  it("升级站位都在容器一格以内，站上去就同时够得着两边", () => {
    const controller = { x: 25, y: 40 };
    const { upgradeSpot, upgradeStations } = planOutposts(emptyRoom(), anchor, [], controller);

    assert.isNotEmpty(upgradeStations);
    for (const station of upgradeStations) {
      const toContainer = Math.max(Math.abs(station.x - upgradeSpot!.x), Math.abs(station.y - upgradeSpot!.y));
      assert.isAtMost(toContainer, 1, "离容器远了就取不到货");

      const toController = Math.max(Math.abs(station.x - controller.x), Math.abs(station.y - controller.y));
      assert.isAtMost(toController, 3, "超过三格就够不着控制器，取了货也升不了级");
    }
  });

  it("容器自己那格也算一个站位", () => {
    const { upgradeSpot, upgradeStations } = planOutposts(emptyRoom(), anchor, [], { x: 25, y: 40 });

    assert.isTrue(
      upgradeStations.some(station => station.x === upgradeSpot!.x && station.y === upgradeSpot!.y),
      "容器不挡路，站上面取货距离算 0，白扔一个站位没道理"
    );
  });

  it("控制器自己那格站不了人", () => {
    const controller = { x: 25, y: 40 };
    const { upgradeStations } = planOutposts(emptyRoom(), anchor, [], controller);

    assert.isFalse(upgradeStations.some(station => station.x === controller.x && station.y === controller.y));
  });

  it("采集点不会被又算成升级站位", () => {
    const source = { id: "s1", x: 25, y: 38 };
    const { miningSpots, upgradeStations } = planOutposts(emptyRoom(), anchor, [source], { x: 25, y: 40 });

    const mining = miningSpots.s1;
    assert.isFalse(
      upgradeStations.some(station => station.x === mining.x && station.y === mining.y),
      "那是矿工的专座，升级工站上去矿工就没地方了"
    );
  });

  it("宁可离基地远一点，也要挑站得下人的位置", () => {
    const terrain = emptyRoom();
    // 把靠基地那一侧的落点围起来，只留一条缝
    for (const [x, y] of [
      [24, 37],
      [25, 37],
      [26, 37],
      [24, 38],
      [26, 38],
      [24, 39],
      [26, 39]
    ]) {
      setWall(terrain, x, y);
    }

    const { upgradeSpot, upgradeStations } = planOutposts(terrain, anchor, [], { x: 25, y: 40 });

    assert.isAtLeast(upgradeStations.length, 8, "挑个三面环墙的位置，等于给升级速度焊死一个上限");
    assert.notDeepEqual(upgradeSpot, { x: 25, y: 38 }, "省那几步脚程完全不够赔");
  });

  it("落点不会压到 bunker 的占地上", () => {
    // 把能量源摆在紧挨着基地的地方，逼着算法在 bunker 边缘挑格子
    const source = { id: "s1", x: anchor.x + 7, y: anchor.y };
    const { miningSpots } = planOutposts(emptyRoom(), anchor, [source], { x: 25, y: 40 });

    const spot = miningSpots.s1;
    assert.isDefined(spot);
    assert.isFalse(isBunkerCell(anchor.x, anchor.y, spot.x, spot.y), "压在 bunker 上会和基地建筑抢位置");
  });
});
