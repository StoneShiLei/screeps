import { assert } from "chai";
import { bodyCost, bodyFor } from "../../src/utils/body";
import { cleanupRoomMemory } from "../../src/utils/memory";
import {
  activeRemoteSources,
  breachBudgetFor,
  breachTargets,
  dismantlerQuota,
  haulersForRemote,
  nextScoutTarget,
  reserveTargets,
  reserverQuota,
  unassignedBreachTarget,
  unassignedReserveTarget
} from "../../src/managers/remote";
import { runScout } from "../../src/roles/scout";
import { worldRange } from "../../src/utils/distance";

function countPart(body: BodyPartConstant[], part: BodyPartConstant): number {
  return body.filter(candidate => candidate === part).length;
}

/** 中立房和已预定房的每 tick 产出，和 remote.ts 里的两个常量对应 */
const NEUTRAL = 5;
const RESERVED = 10;

describe("外矿运力测算", () => {
  it("路越远要的运输队越多，因为产出在路上等着", () => {
    const near = haulersForRemote(1, 20, 400, NEUTRAL);
    const far = haulersForRemote(1, 80, 400, NEUTRAL);

    assert.isAbove(far, near, "往返时间翻两番，源攒下的存货也翻两番");
  });

  it("运输队装得多就派得少", () => {
    const small = haulersForRemote(1, 60, 300, NEUTRAL);
    const large = haulersForRemote(1, 60, 900, NEUTRAL);

    assert.isAbove(small, large);
  });

  it("再近也至少要一个，不然矿工挖的全烂在地上", () => {
    assert.equal(haulersForRemote(1, 1, 2000, NEUTRAL), 1);
  });

  it("没有源就不派人", () => {
    assert.equal(haulersForRemote(0, 60, 400, NEUTRAL), 0);
  });

  it("人数有上限，超了就是在路上排队", () => {
    // 一个源、极远、极小的运输队，按公式算会要一大堆人
    assert.isAtMost(haulersForRemote(1, 90, 50, NEUTRAL), 3);
  });

  it("两个源的房间按两倍产出算", () => {
    const one = haulersForRemote(1, 60, 400, NEUTRAL);
    const two = haulersForRemote(2, 60, 400, NEUTRAL);

    assert.isAbove(two, one);
  });

  it("运力宁可多派一个也不少一个", () => {
    // 五十二格、四百容量的外矿真实需求是 1.4 个运输队。四舍五入只会派一个，
    // 运力只有需求的七成，矿工挖的三成堆在地上蒸发掉
    assert.equal(haulersForRemote(1, 52, 400, NEUTRAL), 2);
  });

  it("预定过的房间产能翻倍，运力也得跟着翻", () => {
    // 容量取 650 是让两边都正好落在整数上，避开四舍五入和人数上限的干扰
    const plain = haulersForRemote(1, 60, 650, NEUTRAL);
    const reserved = haulersForRemote(1, 60, 650, RESERVED);

    assert.equal(plain, 1);
    assert.equal(reserved, 2, "源容量从 1500 涨到 3000，运不完就烂在地上");
  });
});

describe("外矿体型", () => {
  it("矿工只带 3 个 WORK，够追上 1500 容量的再生速度就行", () => {
    const body = bodyFor("remoteMiner", 800);

    assert.equal(countPart(body, "work"), 3, "中立房的源平均 5 能量/tick，3 个 WORK 每 tick 挖 6 点已经有余");
    assert.equal(countPart(body, "move"), 3, "通勤几十格，MOVE 少了路上就把寿命耗光了");
  });

  it("矿工再有钱也不加 WORK", () => {
    assert.equal(countPart(bodyFor("remoteMiner", 3000), "work"), 3);
  });

  it("运输队 CARRY 和 MOVE 一比一，没路也能平地全速", () => {
    const body = bodyFor("remoteHauler", 800);

    assert.equal(countPart(body, "carry"), countPart(body, "move"));
    assert.equal(countPart(body, "carry"), 8);
  });

  it("侦察兵就一个 MOVE，五十能量的消耗品", () => {
    const body = bodyFor("scout", 800);

    assert.deepEqual(body, ["move"]);
  });

  it("派往已预定房间的矿工要 5 个 WORK，才追得上翻倍的产能", () => {
    const body = bodyFor("remoteMiner", 1300, 5);

    assert.equal(countPart(body, "work"), 5, "3000 容量的源平均 10 能量/tick，5 个 WORK 正好挖 10 点");
  });
});

