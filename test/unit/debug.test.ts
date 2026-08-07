import { assert } from "chai";
import { COMMANDS, helpText } from "../../src/cli/commands";
import {
  compactNumber,
  estimateTicksToLevel,
  formatDuration,
  panelOrigin,
  panelWidth,
  progressBar,
  sampleProgress
} from "../../src/managers/panel";
import { announceDeploy } from "../../src/utils/deploy";
import { announce, escapeHtml, shouldLog } from "../../src/utils/logger";
import { decodeCells, encodeCells } from "../../src/planner/roads";
import { LOG_LEVELS, VISUAL_MODULES, settings } from "../../src/utils/settings";

// 这个文件为了测开关会直接改全局，跑完复原，免得后面的测试踩到残留
const savedGame = (global as any).Game;
const savedMemory = (global as any).Memory;

afterEach(() => {
  (global as any).Game = savedGame;
  (global as any).Memory = savedMemory;
});

describe("日志级别过滤", () => {
  it("当前级别之下的消息都放行", () => {
    assert.isTrue(shouldLog("info", "error"));
    assert.isTrue(shouldLog("info", "warn"));
    assert.isTrue(shouldLog("info", "info"));
  });

  it("当前级别之上的消息挡住", () => {
    assert.isFalse(shouldLog("info", "debug"));
    assert.isFalse(shouldLog("error", "warn"));
  });

  it("debug 级别放行全部", () => {
    for (const level of LOG_LEVELS) {
      assert.isTrue(shouldLog("debug", level), level);
    }
  });
});

describe("日志转义", () => {
  it("尖括号和 & 都换成实体，不然会被当成标签渲染", () => {
    assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
    assert.equal(escapeHtml("a & b"), "a &amp; b");
  });

  it("先换 & 再换尖括号，否则实体本身会被二次转义", () => {
    assert.equal(escapeHtml("&lt;"), "&amp;lt;");
  });

  it("正常日志内容一个字都不动", () => {
    assert.equal(escapeHtml("E28S36 孵化 miner_123，体型 6 部件"), "E28S36 孵化 miner_123，体型 6 部件");
  });
});

describe("announce 去重", () => {
  beforeEach(() => {
    (global as any).Memory = { settings: { level: "info", say: true, visuals: {} } };
  });

  it("内容没变时不重复喊", () => {
    let said = 0;
    const creep = {
      memory: {} as CreepMemory,
      say: () => {
        said++;
        return 0;
      }
    };

    announce(creep as unknown as Creep, "待命");
    announce(creep as unknown as Creep, "待命");
    announce(creep as unknown as Creep, "待命");

    assert.equal(said, 1, "待命从每 tick 一次降到进入状态时一次");
    assert.equal(creep.memory.lastSay, "待命");
  });

  it("内容变了才再喊", () => {
    let said = 0;
    const creep = {
      memory: {} as CreepMemory,
      say: () => {
        said++;
        return 0;
      }
    };

    announce(creep as unknown as Creep, "取货");
    announce(creep as unknown as Creep, "送货");

    assert.equal(said, 2);
  });

  it("关掉 say 就完全不喊", () => {
    (global as any).Memory.settings.say = false;
    let said = 0;
    const creep = {
      memory: {} as CreepMemory,
      say: () => {
        said++;
        return 0;
      }
    };

    announce(creep as unknown as Creep, "待命");
    assert.equal(said, 0);
  });
});

