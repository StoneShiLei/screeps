import { alignBorderApproaches, inwardFromExit } from "../../src/planner/remoteRoads";
import { assert } from "chai";
import { installGameConstants } from "./mock";

describe("外矿路跨房对接", () => {
  it("出口格往里缩一格，东西南北各自正确", () => {
    assert.deepEqual(inwardFromExit(0, 30), { x: 1, y: 30 });
    assert.deepEqual(inwardFromExit(49, 29), { x: 48, y: 29 });
    assert.deepEqual(inwardFromExit(25, 0), { x: 25, y: 1 });
    assert.deepEqual(inwardFromExit(25, 49), { x: 25, y: 48 });
    assert.isUndefined(inwardFromExit(3, 31), "房内格子不是出口");
  });

  it("路径含出口格时，两侧进房格钉在同一 y 上", () => {
    const cells = new Map<string, string>();
    const remember = (room: string, x: number, y: number) => cells.set(`${room}:${x},${y}`, `${x},${y}`);

    alignBorderApproaches(
      [
        { x: 48, y: 29, roomName: "E27S36" },
        { x: 49, y: 29, roomName: "E27S36" },
        { x: 0, y: 29, roomName: "E28S36" },
        { x: 1, y: 30, roomName: "E28S36" }
      ],
      remember
    );

    assert.equal(cells.get("E27S36:48,29"), "48,29", "外矿侧贴东门");
    assert.equal(cells.get("E28S36:1,29"), "1,29", "主房侧贴西门，与出口同 y，不能错成 30");
  });

  it("路径跳过出口格时，按离开侧坐标对齐两侧", () => {
    installGameConstants();
    const g = global as unknown as { Game: { map: { findExit: () => number } } };
    const saved = g.Game;
    g.Game = { map: { findExit: () => FIND_EXIT_RIGHT } };

    try {
      const cells = new Map<string, string>();
      const remember = (room: string, x: number, y: number) => cells.set(`${room}:${x},${y}`, `${x},${y}`);

      alignBorderApproaches(
        [
          { x: 48, y: 29, roomName: "E27S36" },
          { x: 1, y: 30, roomName: "E28S36" }
        ],
        remember
      );

      assert.equal(cells.get("E27S36:48,29"), "48,29");
      assert.equal(cells.get("E28S36:1,29"), "1,29", "用外矿侧的 y=29，不跟对角进房的 y=30");
    } finally {
      g.Game = saved;
    }
  });
});
