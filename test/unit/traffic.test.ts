import { assert } from "chai";
import { holdPosition, requestMove, runTraffic } from "../../src/movement/traffic";

/** 方向常量 1..8，从正上方起顺时针一圈 */
const DIRECTIONS: Record<string, number> = {
  "0,-1": 1,
  "1,-1": 2,
  "1,0": 3,
  "1,1": 4,
  "0,1": 5,
  "-1,1": 6,
  "-1,0": 7,
  "-1,-1": 8
};

const RIGHT_WARD = DIRECTIONS["1,0"];
const LEFT_WARD = DIRECTIONS["-1,0"];

class FakePosition {
  public constructor(public x: number, public y: number, public roomName: string) {}

  public isEqualTo(other: FakePosition): boolean {
    return this.x === other.x && this.y === other.y && this.roomName === other.roomName;
  }

  public getDirectionTo(other: FakePosition): number {
    return DIRECTIONS[`${other.x - this.x},${other.y - this.y}`];
  }
}

class FakeCostMatrix {
  private readonly data = new Uint8Array(2500);

  public get(x: number, y: number): number {
    return this.data[y * 50 + x];
  }

  public set(x: number, y: number, value: number): void {
    this.data[y * 50 + x] = value;
  }
}

interface FakeCreep {
  name: string;
  pos: FakePosition;
  room: unknown;
  fatigue: number;
  moved?: number;
  move(direction: number): number;
}

let room: unknown;

/** 一间空房：没有建筑也没有墙，让位时哪个方向都走得通 */
function plainRoom(): unknown {
  return {
    name: "W1N1",
    find: () => [],
    getTerrain: () => ({ get: () => 0 })
  };
}

function creepAt(name: string, x: number, y: number, fatigue = 0): FakeCreep {
  const creep: FakeCreep = {
    name,
    room,
    fatigue,
    pos: new FakePosition(x, y, "W1N1"),
    move(direction: number) {
      this.moved = direction;
      return 0;
    }
  };

  (global as any).Game.creeps[name] = creep;
  return creep;
}

/**
 * 登记一个「想走到这格去」的意图。
 *
 * 假 creep 缺的字段太多，逐个补齐不如在这里断言一次类型；
 * 交通层只用到 name、pos、fatigue、room 和 move 这几样。
 */
function ask(creep: FakeCreep, x: number, y: number): void {
  requestMove(creep as unknown as Creep, new FakePosition(x, y, "W1N1") as unknown as RoomPosition);
}

function pin(creep: FakeCreep): void {
  holdPosition(creep as unknown as Creep);
}

describe("交通结算", () => {
  beforeEach(() => {
    // tick 每次递增，免得交通层把上一个测试留下的意图当成本 tick 的
    (global as any).Game = { creeps: {}, time: ((global as any).Game?.time ?? 0) + 1 };
    (global as any).PathFinder = { CostMatrix: FakeCostMatrix };
    (global as any).RoomPosition = FakePosition;
    (global as any).TERRAIN_MASK_WALL = 1;
    (global as any).TERRAIN_MASK_SWAMP = 2;
    (global as any).FIND_STRUCTURES = 1;
    (global as any).FIND_CONSTRUCTION_SITES = 2;
    (global as any).FIND_MY_CONSTRUCTION_SITES = 3;
    (global as any).STRUCTURE_ROAD = "road";
    (global as any).STRUCTURE_CONTAINER = "container";
    (global as any).STRUCTURE_RAMPART = "rampart";

    room = plainRoom();
  });

  it("面对面的两个 creep 直接换位，谁都不用绕", () => {
    const left = creepAt("left", 10, 10);
    const right = creepAt("right", 11, 10);

    ask(left, 11, 10);
    ask(right, 10, 10);
    runTraffic();

    assert.equal(left.moved, RIGHT_WARD, "左边那个照原意图往右");
    assert.equal(right.moved, LEFT_WARD, "右边那个照原意图往左");
  });

  it("挡路的人自己没事干也会被请开", () => {
    const walker = creepAt("walker", 10, 10);
    const idler = creepAt("idler", 11, 10);

    ask(walker, 11, 10);
    runTraffic();

    assert.isDefined(walker.moved, "想走的人不该被闲着的人堵死");
    assert.isDefined(idler.moved, "闲着的人得挪开腾位置");
  });

  it("排成一队的三个人一起往前挪", () => {
    const first = creepAt("first", 10, 10);
    const second = creepAt("second", 11, 10);
    const third = creepAt("third", 12, 10);

    ask(first, 11, 10);
    ask(second, 12, 10);
    ask(third, 13, 10);
    runTraffic();

    assert.equal(first.moved, RIGHT_WARD);
    assert.equal(second.moved, RIGHT_WARD);
    assert.equal(third.moved, RIGHT_WARD, "队头先腾出空地，整条链才动得起来");
  });

  it("钉住的矿工推不动，路过的只能自己想办法", () => {
    const passerby = creepAt("passerby", 10, 10);
    const miner = creepAt("miner", 11, 10);

    pin(miner);
    ask(passerby, 11, 10);
    runTraffic();

    assert.isUndefined(miner.moved, "钉住的这一 tick 一步都不挪");
    assert.isUndefined(passerby.moved, "挤不进去就原地等，下一 tick 重新寻路绕开");
  });

  it("疲劳的 creep 和钉住的一样推不动", () => {
    const walker = creepAt("walker", 10, 10);
    creepAt("tired", 11, 10, 5);

    ask(walker, 11, 10);
    runTraffic();

    assert.isUndefined(walker.moved, "对面走不动，硬发 move 也是白费一个 intent");
  });

  it("两个人想进同一格时只放一个进去", () => {
    const fromLeft = creepAt("fromLeft", 10, 10);
    const fromBelow = creepAt("fromBelow", 11, 11);

    ask(fromLeft, 11, 10);
    ask(fromBelow, 11, 10);
    runTraffic();

    const movers = [fromLeft, fromBelow].filter(creep => creep.moved !== undefined);
    assert.lengthOf(movers, 1, "同一 tick 里一格只能许给一个人，两个都放进去会双双失败");
  });

  it("没人登记意图时什么都不做", () => {
    const idler = creepAt("idler", 10, 10);

    runTraffic();

    assert.isUndefined(idler.moved);
  });

  it("上一 tick 的意图不会残留到下一 tick", () => {
    const walker = creepAt("walker", 10, 10);
    ask(walker, 11, 10);

    (global as any).Game.time++;
    runTraffic();

    assert.isUndefined(walker.moved, "换了 tick 就该清空，否则会照着过期的目标乱走");
  });
});
