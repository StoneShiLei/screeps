import { assert } from "chai";
import { DEMAND_PRIORITY, LogisticsEntry, SUPPLY_PRIORITY, chooseEntry, deductReservations, feedingSpawn } from "../../src/managers/logistics";
import { bodyCost, bodyFor } from "../../src/utils/body";
import { gatherEnergy } from "../../src/utils/energy";
import { haulersForBacklog } from "../../src/managers/spawnManager";
import { installGameConstants } from "./mock";
import { runUpgrader } from "../../src/roles/upgrader";
import { splitDemands } from "../../src/managers/panel";

function entry(id: string, x: number, y: number, amount: number, priority: number): LogisticsEntry {
  return { id, x, y, amount, priority };
}

/** 部件常量是游戏运行时才注入的全局量，测试里直接数字符串 */
function countPart(body: BodyPartConstant[], part: BodyPartConstant): number {
  return body.filter(candidate => candidate === part).length;
}

describe("体型生成", () => {
  it("矿工在 RCL2 的预算下正好凑齐五个 WORK", () => {
    const body = bodyFor("miner", 550);

    assert.equal(countPart(body, "work"), 5, "五个 WORK 每 tick 挖十点，正好等于能量源的产出");
    assert.equal(countPart(body, "move"), 1);
    assert.equal(bodyCost(body), 550);
  });

  it("矿工不会因为预算变多就无限堆 WORK", () => {
    const body = bodyFor("miner", 3000);

    assert.equal(countPart(body, "work"), 5, "超过五个 WORK 挖不出更多能量，纯属浪费");
  });

  it("预算宽裕时给矿工配一个 CARRY 用来修容器", () => {
    assert.isFalse(bodyFor("miner", 550).includes("carry"), "RCL2 的预算优先保证挖矿速度");
    assert.isTrue(bodyFor("miner", 650).includes("carry"));
  });

  it("搬运工的 CARRY 和 MOVE 一比一，满载也能全速跑", () => {
    const body = bodyFor("hauler", 600);

    assert.equal(countPart(body, "carry"), countPart(body, "move"));
  });

  it("升级工把预算堆在 WORK 上，只留一个 CARRY", () => {
    const body = bodyFor("upgrader", 800);

    assert.equal(countPart(body, "carry"), 1, "站在容器边上现取现用，不需要大口袋");
    assert.isAbove(countPart(body, "work"), 3);
  });

  it("预算再少也给出一个能孵化的体型", () => {
    const body = bodyFor("hauler", 0);

    assert.isNotEmpty(body, "返回空体型会让孵化直接报错，房间彻底卡死");
  });

  it("MOVE 排在最后，挨打时最后才失去移动能力", () => {
    const body = bodyFor("builder", 800);

    assert.equal(body[body.length - 1], "move");
  });

  it("凑不满一整组的零头不浪费", () => {
    const body = bodyFor("harvester", 300);

    assert.equal(bodyCost(body), 300, "一组 WORK CARRY MOVE 只要 200，剩的 100 得花出去");
    assert.equal(countPart(body, "carry"), 2, "零头买成运力，容量直接翻倍");
    assert.equal(countPart(body, "move"), 2, "加了部件就得配套加 MOVE，不然走不动");
  });

  it("低预算的矿工靠零头换来一个 CARRY", () => {
    const body = bodyFor("miner", 300);

    assert.equal(bodyCost(body), 300);
    assert.equal(countPart(body, "work"), 2);
    assert.isTrue(body.includes("carry"), "有了口袋才修得了脚下的容器");
  });

  it("预算超出角色需求时不拿零头乱堆部件", () => {
    const body = bodyFor("miner", 800);

    assert.equal(countPart(body, "work"), 5, "五个 WORK 就够榨干一个能量源了");
    assert.isBelow(bodyCost(body), 800, "剩下的预算宁可不花，也不堆用不上的部件");
  });

  it("满级房间的升级工堆到刚好喂满控制器", () => {
    const body = bodyFor("upgrader", 12900, 15);

    assert.equal(countPart(body, "work"), 15, "RCL8 的控制器每 tick 只吃得下 15 点，多一个 WORK 都是站着领工资");
  });

  it("不给上限时仍按模板的默认规模来", () => {
    assert.equal(countPart(bodyFor("upgrader", 12900), "work"), 8, "低等级房间养不起满编升级工");
  });

  it("不会超过五十个身体部件的硬性上限", () => {
    for (const role of ["miner", "hauler", "upgrader", "builder", "harvester"] as CreepRole[]) {
      assert.isAtMost(bodyFor(role, 100000).length, 50, role);
    }
  });
});

describe("搬运工人数", () => {
  it("没有积压时维持基础人数", () => {
    assert.equal(haulersForBacklog(0), 2);
  });

  it("货堆起来了就加人", () => {
    assert.isAbove(haulersForBacklog(5000), haulersForBacklog(0), "运不完说明运力不够");
  });

  it("再多也有上限，不能让搬运工挤爆房间", () => {
    assert.equal(haulersForBacklog(1000000), haulersForBacklog(100000));
  });
});