describe("预定员体型", () => {
  it("一个 CLAIM 一个 MOVE，650 能量，RCL3 就造得出", () => {
    const body = bodyFor("reserver", 800);

    // 净增为零照样让房间处于被预定状态，源容量就是 3000；攒余量只对换人的空窗有用
    assert.deepEqual(body, ["claim", "move"]);
    assert.equal(bodyCost(body), 650);
  });

  it("三级的预算有零头也不乱加部件", () => {
    // 800 减 650 还剩 150，够三个 MOVE。但一个 CLAIM 配一个 MOVE 在平地已经是全速，
    // 多带的每 tick 都在收孵化费，一点产出都不多
    assert.lengthOf(bodyFor("reserver", 800), 2);
  });

  it("再有钱也不加第二个 CLAIM，那是花一倍的钱买同样的每 tick 成本", () => {
    assert.equal(countPart(bodyFor("reserver", 5000), "claim"), 1);
  });
});

describe("预定员接班", () => {
  class FakePosition {
    public constructor(public x: number, public y: number, public roomName: string) {}
  }

  // anchor 到源是 65 格，所以剩余寿命低于 65 + 20 的就该有人接班了
  const home = {
    name: "W1N1",
    controller: { level: 4 },
    memory: { remotes: ["W1N2"], anchor: { x: 25, y: 25 } }
  } as unknown as Room;

  function onDuty(ticksToLive: number): void {
    const creep = {
      name: `reserver_${ticksToLive}`,
      memory: { role: "reserver", room: "W1N1", targetRoom: "W1N2" },
      ticksToLive
    };

    (global as unknown as { Game: { creeps: Record<string, unknown> } }).Game.creeps[creep.name] = creep;
  }

  let saved: { Game: unknown; Memory: unknown; RoomPosition: unknown };
  let tick = 1000;

  beforeEach(() => {
    const context = global as unknown as typeof saved;
    saved = { Game: context.Game, Memory: context.Memory, RoomPosition: context.RoomPosition };

    context.Game = { creeps: {}, time: tick++ };
    context.Memory = { rooms: { W1N2: { sources: { s1: { x: 10, y: 10 } }, scouted: 1 } } };
    context.RoomPosition = FakePosition;
  });

  afterEach(() => {
    Object.assign(global, saved);
  });

  it("一个房间一个预定员", () => {
    assert.equal(reserverQuota(home), 1);
  });

  it("在岗的还年轻就不多要人", () => {
    onDuty(500);

    assert.equal(reserverQuota(home), 1);
  });

  it("在岗的快到期时多留一个名额，让接班的赶在断档前上路", () => {
    onDuty(50);

    // 快退休的那个还活着、还占着人口数，名额不多留就得等它死了才开始孵化，
    // 而那时候接班的还要走完六十五格通勤路，这段时间预定是断的
    assert.equal(reserverQuota(home), 2);
    assert.equal(unassignedReserveTarget(home), "W1N2", "接班的得知道去哪，否则出生就在家里干站着");
  });

  it("接班的到岗后原班人马仍然按住房间，不会再多要人", () => {
    onDuty(50);
    onDuty(600);

    assert.equal(reserverQuota(home), 2, "多出来的那个名额正是给已经在路上的接班人留的");
    assert.isUndefined(unassignedReserveTarget(home), "房间已经有人按着了，再派就是白付孵化费");
  });
});

