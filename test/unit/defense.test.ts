import { assert } from "chai";
import { bodyCost, bodyFor } from "../../src/utils/body";
import { hostilesIn, intrudersIn } from "../../src/roles/defender";
import { chooseTowerAction } from "../../src/managers/tower";
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
});