describe("供需匹配", () => {
  it("优先级压过距离", () => {
    const entries = [entry("远的但急", 40, 40, 100, 0), entry("近的但不急", 11, 10, 100, 3)];

    assert.equal(chooseEntry(10, 10, entries)?.id, "远的但急");
  });

  it("同优先级里挑最近的", () => {
    const entries = [entry("远", 30, 10, 500, 1), entry("近", 15, 10, 100, 1)];

    assert.equal(chooseEntry(10, 10, entries)?.id, "近", "缺口大小不参与排序，否则会舍近求远");
  });

  it("已经满足的目标不会被选中", () => {
    assert.isUndefined(chooseEntry(10, 10, [entry("满了", 11, 10, 0, 0)]));
  });

  it("空表返回空", () => {
    assert.isUndefined(chooseEntry(10, 10, []));
  });

  it("扣掉在途量之后缺口变小", () => {
    const entries = [entry("扩展", 10, 10, 200, 0)];
    const result = deductReservations(entries, [{ targetId: "扩展", amount: 50 }]);

    assert.equal(result[0].amount, 150);
  });

  it("在途量足够时目标整个从表里消失", () => {
    const entries = [entry("扩展", 10, 10, 100, 0)];
    const result = deductReservations(entries, [{ targetId: "扩展", amount: 100 }]);

    assert.isEmpty(result, "已经有人在送了，第二个 hauler 不该再往这儿跑");
  });

  it("多个搬运工的在途量会累加", () => {
    const entries = [entry("扩展", 10, 10, 300, 0)];
    const result = deductReservations(entries, [
      { targetId: "扩展", amount: 100 },
      { targetId: "扩展", amount: 100 }
    ]);

    assert.equal(result[0].amount, 100);
  });

  it("扣减不会改动原始数据", () => {
    const entries = [entry("扩展", 10, 10, 200, 0)];
    deductReservations(entries, [{ targetId: "扩展", amount: 50 }]);

    assert.equal(entries[0].amount, 200, "供需表在 tick 内共享，就地修改会污染别的调用方");
  });

  it("和已有条目无关的认领不影响任何人", () => {
    const entries = [entry("扩展", 10, 10, 200, 0)];
    const result = deductReservations(entries, [{ targetId: "已经拆掉的建筑", amount: 999 }]);

    assert.equal(result[0].amount, 200);
  });
});

describe("让位给 spawn", () => {
  const SPOT = { x: 10, y: 10 };

  function store(energy: number, capacity: number): unknown {
    return {
      energy,
      getFreeCapacity: () => capacity - energy,
      getCapacity: () => capacity
    };
  }

  /** 造一个房间：一个 spawn 和一个矿边容器，两边的存量由参数决定 */
  function roomWith(spawnEnergy: number, containerEnergy: number): Room {
    const spawn = {
      id: "spawn1",
      structureType: "spawn",
      pos: { x: 20, y: 20 },
      store: store(spawnEnergy, 300)
    };
    const container = {
      id: "矿边桶",
      structureType: "container",
      pos: { x: SPOT.x, y: SPOT.y },
      store: store(containerEnergy, 2000)
    };

    const room = {
      // 供需表按房间名和 tick 缓存，每次换个名字免得串味
      name: `W${Math.floor(Math.random() * 1e6)}N1`,
      memory: { miningSpots: { s1: SPOT } },
      find: (type: number) => {
        if (type === FIND_MY_STRUCTURES) return [spawn];
        if (type === FIND_STRUCTURES) return [spawn, container];
        return [];
      }
    } as unknown as Room;

    // claimSupply 会按 id 取回对象，还要比对它在不在同一个房间里
    const objects: Record<string, unknown> = { spawn1: { ...spawn, room }, 矿边桶: { ...container, room } };
    (global as unknown as { Game: { getObjectById: (id: string) => unknown } }).Game.getObjectById = id =>
      objects[id] ?? null;

    return room;
  }

  interface Actions {
    withdrew: string[];
    harvested: number;
  }

  function worker(room: Room, role: CreepRole = "builder"): { creep: Creep; did: Actions } {
    const did: Actions = { withdrew: [], harvested: 0 };
    const creep = {
      name: "worker",
      memory: { role, room: room.name, working: false },
      room,
      pos: { x: 12, y: 12, roomName: room.name },
      store: store(0, 400),
      say: () => 0,
      withdraw: (target: { id: string }) => {
        did.withdrew.push(target.id);
        return 0;
      },
      pickup: () => 0,
      harvest: () => {
        did.harvested++;
        return 0;
      }
    } as unknown as Creep;

    return { creep, did };
  }

  let saved: { Game: unknown; Memory: unknown };

  beforeEach(() => {
    installGameConstants();
    const context = global as unknown as typeof saved;
    saved = { Game: context.Game, Memory: context.Memory };

    context.Game = { creeps: {}, rooms: {}, time: Math.floor(Math.random() * 1e6), getObjectById: () => null };
    context.Memory = { rooms: {}, creeps: {} };
  });

  afterEach(() => {
    Object.assign(global, saved);
  });

  it("spawn 没填满时算有缺口", () => {
    assert.isTrue(feedingSpawn(roomWith(100, 2000)));
  });

  it("spawn 填满了就不算，容器空着不影响这个判断", () => {
    assert.isFalse(feedingSpawn(roomWith(300, 0)));
  });

  it("缺口期间让位的角色不动矿边容器，也不去自己挖", () => {
    const { creep, did } = worker(roomWith(100, 2000));

    gatherEnergy(creep, true);

    assert.isEmpty(did.withdrew, "矿边桶是搬运工唯一的货源，缺口期间不能碰");
    // 自挖同样得挡住：源的再生速度是固定的，工人站过去只是从矿工嘴里分走同一份
    // 能量，结果照样是容器不进货、extension 填不上
    assert.equal(did.harvested, 0);
  });

  it("spawn 填满之后立刻恢复取货", () => {
    const { creep, did } = worker(roomWith(300, 2000));

    gatherEnergy(creep, true);

    assert.deepEqual(did.withdrew, ["矿边桶"]);
  });

  it("不让位的角色照旧取矿边容器", () => {
    // harvester 只在搬运工断档时才存在，自己挖自己送正是它被造出来的理由，
    // 让它也让位就等于在最需要重启生产链的时候把它按住
    const { creep, did } = worker(roomWith(100, 2000), "harvester");

    gatherEnergy(creep);

    assert.deepEqual(did.withdrew, ["矿边桶"]);
  });
});

