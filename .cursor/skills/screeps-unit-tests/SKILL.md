---
name: screeps-unit-tests
description: Patterns for writing Screeps unit tests in this repo with mocked Game/Memory. Use when adding Mocha tests, fixing flaky logistics/spawn tests, mocking rooms/creeps, or cache collisions across cases in the same tick.
---

# Screeps 单测约定

测试：`test/unit/**/*.ts`，入口 `npm test`。常量用 `installGameConstants()`（`test/unit/mock.ts`）。

## 必备 mock

```ts
beforeEach(() => {
  installGameConstants();
  // 保存并替换 global.Game / global.Memory
  Game = { creeps: {}, rooms: {}, time: Math.floor(Math.random() * 1e6), getObjectById: () => null, map: { ... } };
  Memory = { rooms: {}, creeps: {}, settings: {} }; // defender announce 等会读 settings
});
```

- **`STRUCTURE_*` / `RESOURCE_ENERGY` 用真实字符串值**（mock 里已照抄），不要随便填数——两边都是 undefined 会假绿。
- `claimSupply` / `claimDemand` 要接线 `Game.getObjectById`，对象上带 `room`。
- `findClosestByRange` 若测过滤条件，mock 必须真的跑 `filter`，别写死返回值。

## 缓存踩坑

| 缓存 | 处理 |
|------|------|
| `logisticsOf` 按房间名 + tick | 每用例换随机房间名，或推进 `Game.time` |
| `spawnLoadOf` 按 tick | 同文件多测改配额时递增 `Game.time` |
| 威胁扫描 | 测 `colonyDefenders` 时换 `Game.time` 防脏缓存 |

## 房间假对象常用字段

- `memory.anchor` / `miningSpots` / `upgradeSpot`：物流与规划
- `controller.ticksToDowngrade`：测建造优先时给足，避免误触 `needsDowngradeShield`
- `getPositionAt`：`hasCoreBuildPending` 在缺它时只看工地，勿假定会扫完整图纸
- `Game.map.getRoomTerrain` / `getRoomLinearDistance` / `describeExits`：扩张、旗子、外矿规划测需要

## 断言风格

跟仓库现有用例：中文 `it("...")` 说明意图；失败信息写清**为什么**不该那样（别只写 expected/actual）。

改物流 / 防御 / 外矿 / 分房时，优先补在对应 `*.test.ts`，再 `npm test`。
