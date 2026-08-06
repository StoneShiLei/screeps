---
name: screeps-defense
description: Debug Screeps local defenders, remote guardians, towers, ramparts, safe mode, and NPC-vs-player threat handling. Use when rooms under attack, safe mode activation, emergency defender spawn loops, guardians too slow, disarmed creeps stuck, colony relief, or tower/rampart repair issues.
---

# Screeps 防御兵种

本土防御和跨房协防是两套角色，别混配额、别混体型。

## 兵种

| 角色 | 职责 | 入口 |
|------|------|------|
| `defender` | **本房**打 NPC 入侵者 | `runDefender` → `fight` |
| `guardian` | **跨房**驰援弱房 | `runGuardian` → 赶路再 `fight` |
| 塔 | 打人 / 治疗 / 修规划内建筑（含 rampart 软上限） | `managers/tower.ts` |

玩家敌对：地面兵不划算 → `localDefenderCount` 见玩家就返回 0，靠塔和后期 rampart。

## 本土防御（NPC）

- 按**战力**派兵（`defendersNeeded` / `combatParts`），不是 1 敌人 1 兵。
- 上限 `MAX_DEFENDERS`。
- **禁止**应急小体型（`isCombat`）：家里空了还硬孵残废兵会饿死经济链；`isChainBroken` 时优先 `harvester`。
- 缴械（武器部件 `hits === 0`）：`retireIfDisarmed` → `suicide()` 腾编制。

关键：`src/roles/defender.ts`、`spawnManager` 的 `defenderQuota` / `pickSpawn`。

## 跨房协防

- 名额来自 `colonyDefenders(home)`：邻房无塔、RCL 更低、在扩张距离内、挨打时按战力派 `guardian`。
- `guardianQuota`：本房生产链健康、本房无武装敌人才外派。
- SPAWN 顺序：家稳（hauler 等）之后才 `guardian`，再才 pioneer。
- 体型：`filler: "move"`，别用 TOUGH 补零头（否则 2t/格）。见 `screeps-body`。

安全优先：目标房有武装敌人时 `pioneerQuota` 冻结，先清场再派工人。

## 安全模式

- 触发：本 tick 事件日志里有关键己方建筑被毁（spawn/塔/extension/storage/…/rampart），且房间里有**武装**敌人。
- 不触发：路/容器/墙朽掉或自拆；拆迁敌方建筑时只有无武装外人；无可用次数 / 冷却中 / 已在安全模式。
- 入口：`managers/safeMode.ts` → `runSafeMode`，主循环里赶在塔之前。

## 塔与 rampart

- 伤害衰减：≤5 → 600，≥20 → 150，每炮仍耗 10 能量。武装敌人开火距离 = `max(20, 塔到 controller + 5)`（盖住分房入口，避免 bunker↔controller 很远时丢控制器）；抢矿邻居仍 **10 格**；再远遛塔不开枪。
- rampart **RCL5** 才开建（前期塔够用，rampart 贵且掉血）。
- 塔修 rampart 用软上限（`rampartHitsTarget`），别按 `hitsMax` 三亿排优先级。
- 只修图纸内 / spawn·塔上的 rampart。

## 排查清单

1. 敌人是 NPC 还是玩家？混有玩家 → 本土地面兵应为 0。
2. 是本房挨打还是分房？分房应出 `guardian` 不是堆本房 `defender`。
3. 空房死循环孵防御兵？查 `isChainBroken` 与 combat 是否走了 emergency body。
4. guardian 慢：查 MOVE 比与 filler。
5. 缴械兵赖着：查 `stillArmed` / suicide。
