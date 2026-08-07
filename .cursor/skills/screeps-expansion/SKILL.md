---
name: screeps-expansion
description: Debug Screeps colony expansion, pioneer support, colony boost, loot, and home-vs-outpost priority. Use when new rooms stall, pioneers not spawning, boost not working, expansion cancelled too early, or home construction starved by colony support.
---

# Screeps 分房与扶持

## 阶段（`expansion` 记录）

| 阶段 | 含义 | pioneer |
|------|------|---------|
| claim | 派 claimer | — |
| build | 占下、尚无 spawn | 高配，可 surge；**不受**本房核心工地冻结 |
| grow | 有 spawn、继续扶持 | 较低；本房 `hasCoreBuildPending` 时冻结 |
| 撤销 | 分房**有塔**能自保 | 清 `home.memory.expansion` |

不要在「刚能孵 3 个 creep」就撤扶持——没塔仍会被骚扰打崩。

## 无 expansion 记录时的扶持

`colonyBoostTarget`：附近有 spawn、无塔、RCL 更低、距离内 → 继续派 pioneer（surge）。  
有武装敌人 → 跳过，先 `guardian`（`screeps-defense`）。

`pioneerQuota` 需求相加：boost + 外矿路队，不是二选一。

## 能量 surge

- `SURGE_ENERGY`（当前约 20k storage）有余裕时加派
- build 上限 `PIONEERS_SURGE`，grow/boost 上限 `PIONEERS_GROW_SURGE`
- 孵化预算 `affordable` / `spawnHeadroom` 仍卡一道

## 与本房建造的优先级

本房核心建筑（extension / tower / storage 等）未齐：

- grow / boost / 路队 pioneer **冻结**（维持现有人数）
- build 阶段（对方无 spawn）仍放行——没 spawn 分房起不来
- SPAWN 顺序：`builder` 高于 `pioneer` / `upgrader`（见 `spawnManager`）

策略细节与物流闸门见 `screeps-logistics`。

## 拆迁与搬仓

- 前人 spawn / extension 占名额 → 拆；墙可不拆
- storage/terminal 有大宗货 → 先 `looter` 搬空再拆
- `demolitionList` / loot 配额在对应 manager

## 排查

1. 「扶持没生效」：有没有 `expansion` 或 `colonyBoostTarget`？本房是否被 `hasCoreBuildPending` 卡住？storage 是否够 surge？
2. 主房 ext 没齐却狂派 pioneer：查建造闸是否漏了。
3. 分房刚有人就停扶持：是否误在「能孵人」而不是「有塔」时撤销。
4. 挨打还派拓荒：查 `underAttack` / boost 跳过敌人。
