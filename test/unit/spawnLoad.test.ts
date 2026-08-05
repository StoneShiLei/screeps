import {
  CLAIM_LIFETIME,
  CROWDED,
  PARTS_PER_SPAWN,
  loadByRole,
  partsWeight,
  sampleSpawnBusy,
  smoothBusy,
  spawnHeadroom,
  spawnLoadOf,
  weightOf
} from "../../src/managers/spawnLoad";
import { assert } from "chai";

describe("孵化预算", () => {
  it("一个 spawn 一轮寿命造得出 500 个部件", () => {
    // 常驻编制的硬上限就是这个数：部件要 3 tick 一个，而 creep 活 1500 tick。
    // 跟能量多少无关，能量再多也变不出孵化时间
    assert.equal(PARTS_PER_SPAWN, 500);
  });

  it("普通 creep 的部件当量就是部件数", () => {
    assert.equal(partsWeight(10), 10);
  });

  it("带 CLAIM 的按两倍半算，因为 600 tick 就得换人", () => {
    assert.equal(partsWeight(2, CLAIM_LIFETIME), 5);
  });

  it("预定员那两个部件，占的孵化时间和一个五部件的 creep 一样多", () => {
    // 看体型它是全场最小的，看孵化预算它顶一个搬运工。外矿开多了之后
    // 这笔账最容易被忽略：名单上多一个房间就多一个预定员，等于多五个部件
    assert.equal(partsWeight(2, CLAIM_LIFETIME), partsWeight(5));
  });
});

describe("现役 creep 的当量", () => {
  function creep(...parts: string[]): Creep {
    return { body: parts.map(type => ({ type })) } as unknown as Creep;
  }

  it("按部件数算", () => {
    assert.equal(weightOf(creep("work", "work", "move")), 3);
  });

  it("认出 CLAIM 就翻到两倍半", () => {
    assert.equal(weightOf(creep("claim", "move")), 5);
  });
});

describe("忙碌率平滑", () => {
  it("第一次采样直接就是当前值，别从零慢慢爬", () => {
    assert.equal(smoothBusy(undefined, 1), 1);
  });

  it("之后每次只挪一小步，单 tick 的抖动带不动它", () => {
    const next = smoothBusy(0.5, 1);

    assert.isAbove(next, 0.5);
    assert.isBelow(next, 0.52, "时间常数一百 tick 上下，看的是趋势不是这一 tick");
  });

  it("一直忙就会收敛到满", () => {
    let rate = 0;
    for (let i = 0; i < 1000; i++) rate = smoothBusy(rate, 1);

    assert.isAbove(rate, 0.99);
  });
});

describe("按房间统计编制", () => {
  function room(name: string, spawns: number, busy?: number): Room {
    return {
      name,
      memory: busy === undefined ? {} : { spawnBusy: busy },
      find: () => new Array(spawns).fill({})
    } as unknown as Room;
  }

  function hire(room: string, role: string, ...parts: string[]): void {
    const creeps = (global as unknown as { Game: { creeps: Record<string, unknown> } }).Game.creeps;
    creeps[`${role}_${Object.keys(creeps).length}`] = {
      memory: { role, room },
      body: parts.map(type => ({ type }))
    };
  }

  let saved: unknown;
  let tick = 5000;

  beforeEach(() => {
    const context = global as unknown as { Game: unknown };
    saved = context.Game;
    // 每个用例换一个 tick：编制是按 tick 缓存的，同一 tick 里问第二遍拿的是旧账
    context.Game = { creeps: {}, time: tick++ };
  });

  afterEach(() => {
    (global as unknown as { Game: unknown }).Game = saved;
  });

  it("只算自己房间的人", () => {
    hire("W1N1", "miner", "work", "work", "move");
    hire("W2N2", "miner", "work", "work", "move");

    assert.equal(spawnLoadOf(room("W1N1", 1)).parts, 3);
  });

  it("容量按 spawn 个数翻倍", () => {
    assert.equal(spawnLoadOf(room("W1N1", 2)).capacity, 1000);
  });

  it("余量留了一成半，孵化排不满是常态", () => {
    hire("W1N1", "hauler", "carry", "move");

    // 卡满的结果是永远差一点：能量断一下、谁死得不巧，都会白丢几十 tick
    assert.equal(spawnHeadroom(room("W1N1", 1)), 500 * CROWDED - 2);
  });

  it("忙碌率从 Memory 里读，那是逐 tick 攒出来的", () => {
    assert.equal(spawnLoadOf(room("W1N1", 1, 0.62)).busy, 0.62);
  });

  it("按角色分开算，才看得出孵化时间被谁吃着", () => {
    hire("W1N1", "upgrader", "work", "carry", "move");
    hire("W1N1", "upgrader", "work", "carry", "move");
    hire("W1N1", "reserver", "claim", "move");

    const byRole = loadByRole(room("W1N1", 1));

    assert.equal(byRole.upgrader, 6);
    assert.equal(byRole.reserver, 5, "两个部件的预定员，占的是五个部件的孵化时间");
  });

  it("没有 spawn 的房间不采样，免得把零忙碌率记进去", () => {
    const empty = room("W1N1", 0);
    sampleSpawnBusy(empty, []);

    assert.isUndefined(empty.memory.spawnBusy);
  });
});
