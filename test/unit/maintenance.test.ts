import { FIRST_SPAWN_OFFSET } from "../../src/planner/bunkerLayout";
import { assert } from "chai";
import { encodeCells } from "../../src/planner/roads";
import { flagHelpText, runFlagDirectives } from "../../src/managers/flags";
import { installGameConstants } from "./mock";
import { isPlanned } from "../../src/planner/roomPlanner";
import { isRetiring, reliefSlots, ticksPerStep } from "../../src/managers/relief";

/** 一个只有 memory 的假房间，isPlanned 要的就是图纸 */
function planned(memory: Partial<RoomMemory>): Room {
  return { name: `W${Math.floor(Math.random() * 1e6)}N1`, memory } as unknown as Room;
}

describe("规划内的建筑", () => {
  const anchor = { x: 25, y: 25 };

  let saved: { Game: unknown; Memory: unknown };

  beforeEach(() => {
    installGameConstants();
    const context = global as unknown as typeof saved;
    saved = { Game: context.Game, Memory: context.Memory };

    // 图纸展开结果按 tick 缓存，每个用例换一个 tick
    context.Game = { time: Math.floor(Math.random() * 1e6) };
    context.Memory = { rooms: {} };
  });

  afterEach(() => {
    Object.assign(global, saved);
  });

  it("bunker 布局里的位置算规划内", () => {
    const room = planned({ anchor });

    assert.isTrue(isPlanned(room, "spawn", anchor.x + FIRST_SPAWN_OFFSET.dx, anchor.y + FIRST_SPAWN_OFFSET.dy));
  });

  it("位置对但类型不对不算", () => {
    const room = planned({ anchor });

    // 塔要修的是"这一格上该有的那种建筑"。类型不对说明这是别人盖的东西
    assert.isFalse(isPlanned(room, "tower", anchor.x + FIRST_SPAWN_OFFSET.dx, anchor.y + FIRST_SPAWN_OFFSET.dy));
  });

  it("主干道和外矿路段都算规划内", () => {
    const room = planned({ anchor, roads: encodeCells([{ x: 10, y: 10 }]) });
    // 外矿路段存在目标房间自己的 Memory 里，不在 room.memory 这个引用上
    Memory.rooms[room.name] = { remoteRoads: encodeCells([{ x: 40, y: 40 }]) } as RoomMemory;

    assert.isTrue(isPlanned(room, "road", 10, 10), "房内主干道");
    assert.isTrue(isPlanned(room, "road", 40, 40), "外矿路线在这个房间里的那一段");
    assert.isFalse(isPlanned(room, "road", 11, 11), "图纸上没有的那格是前人留下的，不该替他维护");
  });

  it("矿点和升级点的容器算规划内", () => {
    const room = planned({ anchor, miningSpots: { s1: { x: 8, y: 8 } }, upgradeSpot: { x: 30, y: 30 } });

    assert.isTrue(isPlanned(room, "container", 8, 8));
    assert.isTrue(isPlanned(room, "container", 30, 30));
    assert.isFalse(isPlanned(room, "container", 9, 9));
  });

  it("还没规划的房间里什么都不算", () => {
    assert.isFalse(isPlanned(planned({}), "spawn", 25, 25));
  });
});