describe("静态升级工的认领", () => {
  let saved: { Game: unknown; Memory: unknown };

  beforeEach(() => {
    installGameConstants();
    const context = global as unknown as typeof saved;
    saved = { Game: context.Game, Memory: context.Memory };

    context.Game = { creeps: {}, rooms: {}, time: 5000, getObjectById: () => null };
    context.Memory = { rooms: {}, creeps: {} };
  });

  afterEach(() => {
    Object.assign(global, saved);
  });

  it("站到站位上之后撒手上一轮认领的矿边桶", () => {
    const spot = { x: 14, y: 21 };
    const station = { x: 13, y: 20 };
    const granary = {
      id: "粮仓",
      structureType: "container",
      pos: spot,
      hits: 2000,
      hitsMax: 2000,
      store: { energy: 500, getFreeCapacity: () => 1500 }
    };

    const room = {
      name: "W1N1",
      controller: { my: true, level: 4 },
      memory: { upgradeSpot: spot, upgradeStations: [station] },
      getPositionAt: (x: number, y: number) => ({
        x,
        y,
        lookFor: () => (x === spot.x && y === spot.y ? [granary] : [])
      }),
      find: () => []
    } as unknown as Room;

    const creep = {
      name: "upgrader_1",
      // 上一轮容器空着，它跑去矿边取货，认领留在了 Memory 里
      memory: { role: "upgrader", room: "W1N1", working: false, withdrawFrom: "矿边桶" },
      room,
      pos: { x: station.x, y: station.y, roomName: "W1N1", getRangeTo: () => 1 },
      store: { energy: 0 },
      say: () => 0,
      getActiveBodyparts: () => 7,
      withdraw: () => 0,
      upgradeController: () => 0
    } as unknown as Creep;

    runUpgrader(creep);

    // 留着这份认领，物流系统会按它的空余容量把矿边那份供给一直扣掉；容器里只剩
    // 一百来点的时候，这一扣就足以让整条供给消失，搬运工于是报"无货源"
    assert.isUndefined(creep.memory.withdrawFrom);
  });
});

describe("面板缺口口径", () => {
  it("只有 spawn、extension 和 tower 算缺口", () => {
    const demands = [
      entry("扩展", 10, 10, 300, DEMAND_PRIORITY.spawn),
      entry("塔", 12, 12, 200, DEMAND_PRIORITY.tower)
    ];

    assert.deepEqual(splitDemands(demands), { missing: 500, stashing: 0 });
  });

  it("容器的空位算囤货，不混进缺口", () => {
    // 控制器旁的桶和 bunker 缓冲桶各 2000 容量，按定义就该是没满的状态。
    // 全部求和会让缺口常年显示四千上下，看着像随时要断供
    const demands = [
      entry("控制器桶", 10, 10, 1888, DEMAND_PRIORITY.controller),
      entry("缓冲桶", 15, 35, 2000, DEMAND_PRIORITY.buffer),
      entry("扩展", 20, 20, 50, DEMAND_PRIORITY.spawn)
    ];

    assert.deepEqual(splitDemands(demands), { missing: 50, stashing: 3888 });
  });

  it("供给档位没变，待运的口径还是矿边那一档", () => {
    assert.equal(SUPPLY_PRIORITY.source, 1);
  });
});
