import { assert } from "chai";
import { BUNKER_STRUCTURES, FIRST_SPAWN_OFFSET } from "../../src/planner/bunkerLayout";
import { canPlaceBunker, rankAnchors, structuresForLevel } from "../../src/planner/bunkerPlanner";
import {
  ROOM_SIZE,
  TERRAIN_PLAIN,
  TERRAIN_WALL,
  UNREACHABLE,
  decodeTerrain,
  distanceTransform,
  walkingDistanceFrom
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

  it("锚点排序把总路程最短的排在最前", () => {
    const terrain = emptyRoom();
    const targets = [
      { x: 20, y: 20 },
      { x: 30, y: 30 }
    ];

    const ranked = rankAnchors(terrain, targets);

    assert.isAbove(ranked.length, 0);
    for (let i = 1; i < ranked.length; i++) {
      assert.isAtMost(ranked[i - 1].cost, ranked[i].cost, "结果必须按总路程升序");
    }
    // creep 能斜着走，两点相距 10 步，落在连线上的锚点总路程就等于这 10 步
    assert.equal(ranked[0].cost, 10);
  });

  it("全是墙的房间找不到任何锚点", () => {
    const terrain = new Uint8Array(ROOM_SIZE * ROOM_SIZE).fill(TERRAIN_WALL);
    assert.deepEqual(rankAnchors(terrain, [{ x: 25, y: 25 }]), []);
  });
});
