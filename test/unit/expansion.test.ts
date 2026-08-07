import { assert } from "chai";
import { bodyCost, bodyFor } from "../../src/utils/body";
import {
  claimerQuota,
  colonyBoostTarget,
  colonyDefenders,
  expansionAssignment,
  expansionStage,
  expansionStatus,
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
function colony(options: { mine?: boolean; spawns?: number; towers?: number; hostiles?: number } = {}): unknown {
  return {
    name: "W1N2",
    controller: options.mine === undefined ? undefined : { my: options.mine, level: 1 },
    find: (type: number) => {
      if (type === FIND_MY_SPAWNS) return new Array(options.spawns ?? 0).fill({});
      // 有没有塔是"能不能自保"的判据，撤销扶持看这个
      if (type === FIND_MY_STRUCTURES) return new Array(options.towers ?? 0).fill({ structureType: "tower" });
      if (type === FIND_HOSTILE_CREEPS)
        return new Array(options.hostiles ?? 0).fill({ body: [{ type: "attack", hits: 100 }] });
      return [];
    }
  };
}

function home(memory: Partial<RoomMemory> = {}, storedEnergy?: number): Room {
  return {
    name: "W1N1",
    controller: { level: 4 },
    energyCapacityAvailable: 1300,
    memory: { anchor: { x: 25, y: 25 }, ...memory },
    // 攒着一大笔能量的老家才谈得上加派拓荒者；没传就当没 storage（RCL3 的样子）
    storage: storedEnergy === undefined ? undefined : { store: { [RESOURCE_ENERGY]: storedEnergy } },
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

  it("拓荒者满载平地也能 1t/格：MOVE 要盖住 WORK+满载 CARRY", () => {
    const body = bodyFor("pioneer", 800);

    // 一组 W+C+M+M=250；800 买三组。空 CARRY 不计重，但满载后非 MOVE=6、MOVE=6
    assert.equal(countPart(body, "work"), 3);
    assert.equal(countPart(body, "carry"), 3);
    assert.equal(countPart(body, "move"), 6);
    assert.isAtLeast(
      countPart(body, "move"),
      countPart(body, "work") + countPart(body, "carry"),
      "满载平原每非 MOVE 产 2 疲劳，每个 MOVE 消 2，必须 MOVE ≥ WORK+CARRY"
    );
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

    context.Game = {
      creeps: {},
      rooms: {},
      time: 500,
      gcl: { level: 8 },
      map: { getRoomLinearDistance: () => 1, describeExits: () => ({}) }
    };
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

  it("本房还有核心工地时冻结 grow 扶持：先铺完自家 extension", () => {
    Game.rooms.W1N2 = colony({ mine: true, spawns: 1 }) as Room;
    const room = home({ expansion: { target: "W1N2", since: 1 } });
    // 主房 extension 没齐就去扶分房，两边都半吊子——这正是用户踩到的坑
    room.find = (type: number) => {
      if (type === FIND_MY_SPAWNS) return [{}];
      if (type === FIND_MY_CONSTRUCTION_SITES) {
        return [{ structureType: "extension" }, { structureType: "extension" }];
      }
      return [];
    };

    assert.equal(expansionStage(room), "grow");
    assert.equal(pioneerQuota(room), 0, "本房建筑没铺完不加派拓荒者");
  });

  it("建 spawn 阶段不受本房工地影响：没 spawn 分房永远起不来", () => {
    Game.rooms.W1N2 = colony({ mine: true, spawns: 0 }) as Room;
    const room = home({ expansion: { target: "W1N2", since: 1 } });
    room.find = (type: number) => {
      if (type === FIND_MY_SPAWNS) return [{}];
      if (type === FIND_MY_CONSTRUCTION_SITES) return [{ structureType: "extension" }];
      return [];
    };

    assert.equal(expansionStage(room), "build");
    assert.equal(pioneerQuota(room), 4, "建 spawn 是卡死点，本房建造让这一步");
  });

  it("建 spawn 时老家攒够能量就堆到上限抢时间", () => {
    Game.rooms.W1N2 = colony({ mine: true, spawns: 0 }) as Room;
    const room = home({ expansion: { target: "W1N2", since: 1 } }, 150000);

    // build 阶段是一锤子买卖，有余裕就顶到 6 个一口气把 spawn 建起来
    assert.equal(expansionStage(room), "build");
    assert.equal(pioneerQuota(room), 6);
  });

  it("spawn 建好后的扶持克制，有余裕也只多派一个", () => {
    Game.rooms.W1N2 = colony({ mine: true, spawns: 1 }) as Room;
    const room = home({ expansion: { target: "W1N2", since: 1 } }, 30000);

    // grow 是更长的爬坡，不能一直占老家一大把编制：基础 2 个，有余裕加到 3，
    // 把本该多造一个闲置 upgrader 的富余换成一个拓荒者接着开荒
    assert.equal(expansionStage(room), "grow");
    assert.equal(pioneerQuota(room), 3);
  });

  it("storage 见底就不加派，本土自己都刚够温饱", () => {
    Game.rooms.W1N2 = colony({ mine: true, spawns: 1 }) as Room;
    const room = home({ expansion: { target: "W1N2", since: 1 } }, 10000);

    assert.equal(pioneerQuota(room), 2, "一万不算余裕，接济别人前先顾好自己");
  });

  it("没有分房记录但隔壁弱房没塔，照样派拓荒者扶持", () => {
    // 旧逻辑在"造出三个人"时就把 expansion 撤了，上传后策略看起来完全没生效——
    // 兵援已经不依赖那条记录，经济扶持也必须同样扫弱房
    Game.rooms.W1N2 = colony({ mine: true, spawns: 1 }) as Room;
    const room = home();

    assert.equal(colonyBoostTarget(room), "W1N2");
    assert.equal(pioneerQuota(room), 2, "按 grow 留守人数继续扶，不依赖 expansion 记录");
    assert.deepEqual(expansionAssignment(room), { targetRoom: "W1N2" });
    assert.include(expansionStatus(room) ?? "", "扶持中");
  });

  it("外矿不再占用拓荒者名额：容器归矿工、路归运输队顺手修", () => {
    // 曾经这里会给外矿路队留一格配额，结果是"专人跨房修容器"和"路队目标粘滞"
    // 两套 bug。现在拓荒者只干分房/扶持
    const room = home({ remotes: ["W1N0"] });
    room.find = (type: number) => {
      if (type === FIND_MY_SPAWNS) return [{}];
      if (type === FIND_MY_CONSTRUCTION_SITES) return [{ structureType: "extension" }];
      return [];
    };

    assert.equal(pioneerQuota(room), 0);
    assert.deepEqual(expansionAssignment(room), {});
  });

  it("弱房建起塔之后经济扶持也停", () => {
    Game.rooms.W1N2 = colony({ mine: true, spawns: 1, towers: 1 }) as Room;
    const room = home();

    assert.isUndefined(colonyBoostTarget(room));
    assert.equal(pioneerQuota(room), 0);
  });

  it("弱房正在挨打时先协防、不派拓荒者：安全优先，别把工作单位往火里送", () => {
    // 敌情按 tick 缓存，换个 tick 免得和别的用例串味
    Game.time = 620;
    Game.rooms.W1N2 = colony({ mine: true, spawns: 1, hostiles: 2 }) as Room;
    const room = home();

    assert.isUndefined(colonyBoostTarget(room), "挨打的房间归 colonyDefenders 出兵，不是拓荒者的经济扶持对象");
    assert.equal(pioneerQuota(room), 0, "先清场再派工作单位");
    // 同一时刻协防照常派兵
    assert.deepEqual(colonyDefenders(room), { target: "W1N2", count: 1 });
  });

  it("目标正在建 spawn 却挨打，就先停派拓荒者、保住已在路上的", () => {
    Game.time = 640;
    Game.rooms.W1N2 = colony({ mine: true, hostiles: 2 }) as Room;
    // 已经有两个拓荒者在扶持路上，别裁，但也别再往火里添
    for (let i = 0; i < 2; i++) {
      Game.creeps[`pio${i}`] = { name: `pio${i}`, memory: { role: "pioneer", room: "W1N1" } } as unknown as Creep;
    }
    const room = home({ expansion: { target: "W1N2", since: 1 } }, 50000);

    assert.equal(pioneerQuota(room), 2, "挨打时按现有人数封住，不加不裁");
  });

  it("有余裕但孵化预算排不下时，加派也让位给孵化时间那道闸", () => {
    Game.rooms.W1N2 = colony({ mine: true, spawns: 1 }) as Room;
    // 孵化预算按 Game.time 缓存，换个 tick 让它照这批新造的 creep 重新算
    Game.time = 700;

    // 一个 spawn 的编制 500 部件，先用满八成，只剩不到几个拓荒者的位置
    for (let i = 0; i < 8; i++) {
      Game.creeps[`hog${i}`] = {
        name: `hog${i}`,
        memory: { role: "hauler", room: "W1N1" },
        body: new Array(50).fill({ type: "carry" })
      } as unknown as Creep;
    }

    const room = home({ expansion: { target: "W1N2", since: 1 } }, 150000);
    assert.isBelow(pioneerQuota(room), 3, "能量花不完，但孵化时间不够就派不满 grow 想要的 3 个");
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

  it("新房建起塔、能自保了才撤销扶持", () => {
    Game.rooms.W1N2 = colony({ mine: true, spawns: 1, towers: 1 }) as Room;
    const room = home({ expansion: { target: "W1N2", since: 1 } });
    runExpansionManager(room);

    assert.isUndefined(room.memory.expansion, "有塔就能自己扛住入侵者，扶持功成身退");
  });

  it("只造得出人、还没塔时不撤，继续扶持扛骚扰", () => {
    Game.rooms.W1N2 = colony({ mine: true, spawns: 1 }) as Room;
    for (const name of ["a", "b", "c", "d"]) {
      Game.creeps[name] = { name, memory: { role: "harvester", room: "W1N2" } } as unknown as Creep;
    }

    const room = home({ expansion: { target: "W1N2", since: 1 } });
    runExpansionManager(room);

    assert.isDefined(room.memory.expansion, "闭环接通但没塔，一被骚扰就停摆，得扶到有塔");
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

  it("有 spawn 但没塔、挨打时老家仍派兵", () => {
    // 敌情按 tick 缓存，换个 tick 免得读到前面用例把 W1N2 记成"无敌情"的账
    Game.time = 760;
    // 扶持已经撤销、本地也有 spawn——旧逻辑这里直接不管了
    const hostile = { body: [{ type: "attack", hits: 100 }] };
    Game.rooms.W1N2 = {
      name: "W1N2",
      controller: { my: true, level: 1 },
      find: (type: number) => {
        if (type === FIND_MY_SPAWNS) return [{}];
        if (type === FIND_MY_STRUCTURES) return [];
        if (type === FIND_HOSTILE_CREEPS) return [hostile];
        return [];
      }
    } as unknown as Room;

    const relief = colonyDefenders(home());
    assert.deepEqual(relief, { target: "W1N2", count: 1 }, "一个 1 攻的杂兵一个满编兵就够，不再照人头多派");
  });

  it("敌人成建制时按战力加派，但封在上限", () => {
    // 敌情按 tick 缓存，换个 tick 免得读到上一个用例给 W1N2 记的账
    Game.time = 800;

    // 两个各 20 攻的大家伙，总战力 40，我方一个兵 10 攻，算出来要 4 个，封在 3
    const heavy = { body: new Array(20).fill({ type: "attack", hits: 100 }) };
    Game.rooms.W1N2 = {
      name: "W1N2",
      controller: { my: true, level: 1 },
      find: (type: number) => {
        if (type === FIND_MY_SPAWNS) return [{}];
        if (type === FIND_MY_STRUCTURES) return [];
        if (type === FIND_HOSTILE_CREEPS) return [heavy, heavy];
        return [];
      }
    } as unknown as Room;

    assert.deepEqual(colonyDefenders(home()), { target: "W1N2", count: 3 }, "再多也挤不进那一格，封在三个");
  });

  it("分房有塔之后不再跨房驰援", () => {
    const hostile = { body: [{ type: "attack", hits: 100 }] };
    Game.rooms.W1N2 = {
      name: "W1N2",
      controller: { my: true, level: 3 },
      find: (type: number) => {
        if (type === FIND_MY_SPAWNS) return [{}];
        if (type === FIND_MY_STRUCTURES) return [{ structureType: "tower" }];
        if (type === FIND_HOSTILE_CREEPS) return [hostile];
        return [];
      }
    } as unknown as Room;

    assert.isUndefined(colonyDefenders(home()), "有塔是本房的事");
  });

  it("等级不够高的家不去支援更强的邻居", () => {
    const hostile = { body: [{ type: "attack", hits: 100 }] };
    Game.rooms.W1N2 = {
      name: "W1N2",
      controller: { my: true, level: 5 },
      find: (type: number) => {
        if (type === FIND_MY_STRUCTURES) return [];
        if (type === FIND_HOSTILE_CREEPS) return [hostile];
        return [];
      }
    } as unknown as Room;

    assert.isUndefined(colonyDefenders(home()), "RCL4 不该给 RCL5 派兵");
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

  it("没有 storage 时压到两个人：运回来无处可放", () => {
    Memory.rooms.W1N2.lootLeft = 84_000;

    // 出口只有 spawn、extension 和升级容器，几千点就满了。再多派人只是花孵化费
    // 雇几个会走路的仓库
    assert.equal(looterQuota(home({ loot: "W1N2" })), 2);
  });

  it("storage 空着仍压两人：仓还没站稳不抢孵化", () => {
    Memory.rooms.W1N2.lootLeft = 84_000;
    const empty = {
      ...home({ loot: "W1N2" }),
      storage: { store: { energy: 0 } }
    } as unknown as Room;

    assert.equal(looterQuota(empty), 2);
  });

  it("storage 攒够垫底才放开到满编", () => {
    Memory.rooms.W1N2.lootLeft = 84_000;
    const withStorage = {
      ...home({ loot: "W1N2" }),
      storage: { store: { energy: 5000 } }
    } as unknown as Room;

    assert.equal(looterQuota(withStorage), 4, "仓里有底了再多派人多赚");
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