describe("被墙封住的外矿", () => {
  const home = {
    name: "W1N1",
    controller: { level: 3 },
    energyCapacityAvailable: 800,
    memory: { remotes: ["W1N2"], anchor: { x: 25, y: 25 } }
  } as unknown as Room;

  /** 六个 WORK 的拆迁工，三条命砸得动一百三十五万血 */
  const AFFORDABLE = 120_000;
  const HOPELESS = 2_000_000;

  function remoteRoom(breach?: RoomMemory["breach"]): RoomMemory {
    return { sources: { s1: { x: 10, y: 10 } }, scouted: 1, breach } as RoomMemory;
  }

  let saved: { Game: unknown; Memory: unknown };
  let tick = 3000;

  beforeEach(() => {
    const context = global as unknown as typeof saved;
    saved = { Game: context.Game, Memory: context.Memory };

    // 换 tick：外矿名单是按 tick 缓存的，同一 tick 问第二遍拿的是上个用例的账
    context.Game = { creeps: {}, time: tick++ };
    context.Memory = { rooms: { W1N2: remoteRoom() } };
  });

  afterEach(() => {
    Object.assign(global, saved);
  });

  it("路通的时候照常预定", () => {
    assert.deepEqual(reserveTargets(home), ["W1N2"]);
  });

  it("控制器被墙圈住就不派预定员了", () => {
    Memory.rooms.W1N2 = remoteRoom({ wall: { x: 26, y: 7 }, hits: AFFORDABLE, walls: 1 });

    // 派过去也只能站在墙外两格，600 tick 的寿命全耗在干瞪眼上，还白占人口名额
    assert.isEmpty(reserveTargets(home));
  });

  it("砸得动的墙就派拆迁工", () => {
    Memory.rooms.W1N2 = remoteRoom({ wall: { x: 26, y: 7 }, hits: AFFORDABLE, walls: 1 });

    assert.deepEqual(breachTargets(home), ["W1N2"]);
    assert.equal(dismantlerQuota(home), 1);
  });

  it("太厚的墙就认了，当中立房间用", () => {
    Memory.rooms.W1N2 = remoteRoom({ wall: { x: 26, y: 7 }, hits: HOPELESS, walls: 3 });

    // 攒那么多工钱不如把这个外矿当没预定过来采，反正源照挖
    assert.isEmpty(breachTargets(home));
    assert.equal(dismantlerQuota(home), 0);
  });

  it("拆也拆不进去的（被岩石隔开）同样不派人", () => {
    Memory.rooms.W1N2 = remoteRoom({ hits: 0, walls: 0 });

    assert.isEmpty(reserveTargets(home), "绕路要穿好几个房间，带 CLAIM 的活不到走完");
    assert.isEmpty(breachTargets(home), "没有墙可拆，派拆迁工过去也无事可做");
  });

  it("遇袭冷却期间先不去拆墙", () => {
    Memory.rooms.W1N2 = remoteRoom({ wall: { x: 26, y: 7 }, hits: AFFORDABLE, walls: 1 });
    Memory.rooms.W1N2.raided = Game.time;

    assert.isEmpty(breachTargets(home), "外矿没有塔，站着砸墙的拆迁工是白给对方的经验");
  });

  it("已经有人认领的房间不再派第二个", () => {
    Memory.rooms.W1N2 = remoteRoom({ wall: { x: 26, y: 7 }, hits: AFFORDABLE, walls: 1 });
    Game.creeps.digger = {
      memory: { role: "dismantler", room: "W1N1", targetRoom: "W1N2" }
    } as unknown as Creep;

    assert.isUndefined(unassignedBreachTarget(home));
  });

  it("三条命砸不完的就不值得动手", () => {
    // 六个 WORK 每 tick 砸 300 点，一条命 45 万，三条命 135 万
    assert.equal(breachBudgetFor(6), 1_350_000);
  });
});

