import { assert } from "chai";
import { bodyCost, bodyFor } from "../../src/utils/body";
import { chooseTowerAction } from "../../src/managers/tower";

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
