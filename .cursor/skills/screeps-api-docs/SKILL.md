---
name: screeps-api-docs
description: Look up Screeps in-game API signatures, return values, constants, and game mechanics from the official Chinese documentation (screeps-cn.github.io). Use when confirming Screeps game APIs, Creep/Room/Structure methods, Game globals, FIND_* / ERR_* constants, movement/fatigue rules, or when unsure about runtime behavior before writing or changing Screeps code.
---

# Screeps API 文档

需要确认 Screeps **游戏内 API**（签名、参数、返回值、常量、副作用）或**官方机制说明**（移动疲劳、CREEP 设计等）时，以中文站为准，不要凭记忆编造。

## 文档来源

中文站总入口：https://screeps-cn.github.io/

| 用途 | URL |
|------|-----|
| **API 参考**（方法签名、返回值、常量） | https://screeps-cn.github.io/api/ |
| **机制说明**（移动疲劳、Creeps、房间等教程） | 各教程页，如 [Creeps](https://screeps-cn.github.io/creeps.html) |

用 WebFetch / 等价方式拉取对应 URL，再定位目标段落。API 页很大，先按章节标题检索。

英文对照（仅中文页缺失或表述不清时）：https://docs.screeps.com/api/ 、https://docs.screeps.com/

## 工作流

1. 分清要查的是 **API 签名** 还是 **游戏机制**（如疲劳/移动配比）——后者优先读教程页（`creeps.html` 等），前者读 `api/`。
2. 拉取对应 URL。
3. API：用章节标题定位（见下方索引），阅读描述、参数表、返回值、示例。机制：精读相关小节（如「移动力」）。
4. 回答或写代码时引用文档结论；若文档与仓库类型定义冲突，以运行时文档为准并指出差异。

## 章节索引

页面内一级标题（便于定位）：

| 章节 | 内容 |
|------|------|
| `Game` / `Game.cpu` / `Game.map` / `Game.market` / `Game.shard` | 全局对象 |
| `InterShardMemory` / `Memory` / `RawMemory` | 内存 |
| `PathFinder` / `PathFinder.CostMatrix` | 寻路 |
| `Constants` | `FIND_*`、`ERR_*`、身体部件、结构类型等常量 |
| `Creep` / `PowerCreep` | 单位 |
| `Room` / `Room.Terrain` / `RoomObject` / `RoomPosition` / `RoomVisual` | 房间与坐标 |
| `Source` / `Mineral` / `Deposit` / `Resource` / `Tombstone` / `Ruin` / `Nuke` / `Flag` / `ConstructionSite` | 房间对象 |
| `Store` / `Structure*` / `OwnedStructure` | 建筑与仓储 |
| `StructureSpawn` / `StructureSpawn.Spawning` | 孵化 |

常见锚点示例（部分站点支持）：`#Creep`、`#Room`、`#StructureSpawn`、`#Constants`。

## 机制速记（Creeps / 移动）

来源：[Creeps · 移动力](https://screeps-cn.github.io/creeps.html)

- 非 `MOVE` 部件：路上疲劳 1、平原 2、沼泽 10；每个 `MOVE` 每 tick 消 2 点疲劳；`fatigue > 0` 不能走。
- **空的 `CARRY` 不产生疲劳**；装满后才算重量。
- 平原满速（1t/格）：`MOVE` 数 ≥ 会产生疲劳的非 MOVE 数（满载时含满的 CARRY + 全部 WORK 等）。
- 文档例：`[CARRY, WORK, MOVE]` 空手 1t/格，满载平原 2t/格。

体型模板细节见 `screeps-body` skill。

## 规则

- 实现或修改调用游戏 API / 依赖疲劳规则的体型前，对不确定处先查文档。
- 优先报告：方法签名、关键参数、返回值/`ERR_*`、或机制页的疲劳结论与示例。
- 权威来源是 `screeps-cn.github.io`（api + 教程）；不把过时博客当准。
- 本 Skill 管**游戏运行时 API 与官方机制说明**；HTTP API、推送配置、`screeps.json` 不在范围内。