describe("遇袭之后的复工", () => {
  const home = {
    name: "W1N1",
    controller: { level: 3 },
    energyCapacityAvailable: 800,
    memory: { remotes: ["W1N2"], anchor: { x: 25, y: 25 } }
  } as unknown as Room;

  const RAID_COOLDOWN = 1500;

  function remoteRoom(extra: Partial<RoomMemory> = {}): RoomMemory {
    return { sources: { s1: { x: 10, y: 10 } }, scouted: 1, ...extra } as RoomMemory;
  }

  let saved: { Game: unknown; Memory: unknown };
  let tick = 50_000;

  beforeEach(() => {
    const context = global as unknown as typeof saved;
    saved = { Game: context.Game, Memory: context.Memory };

    // 换 tick：外矿名单按 tick 缓存，同一 tick 问第二遍拿的是上个用例的账
    context.Game = { creeps: {}, time: (tick += 10), map: { describeExits: () => ({}) } };
    context.Memory = { rooms: { W1N2: remoteRoom() } };
  });

  afterEach(() => {
    Object.assign(global, saved);
  });

  it("没遇袭过的房间照常采", () => {
    assert.lengthOf(activeRemoteSources(home), 1);
  });

  it("冷却期内不派人", () => {
    Memory.rooms.W1N2 = remoteRoom({ raided: Game.time - 100 });

    assert.isEmpty(activeRemoteSources(home));
  });

  it("冷却结束但还没人去看过，只派侦察兵不派整套人马", () => {
    Memory.rooms.W1N2 = remoteRoom({ raided: Game.time - RAID_COOLDOWN - 1 });

    // 冷却到点只意味着"入侵者按理该过期了"，不意味着房间空了。直接补齐矿工和
    // 运输队的话，它们要走几十格才发现敌人还在，然后转头就跑——上千能量的
    // 孵化费和几百 tick 的寿命白扔，冷却还会被重新触发，可以无限循环
    assert.isEmpty(activeRemoteSources(home), "没确认过就不派贵的");
    assert.equal(nextScoutTarget(home), "W1N2", "先花 50 能量让一个 MOVE 去看一眼");
  });

  it("有人去看过、确认清场之后就全员复工", () => {
    const raided = Game.time - RAID_COOLDOWN - 1;
    Memory.rooms.W1N2 = remoteRoom({ raided, cleared: raided + 10 });

    assert.lengthOf(activeRemoteSources(home), 1);
    assert.isUndefined(nextScoutTarget(home), "已经确认过了，不用再跑一趟");
  });

  it("确认的时间早于遇袭就不算确认", () => {
    const raided = Game.time - RAID_COOLDOWN - 1;
    Memory.rooms.W1N2 = remoteRoom({ raided, cleared: raided - 500 });

    assert.isEmpty(activeRemoteSources(home), "那是上次遇袭之前的旧结论");
  });
});

describe("拆迁工体型", () => {
  it("两个 WORK 配一个 MOVE，平地上一格一 tick", () => {
    const body = bodyFor("dismantler", 800);

    assert.equal(countPart(body, "work"), 6, "每 tick 砸 300 点血");
    assert.equal(countPart(body, "move"), 4, "三组配三个，零头再买一个");
    assert.equal(bodyCost(body), 800, "零头也花掉：没路的外矿，早到几十 tick 就早几十 tick 开工");
  });

  it("零头买 MOVE 而不是 CARRY，它不运东西", () => {
    assert.equal(countPart(bodyFor("dismantler", 800), "carry"), 0);
  });
});

describe("跨房间距离", () => {
  function at(x: number, y: number, roomName: string): RoomPosition {
    return { x, y, roomName } as RoomPosition;
  }

  it("同房间时和引擎的切比雪夫距离一致", () => {
    assert.equal(worldRange(at(10, 10, "E28S36"), at(13, 14, "E28S36")), 4);
  });

  it("邻房算出来是真实格数，不是无穷远", () => {
    // getRangeTo 在这里返回 Infinity，于是每个候选外矿都会撞上距离上限被剔掉，
    // 房间早就三级了却一个外矿也开不起来，而且不会有任何报错
    assert.equal(worldRange(at(13, 30, "E28S36"), at(32, 20, "E28S35")), 60);
  });

  it("跨过原点的房间名也算得对", () => {
    // W 和 N 侧的编号从 -1 开始：W0N0 的右下角和 E0S0 的左上角是斜对角相邻的两格
    assert.equal(worldRange(at(49, 49, "W0N0"), at(0, 0, "E0S0")), 1);
  });

  it("认不出的房间名算无穷远，别让它混进外矿名单", () => {
    assert.equal(worldRange(at(25, 25, "sim"), at(25, 25, "E28S36")), Infinity);
  });
});