describe("接班", () => {
  function creep(parts: BodyPartConstant[], ticksToLive: number, role: CreepRole = "miner"): unknown {
    return {
      name: `${role}_${ticksToLive}`,
      memory: { role, room: "W1N1", sourceId: "s1" },
      body: parts.map(type => ({ type })),
      ticksToLive
    };
  }

  let saved: unknown;

  beforeEach(() => {
    installGameConstants();
    saved = (global as unknown as { Game: unknown }).Game;
    (global as unknown as { Game: unknown }).Game = { creeps: {}, time: 1000 };
  });

  afterEach(() => {
    (global as unknown as { Game: unknown }).Game = saved;
  });

  it("矿工每步要五 tick：五个 WORK 配一个 MOVE", () => {
    // 平地每格每个非 MOVE 部件产生 2 点疲劳，一个 MOVE 每 tick 消 2 点
    assert.equal(ticksPerStep(creep(["work", "work", "work", "work", "work", "move"], 100) as Creep), 5);
  });

  it("一比一配 MOVE 的就是一格一 tick", () => {
    assert.equal(ticksPerStep(creep(["carry", "move"], 100) as Creep), 1);
  });

  it("还年轻的不算快退休", () => {
    assert.isFalse(isRetiring(creep(["work", "move"], 500) as Creep, 50));
  });

  it("剩下的寿命只够接班的孵化加赶路时就算", () => {
    // 六个部件孵化 18 tick，通勤 50 tick，余量 20 tick，合计 88
    assert.isTrue(isRetiring(creep(["work", "work", "work", "work", "work", "move"], 80) as Creep, 50));
  });

  it("还在孵化的不算：它本身就是刚补的那个", () => {
    const unborn = { body: [{ type: "work" }], ticksToLive: undefined } as unknown as Creep;

    assert.isFalse(isRetiring(unborn, 10));
  });

  it("通勤算不出来时当它还能干，免得配额永久多一个名额", () => {
    assert.isFalse(isRetiring(creep(["work", "move"], 10) as Creep, Infinity));
  });

  it("房间里有人快退休就多留一个名额", () => {
    const game = (global as unknown as { Game: { creeps: Record<string, unknown> } }).Game;
    const dying = creep(["work", "work", "work", "work", "work", "move"], 30);
    game.creeps.miner_30 = dying;

    const room = {
      name: "W1N1",
      memory: { miningSpots: { s1: { x: 10, y: 10 } } },
      find: () => [{ pos: { getRangeTo: () => 10 } }]
    } as unknown as Room;

    assert.equal(reliefSlots(room, "miner"), 1);
  });
});

describe("旗子指令", () => {
  /** startExpansion 要量目标离老家多远，只用到这三个字段 */
  class FakePosition {
    public constructor(
      public x: number,
      public y: number,
      public roomName: string
    ) {}
  }

  let saved: { Game: unknown; Memory: unknown; RoomPosition: unknown };
  let removed: string[];

  function flag(name: string, roomName: string): unknown {
    return {
      name,
      pos: { roomName },
      remove: () => {
        removed.push(name);
        return 0;
      }
    };
  }

  function ownedRoom(name: string, level = 4): unknown {
    return {
      name,
      controller: { my: true, level },
      energyCapacityAvailable: 1300,
      memory: { anchor: { x: 25, y: 25 } },
      find: () => []
    };
  }

  beforeEach(() => {
    installGameConstants();
    const context = global as unknown as typeof saved;
    saved = { Game: context.Game, Memory: context.Memory, RoomPosition: context.RoomPosition };
    removed = [];
    context.RoomPosition = FakePosition;

    context.Game = {
      creeps: {},
      flags: {},
      rooms: { W1N1: ownedRoom("W1N1"), W9N9: ownedRoom("W9N9") },
      time: 500,
      gcl: { level: 8 },
      // W1N1 挨着 W1N2，W9N9 离得远
      map: { getRoomLinearDistance: (from: string, to: string) => (from === "W1N1" && to === "W1N2" ? 1 : 9) }
    };
    context.Memory = { settings: { level: "error" }, rooms: {} };
  });

  afterEach(() => {
    Object.assign(global, saved);
  });

  it("就近的己方房间接活，旗子用完即焚", () => {
    const game = (global as unknown as { Game: { flags: Record<string, unknown> } }).Game;
    game.flags.claim1 = flag("claim1", "W1N2");

    runFlagDirectives();

    assert.equal(Game.rooms.W1N1.memory.expansion?.target, "W1N2", "离得近的那个房间承接");
    assert.isUndefined(Game.rooms.W9N9.memory.expansion, "远的那个不该抢");
    assert.deepEqual(removed, ["claim1"], "任务已经记在 Memory 里，旗子留着两份状态迟早对不上");
  });

  it("认不出前缀的旗子不动它", () => {
    const game = (global as unknown as { Game: { flags: Record<string, unknown> } }).Game;
    game.flags.myNote = flag("myNote", "W1N2");

    runFlagDirectives();

    assert.isEmpty(removed, "别人插的标记不该被我们清掉");
  });

  it("大小写和后缀都不影响识别", () => {
    const game = (global as unknown as { Game: { flags: Record<string, unknown> } }).Game;
    game.flags.LootThatBase = flag("LootThatBase", "W1N2");

    runFlagDirectives();

    assert.equal(Game.rooms.W1N1.memory.loot, "W1N2");
  });

  it("flaghelp 把可用前缀都列出来", () => {
    const text = flagHelpText();

    for (const prefix of ["claim", "loot", "remote", "plan"]) assert.include(text, prefix);
  });
});
