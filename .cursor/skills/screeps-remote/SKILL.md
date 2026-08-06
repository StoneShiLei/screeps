---
name: screeps-remote
description: Debug Screeps remote mining, reservation contesting, reservers, remote roads/containers, and remote flags/CLI. Use when remotes won't start, reserved rooms, ERR_NOT_OWNER on harvest, contesting reservation, reserver CLAIM count, or pioneers not building remote infrastructure.
---

# Screeps 外矿与抢预定

## 硬规则（别再搞错）

`Creep.harvest`：房间控制器被**别人占领或预定**时返回 `ERR_NOT_OWNER`。  
→ **别人预定的房间采不了矿**。没有「只挖不预定」的蹭矿；相关逻辑已删。

手动加外矿若目标是 `unusable: "reserved"`：进名单去**抢预定**，不是去挖。

文档不确定时走 `screeps-api-docs`。

## 状态机（简）

| `memory.unusable` | 含义 | 采集 | 预定员 |
|-------------------|------|------|--------|
| 无 | 可采 | `remoteMiner` / `remoteHauler` | 维持己方预定 |
| `"reserved"` | 别人预定 | 不采 | `attackController` 抢 |
| `"owned"` / keeper / core / none | 放弃 | 不采 | 不加名单 |

- `isMinable` ≈ `!unusable`
- `isContesting` ≈ `unusable === "reserved"`
- `reserveTargets` = 可采房 ∪ 抢预定房（遇袭冷却中的抢预定房除外）
- `dropUnusable`：**保留** `"reserved"` 在名单里（要抢）

关键：`src/managers/remote.ts`、`flags.ts` 的 `remote`、`cli` 的 `remote.add`。

## 预定员体型与补员

- RCL3：1 CLAIM（约 650）
- RCL4+：2 CLAIM（约 1300），`canDualClaim`
- **单 CLAIM**：按人寿/退役补
- **双 CLAIM**：按 `reserveLeft` 与 `reserveLeadTime`（通勤 + 孵化 + ~200 排队余量）补；余量告急时退休也要提前接班，否则等死再孵会在通勤尽头踩空
- 抢预定房：仍按退役/在场人数补（对方 timer 靠打掉）
- SPAWN：`reserver` 排在 pioneer/upgrader/scout 前，避免建造高峰把预定挤断

角色里：别人预定 → `attackController`；中立/己方 → `reserveController`。

## 开矿规模

**不设**房间数 / 源数硬上限（已删 `REMOTE_LIMIT` / `REMOTE_SOURCE_LIMIT`）。  
自动加房闸：`REMOTE_MIN_LEVEL`、路程 `MAX_REMOTE_DISTANCE`、以及 `spawnHeadroom`（孵化排得下才加）。名单上可采的源全开。

## 基建（路 / 容器）

外矿路与容器靠 **pioneer 路队**（`roadCrewTarget`），不是 remoteMiner。  
`pioneerQuota` 要把路队与 `colonyBoost` **相加**，不能 colonyBoost 一亮就 return 掉路队。分派见 `expansionAssignment`。本房核心未齐时路队也会被建造优先冻结（见 `screeps-logistics` / expansion）。

## 旗子 / CLI

- `remote` 旗 / `remote.add`：接受 reserved（抢预定）；拒绝 owned 等
- 选 home：`nearestRemoteHome`（RCL ≥ `REMOTE_MIN_LEVEL`），别派弱房挂外矿
- 未侦察完可留旗重试

## 矿位被邻居占着 / 外矿遇袭

源旁只有一格能站时（常见窄口地形），别人的矿工钉在 `miningSpots` 上，自家 remoteMiner 站旁边也 harvest 不到。  
→ `remoteEvictTarget` 标房间，`guardian` 去清**无武装**占位者。

有武装敌人时先算战力（`remoteDefenseForce` / `defendersNeeded`）：
- **打得过**（所需 ≤ `MAX_REMOTE_GUARDIANS`）：清掉/`不写` `raided`，`remoteDefenseTarget` 派 guardian；闲置协防兵由 `ensureGuardianDuty` 重新挂 `targetRoom`；工人贴身仍 `evade`
- **打不过**：才记 `raided`、冷却 1500、停采撤人
- 面板外矿行显示 `(抗)`（有视野且武装在场、未冷却）

## 排查

1. 加了 reserved 房却在等 remoteMiner？应先看 reserver / `reserveTargets`，不是矿工。
2. 预定着却 harvest 失败？符合规则，改抢预定或换房。
3. 没人修外矿路？查 pioneer 是否被 boost/建造闸吃光。
4. 补员过密或断档？查是否该走双 CLAIM 的 `reserveLeft` 逻辑。
5. 矿工站源边却挖不到？看落点上有没有外人 → 应出 guardian。
