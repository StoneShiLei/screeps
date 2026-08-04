import { assert } from "chai";
import { loop } from "../../src/main";
import { createCreep, Game, Memory } from "./mock";

describe("main", () => {
  let consoleOutput: string[];
  let originalLog: typeof console.log;

  beforeEach(() => {
    // @ts-ignore : allow adding Game to global
    global.Game = _.clone(Game);
    // @ts-ignore : allow adding Memory to global
    global.Memory = _.clone(Memory);

    consoleOutput = [];
    originalLog = console.log;
    console.log = (...args: any[]) => consoleOutput.push(args.join(" "));
  });

  afterEach(() => {
    console.log = originalLog;
  });

  /** ErrorMapper 会捕获 loop 里的异常并打印成红色文本，别让它们悄悄溜过去 */
  function assertNoSwallowedError(): void {
    const errors = consoleOutput.filter(line => line.includes("color:red"));
    assert.deepEqual(errors, [], "loop 内部抛出了被 ErrorMapper 吞掉的异常");
  }

  it("should export a loop function", () => {
    assert.isTrue(typeof loop === "function");
  });

  it("should return void when called with no context", () => {
    assert.isUndefined(loop());
    assertNoSwallowedError();
  });

  it("Automatically delete memory of missing creeps", () => {
    Memory.creeps.persistValue = "any value";
    Memory.creeps.notPersistValue = "any value";

    Game.creeps.persistValue = createCreep({ name: "persistValue" });

    loop();

    assert.isDefined(Memory.creeps.persistValue);
    assert.isUndefined(Memory.creeps.notPersistValue);
    assertNoSwallowedError();
  });

  it("跳过未知角色时不应该崩溃", () => {
    Game.creeps.stranger = createCreep({
      name: "stranger",
      spawning: false,
      memory: { role: "unknown", room: "W1N1", working: false }
    });

    loop();

    assertNoSwallowedError();
  });
});