describe("升级 ETA", () => {
  it("速率还没采出来时估不了", () => {
    assert.isUndefined(estimateTicksToLevel(undefined, 100, 1000));
    assert.isUndefined(estimateTicksToLevel({ tick: 1, progress: 100, rate: 0 }, 100, 1000));
  });

  it("按平滑速率推算剩余 tick", () => {
    const sample = { tick: 100, progress: 500, rate: 10 };
    assert.equal(estimateTicksToLevel(sample, 500, 1000), 50);
  });

  it("已经满了就返回零", () => {
    assert.equal(estimateTicksToLevel({ tick: 1, progress: 1000, rate: 5 }, 1000, 1000), 0);
  });

  it("时长用人类可读单位，短时才带 t", () => {
    assert.match(formatDuration(10), /10t/);
    assert.match(formatDuration(1000), /^\d+m$/);
    assert.match(formatDuration(100000), /h|d/);
  });

  it("进度条长度固定", () => {
    assert.equal(progressBar(0), "░░░░░░░░░░");
    assert.equal(progressBar(0.5), "█████░░░░░");
    assert.equal(progressBar(1), "██████████");
    assert.equal(progressBar(0.5).length, 10);
  });

  it("大数缩写省面板宽度", () => {
    assert.equal(compactNumber(42), "42");
    assert.equal(compactNumber(1500), "1.5k");
    assert.equal(compactNumber(12400), "12k");
    assert.equal(compactNumber(2_500_000), "2.5M");
  });
});

describe("升级速率采样", () => {
  const SAMPLE_INTERVAL = 50;

  function roomWith(progress: number, level = 4): { room: any; controller: any } {
    return {
      room: { memory: {} as RoomMemory },
      controller: { level, progress }
    };
  }

  beforeEach(() => {
    (global as any).Game = { time: 1000 };
  });

  it("第一次只记基准，还算不出速率", () => {
    const { room, controller } = roomWith(500);

    sampleProgress(room, controller);

    assert.deepEqual(room.memory.progressSample, { tick: 1000, progress: 500, rate: 0 });
  });

  it("没到采样间隔就不动，免得短期抖动带偏速率", () => {
    const { room, controller } = roomWith(500);
    room.memory.progressSample = { tick: 990, progress: 400, rate: 7 };

    sampleProgress(room, controller);

    assert.equal(room.memory.progressSample.tick, 990, "间隔不够时连采样点都不该挪");
    assert.equal(room.memory.progressSample.rate, 7);
  });

  it("隔满一个间隔后按实际增量算速率", () => {
    const { room, controller } = roomWith(1000);
    room.memory.progressSample = { tick: 1000 - SAMPLE_INTERVAL, progress: 500, rate: 0 };

    sampleProgress(room, controller);

    // 50 tick 涨了 500，第一次有速率时直接取瞬时值，不打折
    assert.equal(room.memory.progressSample.rate, 10);
    assert.equal(room.memory.progressSample.progress, 1000);
  });

  it("已有速率时新采样只占三成，抹平单次波动", () => {
    const { room, controller } = roomWith(1000);
    room.memory.progressSample = { tick: 1000 - SAMPLE_INTERVAL, progress: 500, rate: 20 };

    sampleProgress(room, controller);

    // 瞬时 10、旧值 20，平滑后 20*0.7 + 10*0.3
    assert.closeTo(room.memory.progressSample.rate, 17, 1e-9);
  });

  it("升级那一刻 progress 归零，不能算出负速率", () => {
    const { room, controller } = roomWith(30);
    room.memory.progressSample = { tick: 1000 - SAMPLE_INTERVAL, progress: 9000, rate: 12 };

    sampleProgress(room, controller);

    assert.equal(room.memory.progressSample.rate, 12, "沿用升级前的速率，等下一轮重新采");
    assert.equal(room.memory.progressSample.progress, 30, "基准要跟着归零，否则下一轮又是负的");
  });

  it("满级之后不再采样，Memory 里的记录也清掉", () => {
    const { room, controller } = roomWith(0, 8);
    room.memory.progressSample = { tick: 900, progress: 500, rate: 5 };

    sampleProgress(room, controller);

    assert.isUndefined(room.memory.progressSample);
  });
});