describe("侦察兵退役", () => {
  class FakePosition {
    public constructor(public x: number, public y: number, public roomName: string) {}

    public inRangeTo(): boolean {
      return false;
    }
  }

  interface FakeScout {
    memory: { role: string; room: string; targetRoom?: string };
    dead: boolean;
  }

  function scout(): FakeScout {
    const creep: FakeScout = { memory: { role: "scout", room: "W1N1" }, dead: false };

    return Object.assign(creep, {
      name: "scout_1",
      room: { name: "W1N1" },
      pos: new FakePosition(25, 25, "W1N1"),
      say: () => 0,
      suicide: () => {
        creep.dead = true;
        return 0;
      }
    });
  }

  let saved: { Game: unknown; Memory: unknown; RoomPosition: unknown; PathFinder: unknown };

  beforeEach(() => {
    const context = global as unknown as typeof saved;
    saved = { Game: context.Game, Memory: context.Memory, RoomPosition: context.RoomPosition, PathFinder: context.PathFinder };

    context.Game = {
      rooms: { W1N1: { name: "W1N1", memory: {} } },
      map: { describeExits: () => ({ "1": "W1N2", "7": "W2N1" }) },
      time: 1000
    };
    // 级别定成 error，退役那行 info 日志就不会混进测试输出
    context.Memory = { settings: { level: "error" }, rooms: {} };
    context.RoomPosition = FakePosition;
    // 寻路交给 travelTo 的"无路"分支收场，这里只关心去不去死
    context.PathFinder = { search: () => ({ path: [] }) };
  });

  afterEach(() => {
    Object.assign(global, saved);
  });

  it("邻房都探完了就自尽", () => {
    Memory.rooms.W1N2 = { scouted: 1000 } as RoomMemory;
    Memory.rooms.W2N1 = { scouted: 1000, unusable: "reserved" } as RoomMemory;

    const creep = scout();
    runScout(creep as unknown as Creep);

    // 复查周期两万 tick，而它只活一千五，所以"现在没活"就是"这辈子没活"了。
    // 留着不只是白吃 CPU：探完最后一个房间时它正站在两房交界处，站不住
    assert.isTrue(creep.dead, "留着它就会在边界上来回弹");
  });

  it("还有没探过的房间就继续跑", () => {
    Memory.rooms.W1N2 = { scouted: 1000 } as RoomMemory;

    const creep = scout();
    runScout(creep as unknown as Creep);

    assert.isFalse(creep.dead);
    assert.equal(creep.memory.targetRoom, "W2N1");
  });
});

describe("Memory 清理对外矿的保护", () => {
  const owned = { controller: { my: true } };
  let savedGame: unknown;
  let savedMemory: unknown;

  beforeEach(() => {
    const context = global as unknown as { Game: unknown; Memory: unknown };
    savedGame = context.Game;
    savedMemory = context.Memory;

    context.Game = {
      rooms: { W1N1: owned },
      map: { describeExits: () => ({ "1": "W1N2", "3": "W2N1" }) }
    };
  });

  // 别把假的 Game 留给后面的测试文件，那种失败极难定位
  afterEach(() => {
    const context = global as unknown as { Game: unknown; Memory: unknown };
    context.Game = savedGame;
    context.Memory = savedMemory;
  });

  it("留住外矿房间的记录，那是派人出门的唯一依据", () => {
    (global as unknown as { Memory: unknown }).Memory = {
      rooms: {
        W1N1: {},
        W2N1: { home: "W1N1", sources: { abc: { x: 10, y: 20 } }, scouted: 1 }
      }
    };

    cleanupRoomMemory();

    assert.isDefined(Memory.rooms.W2N1, "删了就得重新派侦察兵，而矿工在那之前无处可去");
  });

  it("留住邻房的侦察结论，包括判死的那些", () => {
    (global as unknown as { Memory: unknown }).Memory = {
      rooms: {
        W1N1: {},
        W1N2: { scouted: 1, unusable: "reserved" }
      }
    };

    cleanupRoomMemory();

    assert.isDefined(Memory.rooms.W1N2, "清掉的话过几百 tick 又会派人去把同一件事发现一遍");
  });

  it("清掉无关房间，比如 respawn 之后的旧家", () => {
    (global as unknown as { Memory: unknown }).Memory = {
      rooms: {
        W1N1: {},
        E9S9: { anchor: { x: 25, y: 25 } }
      }
    };

    const removed = cleanupRoomMemory();

    assert.equal(removed, 1);
    assert.isUndefined(Memory.rooms.E9S9);
  });

  it("基地都不在了的外矿跟着一起清", () => {
    (global as unknown as { Memory: unknown }).Memory = {
      rooms: {
        W1N1: {},
        E9S8: { home: "E9S9", scouted: 1 }
      }
    };

    cleanupRoomMemory();

    assert.isUndefined(Memory.rooms.E9S8, "旧家的外矿留着只是白占 Memory");
  });
});
