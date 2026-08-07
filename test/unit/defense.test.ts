import { assert } from "chai";
import { bodyCost, bodyFor } from "../../src/utils/body";
import { defendersNeeded, hostilesIn, intrudersIn, localDefenderCount, runDefender, stillArmed } from "../../src/roles/defender";
import { shouldActivateSafeMode } from "../../src/managers/safeMode";
import { chooseTowerAction, rampartHitsTarget, towerEngageRange } from "../../src/managers/tower";
import { installGameConstants } from "./mock";

function countPart(body: BodyPartConstant[], part: BodyPartConstant): number {
  return body.filter(candidate => candidate === part).length;
}

/** 塔只用到 pos.getRangeTo，用切比雪夫距离顶替，省得造真的 RoomPosition */
function at(x: number, y: number): RoomPosition {
  return {
    x,
    y,
    getRangeTo: (other: { x: number; y: number }) => Math.max(Math.abs(x - other.x), Math.abs(y - other.y))
  } as unknown as RoomPosition;
}

function creepAt(x: number, y: number): Creep {
  return { pos: at(x, y) } as unknown as Creep;
}

function wall(x: number, y: number, hits: number, hitsMax: number): Structure {
  return { pos: at(x, y), hits, hitsMax } as unknown as Structure;
}

const FULL = { pos: at(25, 25), energy: 1000 };

describe("敌人和竞争者", () => {
  /** 造一个只有身体部件和位置的假 creep，威胁判定就看这两样 */
  function foe(parts: BodyPartConstant[], x = 30, y = 25): unknown {
    return { pos: at(x, y), body: parts.map(type => ({ type, hits: 100 })) };
  }

  function roomWith(hostiles: unknown[], towers = 0): Room {
    return {
      name: "W1N1",
      find: (type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return hostiles;
        if (type === FIND_MY_STRUCTURES) return new Array(towers).fill({ structureType: "tower" });
        return [];
      }
    } as unknown as Room;
  }

  let saved: unknown;

  beforeEach(() => {
    installGameConstants();
    saved = (global as unknown as { Game: unknown }).Game;
    // 威胁结果按 tick 缓存，每个用例换一个 tick 才不会读到上一个的账
    (global as unknown as { Game: unknown }).Game = { time: Math.floor(Math.random() * 1e6), creeps: {} };
  });

  afterEach(() => {
    (global as unknown as { Game: unknown }).Game = saved;
  });

  it("带 ATTACK 的算武装敌人", () => {
    const room = roomWith([foe(["attack", "move"])]);

    assert.lengthOf(hostilesIn(room), 1);
  });

  it("邻居的矿工和运输队不算敌人，只算竞争者", () => {
    const room = roomWith([foe(["work", "work", "carry", "move"]), foe(["carry", "carry", "move", "move"])]);

    // 这是那次"外矿被白让出去"的根因：见到任何敌对 creep 就记遇袭、停 1500 tick、
    // 全员撤回，而对方那些人一个攻击部件都没带
    assert.isEmpty(hostilesIn(room), "它们打不死我们的人，没有撤退的理由");
    assert.lengthOf(intrudersIn(room), 2, "但它们在抢矿，塔该记着这笔账");
  });

  it("带 HEAL 的也算武装：单独一个奶妈无害，但它后面跟着的不是", () => {
    const room = roomWith([foe(["heal", "move"])]);

    assert.lengthOf(hostilesIn(room), 1);
  });

  it("武装的和经济的混在一起时分得开", () => {
    const room = roomWith([foe(["ranged_attack", "move"]), foe(["work", "carry", "move"])]);

    assert.lengthOf(hostilesIn(room), 1);
    assert.lengthOf(intrudersIn(room), 2, "全部敌对 creep 都在里面，武装的是它的子集");
  });
});

describe("按战力派兵", () => {
  /** 只关心身体部件的假敌人：战力折算就看它带了几个能出手的部件 */
  function foe(parts: BodyPartConstant[]): Creep {
    return { body: parts.map(type => ({ type })) } as unknown as Creep;
  }

  it("没敌人就一个不派", () => {
    assert.equal(defendersNeeded([], 1300), 0);
  });

  it("一堆小体型敌人一个满编兵就够，不照人头 1v1", () => {
    // 1300 预算的 defender 有 10 个 ATTACK，三个各带 1 攻的杂兵总战力才 3
    const swarm = [foe(["attack", "move"]), foe(["attack", "move"]), foe(["attack", "move"])];

    assert.equal(defendersNeeded(swarm, 1300), 1, "一个兵抵三个小兵，派三个是浪费两个");
  });

  it("敌人体量够大才多派，按战力比例上去", () => {
    // 我方一个兵 10 攻；对面两个各 15 攻，总战力 30，要三个兵才压得过
    const heavy = [foe(new Array(15).fill("attack")), foe(new Array(15).fill("attack"))];

    assert.equal(defendersNeeded(heavy, 1300), 3);
  });

  it("敌人带治疗就再加一个，靠集火压过它的回血", () => {
    // 5 攻 3 奶，战力 8，除以 10 是一个兵；治疗那一个是集火余量
    const healed = [foe([...new Array(5).fill("attack"), "heal", "heal", "heal"])];

    assert.equal(defendersNeeded(healed, 1300), 2);
  });

  it("兵造得小的时候（预算低）该派的头数会相应变多", () => {
    // 300 预算的 defender 只有 2 个 ATTACK，对上 6 攻的敌人就要三个兵
    const enemy = [foe(new Array(6).fill("attack"))];

    assert.equal(defendersNeeded(enemy, 300), 3);
  });
});