describe("道路坐标编码", () => {
  it("编解码往返之后坐标不变", () => {
    const cells = [
      { x: 0, y: 0 },
      { x: 49, y: 49 },
      { x: 13, y: 30 },
      { x: 8, y: 21 }
    ];

    assert.deepEqual(decodeCells(encodeCells(cells)), cells);
  });

  it("一格只占两个字符", () => {
    assert.lengthOf(encodeCells([{ x: 1, y: 2 }]), 2);
    assert.lengthOf(encodeCells([{ x: 1, y: 2 }, { x: 3, y: 4 }]), 4);
  });

  it("编出来全是可打印 ASCII，进 JSON 不会被转义放大", () => {
    const packed = encodeCells([{ x: 0, y: 0 }, { x: 49, y: 49 }, { x: 25, y: 37 }]);

    for (const character of packed) {
      const code = character.charCodeAt(0);
      assert.isAtLeast(code, 0x20, `${character} 是控制字符`);
      assert.isBelow(code, 0x7f, `${character} 超出 ASCII`);
    }
    // 一趟 JSON 之后长度不变，才说明真没被转义
    assert.lengthOf(JSON.stringify(packed), packed.length + 2);
  });

  it("空规划编出空串", () => {
    assert.equal(encodeCells([]), "");
    assert.deepEqual(decodeCells(""), []);
  });
});

describe("面板底框", () => {
  it("宽度跟着最长那行走", () => {
    const narrow = panelWidth([{ text: "RCL4", color: "#fff" }]);
    const wide = panelWidth([{ text: "RCL4", color: "#fff" }, { text: "CPU 12.3/20 桶 9800", color: "#fff" }]);

    assert.isAbove(wide, narrow, "多了一行长的，底框就得跟着变宽");
  });

  it("汉字按整个字号算，比同样个数的 ASCII 宽", () => {
    const chinese = panelWidth([{ text: "降级倒计时", color: "#fff" }]);
    const ascii = panelWidth([{ text: "abcde", color: "#fff" }]);

    assert.isAbove(chinese, ascii);
  });

  it("落点钉在左上角，不跟着控制器走", () => {
    const origin = panelOrigin(12, 8);
    assert.isBelow(origin.x, 1, "贴左边");
    assert.isBelow(origin.y, 1.2, "贴顶边");
  });
});

describe("deploy announce", () => {
  beforeEach(() => {
    (global as any).Memory = { settings: { level: "info" } };
  });

  it("announces once per global boot", () => {
    let logs = 0;
    const prev = console.logUnsafe;
    console.logUnsafe = () => {
      logs++;
    };

    try {
      announceDeploy();
      assert.equal(logs, 1);

      announceDeploy();
      assert.equal(logs, 1, "同一次加载不重复");
    } finally {
      console.logUnsafe = prev;
    }
  });
});

describe("命令注册表", () => {
  it("每条命令都有用法和说明", () => {
    for (const [name, command] of Object.entries(COMMANDS)) {
      assert.isNotEmpty(command.usage, name);
      assert.isNotEmpty(command.describe, name);
      assert.isFunction(command.run, name);
    }
  });

  it("help 覆盖注册表里的每一条", () => {
    const text = helpText();
    for (const command of Object.values(COMMANDS)) {
      assert.include(text, command.usage, `help 漏了 ${command.usage}`);
    }
  });

  it("调试模块名和设置里的列表对得上", () => {
    const describe = COMMANDS["debug.on"].describe;
    for (const module of VISUAL_MODULES) {
      assert.include(describe, module);
    }
  });

  it("debug.on(all) 一次点亮所有模块", () => {
    (global as any).Memory = {};

    COMMANDS["debug.on"].run("all");

    const visuals = settings().visuals;
    for (const module of VISUAL_MODULES) {
      assert.isTrue(visuals[module], `${module} 没被打开`);
    }
  });

  it("debug.off(all) 全部关掉", () => {
    (global as any).Memory = {};

    COMMANDS["debug.on"].run("all");
    COMMANDS["debug.off"].run("all");

    const visuals = settings().visuals;
    for (const module of VISUAL_MODULES) {
      assert.isFalse(visuals[module], `${module} 没被关掉`);
    }
  });

  it("模块名写错时告诉你有哪些可选", () => {
    (global as any).Memory = {};

    const reply = COMMANDS["debug.on"].run("nonsense");

    assert.include(reply, "nonsense");
    assert.include(reply, VISUAL_MODULES[0]);
  });

  it("默认设置合理：面板开着，路径线关着", () => {
    (global as any).Memory = {};
    const current = settings();
    assert.isTrue(current.visuals.panel);
    assert.isFalse(current.visuals.movement);
    assert.isFalse(current.say);
    assert.equal(current.level, "info");
  });
});
