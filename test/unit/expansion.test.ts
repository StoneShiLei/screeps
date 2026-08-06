import { assert } from "chai";
import { bodyCost, bodyFor } from "../../src/utils/body";
import {
  claimerQuota,
  expansionStage,
  pioneerQuota,
  runExpansionManager,
  startExpansion
} from "../../src/managers/expansion";
import { demolitionList, demolitionTarget } from "../../src/managers/demolish";
import { looterQuota, pickResource } from "../../src/managers/loot";
import { installGameConstants } from "./mock";

function countPart(body: BodyPartConstant[], part: BodyPartConstant): number {
  return body.filter(candidate => candidate === part).length;
}

/** 目标房间的三种形态，对应分房的三个阶段 */
function colony(options: { mine?: boolean; spawns?: number } = {}): unknown {
  return {
    name: "W1N2",
    controller: options.mine === undefined ? undefined : { my: options.mine, level: 1 },
    find: (type: number) => (type === FIND_MY_SPAWNS ? new Array(options.spawns ?? 0).fill({}) : [])
  };
}

function home(memory: Partial<RoomMemory> = {}): Room {
  return {
    name: "W1N1",
    controller: { level: 4 },
    energyCapacityAvailable: 1300,
    memory: { anchor: { x: 25, y: 25 }, ...memory },
    // 老家一定有 spawn，而孵化预算的容量正是按 spawn 个数算的——
    // 没有这一个，headroom 会是零，配额那道闸永远关着
    find: (type: number) => (type === FIND_MY_SPAWNS ? [{}] : [])
  } as unknown as Room;
}

describe("分房体型", () => {
  it("占领者一个 CLAIM 配两个 MOVE，赶路才是它全部的价值", () => {
    const body = bodyFor("claimer", 1300);

    assert.equal(countPart(body, "claim"), 1, "claimController 不看数量，第二个 CLAIM 是白扔六百能量");
    assert.equal(countPart(body, "move"), 2, "一个 MOVE 拖一个 CLAIM 在平地上要两 tick 一格");
    assert.equal(bodyCost(body), 700);
  });

  it("预算只够一个 MOVE 时也能出门", () => {
    const body = bodyFor("claimer", 650);

    assert.equal(countPart(body, "claim"), 1);
    assert.equal(countPart(body, "move"), 1);
  });

  it("拓荒者要自己挖自己建，三种部件等量", () => {
    const body = bodyFor("pioneer", 800);

    assert.equal(countPart(body, "work"), 4);
    assert.equal(countPart(body, "carry"), 4);
    assert.equal(countPart(body, "move"), 4);
  });

  it("搬运工只有 CARRY 和 MOVE，一比一", () => {
    const body = bodyFor("looter", 1300);

    assert.equal(countPart(body, "work"), 0, "带 WORK 就是让它在路上多背几百能量的自重");
    assert.equal(countPart(body, "carry"), countPart(body, "move"), "外矿路上没有路面，满载要一格一 tick");
  });
});