describe("本土早期防御兵只打 NPC", () => {
  /** 带归属的假敌人：默认系统入侵者，玩家传别的用户名 */
  function foe(parts: BodyPartConstant[], username = "Invader"): Creep {
    return { body: parts.map(type => ({ type })), owner: { username } } as unknown as Creep;
  }

  it("没敌人就一个不派", () => {
    assert.equal(localDefenderCount([], 1300, 3), 0);
  });

  it("NPC 入侵者按战力少孵，一个满编兵扫一群杂兵", () => {
    const swarm = [foe(["attack", "move"]), foe(["attack", "move"]), foe(["attack", "move"])];

    assert.equal(localDefenderCount(swarm, 1300, 3), 1, "三个小 NPC 一个满编兵就够");
  });

  it("敌对玩家来袭一个地面兵都不孵，那种仗交给塔和 rampart", () => {
    const raiders = [foe(["attack", "move"], "Napoleon"), foe(["attack", "move"], "Napoleon")];

    assert.equal(localDefenderCount(raiders, 1300, 3), 0, "地面兵打不过玩家，硬孵只会把能量喂掉、拖进死循环");
  });

  it("NPC 里混进一个玩家也不孵：有玩家就是打不过的仗", () => {
    const mixed = [foe(["attack", "move"]), foe(["attack", "move"], "Napoleon")];

    assert.equal(localDefenderCount(mixed, 1300, 3), 0);
  });

  it("大波 NPC 按战力超了上限，也只封在上限", () => {
    const horde = [foe(new Array(20).fill("attack")), foe(new Array(20).fill("attack"))];

    assert.equal(localDefenderCount(horde, 1300, 3), 3);
  });
});

describe("缴械的防御兵退场", () => {
  /** 身上带一组部件，attackHits=0 表示攻击件被啃光 */
  function body(parts: { type: BodyPartConstant; hits: number }[]): Creep {
    let dead = false;
    return {
      body: parts,
      memory: {},
      suicide: () => {
        dead = true;
        return OK;
      },
      say: () => OK,
      get dead() {
        return dead;
      }
    } as unknown as Creep & { dead: boolean };
  }

  it("还有能出手的部件就算武装", () => {
    const creep = body([
      { type: "tough", hits: 0 },
      { type: "attack", hits: 100 },
      { type: "move", hits: 100 }
    ]);

    assert.isTrue(stillArmed(creep));
  });

  it("攻击件被打光（hits 归零）就不算武装", () => {
    const creep = body([
      { type: "tough", hits: 0 },
      { type: "attack", hits: 0 },
      { type: "move", hits: 100 }
    ]);

    assert.isFalse(stillArmed(creep));
  });

  it("缴械的防御兵自尽腾编制，好让 spawn 补个满编的", () => {
    const creep = body([
      { type: "attack", hits: 0 },
      { type: "move", hits: 100 }
    ]) as Creep & { dead: boolean; room: Room };
    creep.room = { find: () => [] } as unknown as Room;
    (global as unknown as { Game: { time: number; creeps: unknown }; Memory: unknown }).Game = { time: 1, creeps: {} };
    (global as unknown as { Memory: unknown }).Memory = { settings: {} };

    runDefender(creep);

    assert.isTrue(creep.dead, "没治疗、打不动人还赖着，应该自尽");
  });
});

