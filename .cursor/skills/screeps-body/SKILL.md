---
name: screeps-body
description: Rules for Screeps creep body templates, MOVE ratios, and leftover fillers in this repo. Use when creeps move every 2 ticks, leftover parts slow units, designing bodyFor templates, or debating whether to spend leftover energy on tough/carry/move.
---

# Screeps 体型与零头

生成入口：`bodyFor(role, budget)`（`src/utils/body.ts`）。

## 原则

1. **平地 1t/格**：非疲劳状态下 `MOVE` 数 ≥ 其他部件数（满载还要按 CARRY 重量算；纯搬运保持 CARRY:MOVE = 1:1）。
2. **零头默认不补**：`filler` 是 opt-in。没写 `filler` 就丢掉零头预算，别自动堆 CARRY。
3. **补什么要想清楚**：
   - 纯搬运（`hauler` / `looter` / `remoteHauler`）：**无 filler**——多一个 CARRY 会掉到 2t/格。
   - 工作单位（builder / pioneer / harvester / upgrader / miner）：可 `filler: "carry"`。
   - 本土 `defender`：`filler: "tough"`（本地肉搏可接受）。
   - 跨房 `guardian` / 赶路兵：`filler: "move"`，**不要 TOUGH**。
4. MOVE 排在身体后部（残血仍能走）；TOUGH 靠前。

## 改模板时

- 用预算扫描测 MOVE 比（见 `test/unit/logistics.test.ts` / `defense.test.ts` 里的体型用例）。
- combat 角色不要走 `isEmergency` 小体型（`spawnManager`）。
- RCL8 upgrader WORK 上限对齐控制器吞吐（15）。

## 现象 → 原因

| 现象 | 常见原因 |
|------|----------|
| guardian 2t 动一格 | filler 是 tough 或 MOVE 不足 |
| hauler 比预期慢 | 零头多补了 CARRY |
| 防御兵追不上 | ATTACK:MOVE 不是 1:1 |