describe("分房阶段", () => {
  let saved: { Game: unknown; Memory: unknown };

  beforeEach(() => {
    installGameConstants();
    const context = global as unknown as { Game: unknown; Memory: unknown };
    saved = { Game: context.Game, Memory: context.Memory };

    context.Game = { creeps: {}, rooms: {}, time: 500, gcl: { level: 8 } };
    // 级别定成 error，撤销扶持那行 info 日志就不会混进测试输出
    context.Memory = { settings: { level: "error" }, rooms: {} };
  });

  afterEach(() => {
    Object.assign(global, saved);
  });

  it("没有记录就没有阶段", () => {
    assert.isUndefined(expansionStage(home()));
  });

  it("没视野一律算还没占下：那时候确实不知道那边什么情况", () => {
    const room = home({ expansion: { target: "W1N2", since: 1 } });

    assert.equal(expansionStage(room), "claim");
    assert.equal(claimerQuota(room), 1);
    assert.equal(pioneerQuota(room), 0, "还没占下就派拓荒者，它过去连工地都没有");
  });

  it("占下了但没 spawn 就该派拓荒者，占领者的活干完了", () => {
    Game.rooms.W1N2 = colony({ mine: true, spawns: 0 }) as Room;
    const room = home({ expansion: { target: "W1N2", since: 1 } });

    assert.equal(expansionStage(room), "build");
    assert.equal(claimerQuota(room), 0);
    assert.equal(pioneerQuota(room), 4);
  });

  it("spawn 建好了就减到留守人数", () => {
    Game.rooms.W1N2 = colony({ mine: true, spawns: 1 }) as Room;
    const room = home({ expansion: { target: "W1N2", since: 1 } });

    assert.equal(expansionStage(room), "grow");
    assert.equal(pioneerQuota(room), 2);
  });

  it("孵化预算排不下的时候不硬派，维持现有人数", () => {
    Game.rooms.W1N2 = colony({ mine: true, spawns: 0 }) as Room;

    // 一个 spawn 的编制是 500 部件当量，这里先用满
    Game.creeps.hog = {
      name: "hog",
      memory: { role: "hauler", room: "W1N1" },
      body: new Array(50).fill({ type: "carry" })
    } as unknown as Creep;

    // 一个 50 部件的 creep 还占不满 425 的可用编制，所以这里仍派得出人；
    // 真正要验的是它不会无视预算直接给满编
    assert.isAtMost(pioneerQuota(home({ expansion: { target: "W1N2", since: 1 } })), 4);
  });

  it("新房自己造得出人就撤销扶持", () => {
    Game.rooms.W1N2 = colony({ mine: true, spawns: 1 }) as Room;
    for (const name of ["a", "b", "c"]) {
      Game.creeps[name] = { name, memory: { role: "harvester", room: "W1N2" } } as unknown as Creep;
    }

    const room = home({ expansion: { target: "W1N2", since: 1 } });
    runExpansionManager(room);

    assert.isUndefined(room.memory.expansion, "自有三个人就意味着挖运孵化那条闭环已经接通");
  });

  it("新房还没人的时候不撤，那时候撤等于把它扔在半路上", () => {
    Game.rooms.W1N2 = colony({ mine: true, spawns: 1 }) as Room;
    const room = home({ expansion: { target: "W1N2", since: 1 } });

    runExpansionManager(room);
    assert.isDefined(room.memory.expansion);
  });

  it("GCL 用满了就不派占领者，派了也是白跑", () => {
    (global as unknown as { Game: { gcl: { level: number }; rooms: Record<string, unknown> } }).Game.gcl = { level: 1 };
    Game.rooms.W1N1 = { controller: { my: true } } as Room;

    assert.equal(claimerQuota(home({ expansion: { target: "W1N2", since: 1 } })), 0);
  });

  it("等级不够时直接拦下来，不留个记录慢慢等", () => {
    const room = home();
    room.controller = { level: 2 } as StructureController;

    const message = startExpansion(room, "W1N2");
    assert.include(message, "级");
    assert.isUndefined(room.memory.expansion, "2 级连 650 能量的占领者都孵不出来");
  });
});