describe("塔的目标选择", () => {
  it("有敌人就开火，其它一概不管", () => {
    const action = chooseTowerAction(FULL, {
      hostiles: [creepAt(30, 25)],
      wounded: [creepAt(26, 25)],
      damaged: [wall(24, 25, 1, 100)]
    });

    assert.equal(action.kind, "attack", "边治疗边挨打只是在比谁的能量先见底");
  });

  it("打最近的那个，因为塔的伤害随距离衰减", () => {
    const near = creepAt(28, 25);
    const action = chooseTowerAction(FULL, {
      hostiles: [creepAt(45, 25), near, creepAt(35, 30)],
      wounded: [],
      damaged: []
    });

    assert.equal(action.kind, "attack");
    assert.strictEqual(action.kind === "attack" && action.target, near);
  });

  it("开火距离按塔到 controller 抬高：分房 bunker 远离入口时不能卡死在 15", () => {
    // E28S35：spawn (14,27) → controller (32,10) = 18，再加入口余量 5 → 23
    const towerPos = at(14, 27);
    const controller = { my: true, pos: at(32, 10) };
    assert.equal(towerEngageRange(towerPos, controller), 23);

    const atController = creepAt(32, 10);
    const pastEntrance = creepAt(35, 7); // 相对塔约 21，仍在 23 内
    const action = chooseTowerAction(
      { pos: towerPos, energy: 1000, engageRange: towerEngageRange(towerPos, controller) },
      { hostiles: [pastEntrance, atController], wounded: [], damaged: [] }
    );

    assert.equal(action.kind, "attack");
    assert.strictEqual(action.kind === "attack" && action.target, atController, "先打更近的，且 controller 必须在射程内");
  });

  it("伤害封底之外的遛塔不开火：≥20 伤不再降，再远开枪只是被骗能量", () => {
    // 塔在 (25,25)，默认 engage=20；(46,25) 是 21 格
    const action = chooseTowerAction(FULL, {
      hostiles: [creepAt(46, 25)],
      wounded: [],
      damaged: []
    });

    assert.equal(action.kind, "idle", "够不着有效射程就别开枪");
  });

  it("远处武装敌人不挡治疗：遛塔时自家伤员照样治", () => {
    const patient = creepAt(26, 25);
    const action = chooseTowerAction(FULL, {
      hostiles: [creepAt(46, 25)],
      wounded: [patient],
      damaged: []
    });

    assert.equal(action.kind, "heal");
    assert.strictEqual(action.kind === "heal" && action.target, patient);
  });

  it("没敌人才轮到治疗，治最近的", () => {
    const near = creepAt(24, 25);
    const action = chooseTowerAction(FULL, {
      hostiles: [],
      wounded: [creepAt(40, 40), near],
      damaged: [wall(24, 25, 1, 100)]
    });

    assert.equal(action.kind, "heal");
    assert.strictEqual(action.kind === "heal" && action.target, near);
  });

  it("闲下来修最惨的那个，比的是残血比例不是绝对血量", () => {
    const worst = wall(20, 20, 100, 5000);
    const action = chooseTowerAction(FULL, {
      hostiles: [],
      wounded: [],
      damaged: [wall(21, 21, 3000, 5000), worst]
    });

    assert.equal(action.kind, "repair");
    assert.strictEqual(action.kind === "repair" && action.target, worst);
  });

  it("rampart 按软上限算残血，不会因为 hitsMax 三亿永远压过别的建筑", () => {
    const road = wall(21, 21, 1000, 5000);
    road.structureType = "road";
    const rampart = wall(20, 20, 9_000, 300_000_000);
    rampart.structureType = "rampart";
    rampart.room = { controller: { level: 3 } } as Room;

    // 软上限 10000，rampart 已到 90%；路只有 20%。该修路
    const action = chooseTowerAction(FULL, {
      hostiles: [],
      wounded: [],
      damaged: [rampart, road]
    });

    assert.equal(action.kind, "repair");
    assert.strictEqual(action.kind === "repair" && action.target, road);
  });

  it("rampart 血量目标随等级抬，但不冲着三亿天花板", () => {
    assert.equal(rampartHitsTarget(4), 10_000);
    assert.equal(rampartHitsTarget(5), 50_000);
    assert.equal(rampartHitsTarget(6), 100_000);
    assert.isBelow(rampartHitsTarget(8), 1_000_000);
  });

  it("能量低于警戒线就不修了，攒着应急", () => {
    const action = chooseTowerAction(
      { pos: at(25, 25), energy: 400 },
      { hostiles: [], wounded: [], damaged: [wall(20, 20, 1, 5000)] }
    );

    assert.equal(action.kind, "idle", "修理是闲活，不能把开火的本钱花光");
  });

  it("能量见底也照样开火，打人比留钱要紧", () => {
    const action = chooseTowerAction(
      { pos: at(25, 25), energy: 20 },
      { hostiles: [creepAt(26, 26)], wounded: [], damaged: [] }
    );

    assert.equal(action.kind, "attack");
  });

  it("武装敌人清完了才轮到抢矿的邻居", () => {
    const armed = creepAt(35, 25);
    const intruder = creepAt(28, 25);
    const action = chooseTowerAction(FULL, { hostiles: [armed], intruders: [intruder], wounded: [], damaged: [] });

    // 就算邻居站得更近也先打远处那个：它才是能造成伤害的
    assert.equal(action.kind, "attack");
    assert.equal(action.kind === "attack" ? action.target : undefined, armed, "先打打得死人的那个");
  });

  it("近处的邻居打，远处的不追", () => {
    const near = chooseTowerAction(FULL, { hostiles: [], intruders: [creepAt(32, 25)], wounded: [], damaged: [] });
    const far = chooseTowerAction(FULL, { hostiles: [], intruders: [creepAt(48, 25)], wounded: [], damaged: [] });

    // 10 格上还有 450 伤害，两炮报销一个 300 能量的矿工；20 格外只剩 150，
    // 那是拿自己的能量给对方付通行费
    assert.equal(near.kind, "attack");
    assert.equal(far.kind, "idle");
  });

  it("什么都没有就闲着", () => {
    const action = chooseTowerAction(FULL, { hostiles: [], wounded: [], damaged: [] });

    assert.equal(action.kind, "idle");
  });
});

