import { assert } from "chai";
import { LogisticsEntry, chooseEntry, deductReservations } from "../../src/managers/logistics";
import { bodyCost, bodyFor } from "../../src/utils/body";
import { haulersForBacklog } from "../../src/managers/spawnManager";

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
