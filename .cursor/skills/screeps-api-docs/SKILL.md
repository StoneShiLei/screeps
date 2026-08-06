---
name: screeps-api-docs
description: Look up Screeps in-game API signatures, return values, constants, and object properties from the official Chinese documentation. Use when confirming Screeps game APIs, Creep/Room/Structure methods, Game globals, FIND_* / ERR_* constants, or when unsure about runtime behavior before writing or changing Screeps code.
---

# Screeps API 文档

需要确认 Screeps **游戏内 API**（签名、参数、返回值、常量、副作用）时，以中文文档为准，不要凭记忆编造。

## 文档来源

主文档（单页）：https://screeps-cn.github.io/api/

用 WebFetch / 等价方式拉取该 URL，再在页面内容中定位目标 API。文档很大，先按章节标题检索，再精读相关段落。

英文对照（仅中文页缺失或表述不清时）：https://docs.screeps.com/api/

## 工作流

1. 明确要查的符号：类/全局对象、方法名、常量名（如 `Creep.harvest`、`FIND_SOURCES`、`ERR_NOT_IN_RANGE`）。
2. 拉取 https://screeps-cn.github.io/api/ 。
3. 用章节标题定位（见下方索引），阅读：描述、参数表、返回值、示例代码。
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

## 规则

- 实现或修改调用游戏 API 的代码前，对不确定的方法/常量先查文档。
- 优先报告：方法签名、关键参数、返回值/`ERR_*`、文档示例中的正确用法。
- 不把教程站或过时博客当作 API 权威来源；以 `screeps-cn.github.io/api` 为准。
- 本 Skill 只管**游戏运行时 API**；HTTP API、推送配置、`screeps.json` 不在范围内。