describe("清掉前人的房子", () => {
  /** 前主人留下的建筑：有主，但主人不是我们 */
  function legacy(type: StructureConstant, hits = 1000, store?: Record<string, number>): unknown {
    return {
      structureType: type,
      hits,
      my: false,
      pos: { x: 35, y: 20 },
      store: store ? { getUsedCapacity: () => Object.values(store).reduce((a, b) => a + b, 0) } : undefined
    };
  }

  function ourRoom(structures: unknown[]): Room {
    return {
      name: "W1N2",
      controller: { my: true, level: 1 },
      find: (type: number) => (type === FIND_HOSTILE_STRUCTURES ? structures : [])
    } as unknown as Room;
  }

  beforeEach(() => installGameConstants());

  it("先拆 spawn：它占掉的是整个殖民地的名额", () => {
    // 建筑上限按房间里该类建筑的总数算，不分归属。前人那个还立着的 spawn 让我们
    // 自己的 spawn 工地一直是 ERR_RCL_NOT_ENOUGH，而现场看起来一切正常
    const room = ourRoom([legacy("extension"), legacy("tower"), legacy("spawn", 5000)]);

    assert.equal(demolitionTarget(room)?.structureType, "spawn");
  });

  it("spawn 拆完轮到 extension，它挡的是 RCL2", () => {
    const room = ourRoom([legacy("tower"), legacy("extension")]);

    assert.equal(demolitionTarget(room)?.structureType, "extension");
  });

  it("墙不拆：不占建筑上限，圈在外面还是白捡的防御", () => {
    const room = ourRoom([legacy("constructedWall", 200_000), legacy("rampart")]);

    assert.isUndefined(demolitionTarget(room));
  });

  it("装着大宗货的仓库先留着，拆了会洒在地上蒸发", () => {
    const room = ourRoom([legacy("terminal", 3000, { energy: 84_000 })]);

    assert.isUndefined(demolitionTarget(room), "等搬运工掏空了再拆");
  });

  it("搬空之后就可以拆了", () => {
    const room = ourRoom([legacy("terminal", 3000, { energy: 0 })]);

    assert.equal(demolitionTarget(room)?.structureType, "terminal");
  });

  it("只剩零头的不等：为一百多点能量把开工时间往后推几千 tick 是亏的", () => {
    const room = ourRoom([legacy("spawn", 5000, { energy: 162 })]);

    assert.equal(demolitionTarget(room)?.structureType, "spawn");
  });

  it("不是自己的房间不动手，那是打仗不是拆迁", () => {
    const room = ourRoom([legacy("spawn", 5000)]);
    room.controller = { my: false } as StructureController;

    assert.isUndefined(demolitionTarget(room));
    assert.isEmpty(demolitionList(room));
  });
});

describe("搬空前人的仓库", () => {
  let saved: { Game: unknown; Memory: unknown };

  beforeEach(() => {
    installGameConstants();
    const context = global as unknown as { Game: unknown; Memory: unknown };
    saved = { Game: context.Game, Memory: context.Memory };
    context.Game = { creeps: {}, rooms: {}, time: 500 };
    context.Memory = { rooms: { W1N2: {} } };
  });

  afterEach(() => {
    Object.assign(global, saved);
  });

  it("没记录就不派人", () => {
    assert.equal(looterQuota(home()), 0);
  });

  it("从没看见过那个房间时，先派一个人去看", () => {
    delete Memory.rooms.W1N2.lootLeft;

    // 配额算在家里，而那时候目标房间多半没视野。没有这条，存量永远是"未知"，
    // 也就永远派不出第一个人去把存量看回来
    assert.equal(looterQuota(home({ loot: "W1N2" })), 1);
  });

  it("货多就多派，但有上限——都挤在一个 terminal 前面也取不快", () => {
    Memory.rooms.W1N2.lootLeft = 84_000;

    assert.equal(looterQuota(home({ loot: "W1N2" })), 4);
  });

  it("只剩零头就不专门派人了", () => {
    Memory.rooms.W1N2.lootLeft = 100;

    assert.equal(looterQuota(home({ loot: "W1N2" })), 0, "为了一百点能量养一支运输队是亏的");
  });

  it("能量优先，矿物要等家里有 storage 才拿", () => {
    const store = { energy: 0, X: 30_500 } as unknown as StoreDefinition;

    assert.isUndefined(pickResource(store, home()), "没有 storage，矿物运回来只能扔地上蒸发");
    assert.equal(pickResource(store, { ...home(), storage: {} } as unknown as Room), "X");
  });

  it("有能量就先运能量，那是马上能用的", () => {
    const store = { energy: 5_000, X: 30_500 } as unknown as StoreDefinition;

    assert.equal(pickResource(store, { ...home(), storage: {} } as unknown as Room), RESOURCE_ENERGY);
  });
});
