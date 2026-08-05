import { assert } from "chai";
import { travelTo } from "../../src/movement/move";

/**
 * travelTo 只用到 pos 上的几个成员，造真的 RoomPosition 得把半个引擎搬进来。
 * instanceof 那一处需要 global.RoomPosition 存在，所以给一个最小的构造器顶替。
 */
class FakePosition {
  public constructor(public x: number, public y: number, public roomName: string) {}

  /** 测的都是"还没到"的情形，到了就直接返回了，没有下一步可看 */
  public inRangeTo(): boolean {
    return false;
  }
}

interface FakeCreep {
  name: string;
  pos: FakePosition;
  memory: CreepMemory;
  moved: number[];
  move: (direction: number) => number;
}

function creepAt(x: number, y: number, roomName: string, travel: TravelState): FakeCreep {
  const creep: FakeCreep = {
    name: "mover",
    pos: new FakePosition(x, y, roomName),
    memory: { role: "remoteHauler", room: "W1N1", working: false, travel },
    moved: [],
    move: direction => {
      creep.moved.push(direction);
      return OK;
    }
  };

  return creep;
}

function travel(creep: FakeCreep, destination: FakePosition, range: number): void {
  travelTo(creep as unknown as Creep, destination as unknown as RoomPosition, { range });
}

describe("跨房间移动", () => {
  // 每个用例都重新铺一遍：全局是共享的，别的测试文件跑完会把它清掉
  beforeEach(() => {
    (global as unknown as { RoomPosition: unknown }).RoomPosition = FakePosition;
    (global as unknown as { OK: number }).OK = 0;
    // 跨房那一步要向交通层报备，而交通层按 tick 清账，得有个 Game.time 可读
    (global as unknown as { Game: unknown }).Game = { time: 1, creeps: {} };
  });

  it("站在出口格上要自己 move 出去，不能等交通层", () => {
    // x=0 再往左就出房间了，这正是外矿路线上每趟都要过的那一格
    const creep = creepAt(0, 25, "W1N1", { dest: "25,25,W2N1,20", path: "7", stuck: 0, last: "" });

    travel(creep, new FakePosition(25, 25, "W2N1"), 20);

    assert.deepEqual(creep.moved, [7], "交通层只认本房间的 creep，这一步交给它就没人执行");
  });

  it("跨出去之后丢掉路径缓存，到了新房间重新算", () => {
    const creep = creepAt(49, 10, "W1N1", { dest: "3,10,E1N1,1", path: "3", stuck: 0, last: "" });

    travel(creep, new FakePosition(3, 10, "E1N1"), 1);

    assert.deepEqual(creep.moved, [3]);
    assert.isUndefined(creep.memory.travel, "留着的话新房间里会照着旧方向串继续走");
  });

  it("方向串里出现脏数据就重新寻路，不照着乱走", () => {
    const creep = creepAt(0, 25, "W1N1", { dest: "25,25,W2N1,20", path: "x", stuck: 0, last: "" });

    travel(creep, new FakePosition(25, 25, "W2N1"), 20);

    assert.deepEqual(creep.moved, []);
    assert.isUndefined(creep.memory.travel);
  });
});
