---
name: screeps-body
description: Rules for Screeps creep body templates, MOVE ratios for road vs off-road, and leftover fillers in this repo. Use when creeps move every 2 ticks, leftover parts slow units, designing bodyFor templates, or debating whether to spend leftover energy on tough/carry/move.
---

# Screeps 体型与零头

生成入口：`bodyFor(role, budget)`（`src/utils/body.ts`）。

疲劳规则以 [Creeps · 移动力](https://screeps-cn.github.io/creeps.html) 为准（亦见 `screeps-api-docs`）：

- 空 `CARRY` 不计重；满载后计重。
- **有路**满速：`MOVE ≥ ceil(重部件/2)`（约 2 重 : 1 MOVE）。
- **无路/平原**满速：`MOVE ≥ 重部件`（约 1:1；满载工人还要盖住 WORK+CARRY）。

## 角色分档（必须分清有路 / 无路）

本房平原路要 **RCL≥4** 才铺（`HOME_ROAD_BODY_LEVEL`，对齐 `ROAD_MIN_LEVEL`）。  
`bodyFor(role, budget, repeatLimit?, level?)`：孵化时传入 `controller.level`；RCL2/3 的 hauler/builder 自动改用无路模板。

| 档 | 角色 | 配比 | 说明 |
|----|------|------|------|
| 有路（RCL≥4） | `hauler` | CARRY:MOVE = **2:1** | 主干道就绪后换运力 |
| 有路（RCL≥4） | `builder` | W:C:M = **1:1:1** | 路满速；可 `filler: carry` |
| 本房尚无路（RCL&lt;4） | `hauler` | **1:1** | 与 remoteHauler 同，避免满载 2t |
| 本房尚无路（RCL&lt;4） | `builder` | **1:1:2** | 与 pioneer 同 |
| 无路 | `remoteHauler` / `looter` | CARRY:MOVE = **1:1** | 外矿/外房 |
| 无路 | `pioneer` / `harvester` | W:C:M = **1:1:2** | 满载平原 1t；无 carry filler |
| 无路 | `remoteMiner` / `dismantler` / `guardian` / `defender` | 非MOVE:MOVE = **1:1** | 跨房或追击 |
| 无路 | `reserver` | CLAIM:MOVE = **1:1** | CLAIM 始终算重 |
| 赶路 | `claimer` | 1 CLAIM + 2 MOVE | 寿限短 |
| 站桩 | `miner` | 多 WORK + 1 MOVE | 不通勤 |
| 站桩 | `upgrader` | 多 WORK + 1 CARRY + **1 MOVE** | 钉站等粮；从 spawn 走到站位即可 |

**不要**在 RCL2/3 用有路 2:1；也**不要**把无路工人写成 `[W,C,M]`（满载平原 2t）。

## 零头

- 默认不补；`filler` opt-in。
- 纯搬运 / 无路满速工人：**无 filler**（多一个重部件就掉档）。
- `spendLeftover` 补 MOVE 按**有路**阈值（`2*MOVE >= 重部件`），只给本房 filler 角色用。
- 本土 `defender`：`tough`；跨房 `guardian`：`move`。

## 改模板时

- 先问：这活主要走**路**还是**平地/外矿**？
- 测 MOVE 比：`test/unit/logistics.test.ts`、`remote.test.ts`、`expansion.test.ts`、`defense.test.ts`。
- combat 不走 `isEmergency` 小体型；RCL8 upgrader WORK 上限 15。

## 现象 → 原因

| 现象 | 常见原因 |
|------|----------|
| pioneer/harvester 满载 2t | 写成了有路比 `[W,C,M]`，应 1:1:2 |
| 外矿 hauler 满载 2t | 误用本房 2:1 |
| 本房 hauler 运力偏少 | 仍用无路 1:1，应 2:1 |
| dismantler 平原 2t | 旧 2W1M，应 W:M=1:1 |
| guardian 2t | filler 用了 tough |
| 防御兵追不上 | ATTACK:MOVE 不是 1:1 |