describe("安全模式", () => {
  beforeEach(() => installGameConstants());

  function controller(extra: Partial<{ safeMode: number; safeModeAvailable: number; safeModeCooldown: number }> = {}) {
    return {
      my: true,
      safeModeAvailable: 1,
      activateSafeMode: () => 0,
      ...extra
    };
  }

  it("武装敌人拆掉 spawn 就该拉闸", () => {
    assert.isTrue(
      shouldActivateSafeMode(controller(), 1, [{ event: EVENT_OBJECT_DESTROYED, data: { type: "spawn" } }])
    );
  });

  it("没敌人时不拉：多半是自己拆迁或自然朽掉", () => {
    assert.isFalse(
      shouldActivateSafeMode(controller(), 0, [{ event: EVENT_OBJECT_DESTROYED, data: { type: "extension" } }])
    );
  });

  it("路和容器被毁不拉：那不是破防", () => {
    assert.isFalse(
      shouldActivateSafeMode(controller(), 2, [{ event: EVENT_OBJECT_DESTROYED, data: { type: "road" } }])
    );
    assert.isFalse(
      shouldActivateSafeMode(controller(), 2, [{ event: EVENT_OBJECT_DESTROYED, data: { type: "container" } }])
    );
  });

  it("没有可用次数或在冷却中就不试", () => {
    assert.isFalse(
      shouldActivateSafeMode(controller({ safeModeAvailable: 0 }), 1, [
        { event: EVENT_OBJECT_DESTROYED, data: { type: "tower" } }
      ])
    );
    assert.isFalse(
      shouldActivateSafeMode(controller({ safeModeCooldown: 1000 }), 1, [
        { event: EVENT_OBJECT_DESTROYED, data: { type: "tower" } }
      ])
    );
  });

  it("已经在安全模式里不再重复激活", () => {
    assert.isFalse(
      shouldActivateSafeMode(controller({ safeMode: 5000 }), 3, [
        { event: EVENT_OBJECT_DESTROYED, data: { type: "spawn" } }
      ])
    );
  });
});

describe("防御兵体型", () => {
  it("ATTACK 和 MOVE 一比一，追得上入侵者", () => {
    const body = bodyFor("defender", 780);

    assert.equal(countPart(body, "attack"), countPart(body, "move"));
    assert.equal(countPart(body, "attack"), 6);
  });

  it("零头买 TOUGH 当血包，不买用不上的 CARRY", () => {
    const body = bodyFor("defender", 300);

    assert.notInclude(body, "carry", "给兵塞 CARRY 等于白送对方几刀");
    assert.isAbove(countPart(body, "tough"), 0);
    assert.equal(bodyCost(body), 300, "300 预算一点不剩");
  });

  it("TOUGH 排在最前面挨刀，MOVE 垫底保证残血还能动", () => {
    const body = bodyFor("defender", 300);

    assert.equal(body[0], "tough");
    assert.equal(body[body.length - 1], "move");
  });

  it("再有钱也不超过 50 个部件", () => {
    const body = bodyFor("defender", 12900);

    assert.isAtMost(body.length, 50);
    assert.isAtMost(bodyCost(body), 12900);
  });

  it("协防兵零头买 MOVE 不买 TOUGH：跨房赶路 1t/格，别被血包拖成 2t", () => {
    // 除不尽一组（130）的预算最容易掉进"零头全买 TOUGH"的坑，逐档扫一遍
    for (let budget = 400; budget <= 1300; budget += 70) {
      const body = bodyFor("guardian", budget);
      const movers = countPart(body, "move");
      const others = body.length - movers;

      assert.notInclude(body, "tough", `预算 ${budget} 的协防兵不该带 TOUGH，那会把它拖慢`);
      assert.isAtLeast(movers, others, `预算 ${budget} 的协防兵 MOVE 不够拖动身子，平地上要 2t 才动一格`);
    }
  });
});
