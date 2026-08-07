---
name: screeps-logistics
description: Debug Screeps energy logistics, hauler delivery, builder starvation, container refill, and construction-vs-upgrade priority. Use when haulers idle/wander, builders stand still, containers stuck around a threshold, granary not draining, yield-to-hauler issues, or spawn/extension/tower not getting filled.
---

# Screeps 能量物流排查

现场「有能量但工人不动 / 搬运工待命」优先查物流表，不要先改角色行为。核心在 `src/managers/logistics.ts`、`src/roles/hauler.ts`、`src/utils/energy.ts`。

## 快速对照

| 现象 | 先查 |
|------|------|
| builder 站着、说让位 / 无货源 | 缓冲桶是否可取；`gatherEnergy` 让位是否把矿边也锁死 |
| hauler 满载说待命 | `demands` 是否为空；建造期粮仓是否仍挂需求 |
| remoteHauler 满载说无处卸 | spawn/ext 满且无 storage/缓冲桶需求；应回落投喂 builder/upgrader/pioneer |
| hauler 来回晃 | 认领是否被自己的在途量扣没（`logisticsOf(room, creep)`） |
| 容器卡在某个数附近 | 需求门槛与供给留底是否叠在同一阈值 |
| 升级粮仓有货但没人用 | 建造优先：有核心工地时 upgrader 喊「等建」、不从粮仓取；身上有能量仍应灌控制器 |

线上核对用 `screeps-live-state`：容器存量、工地、creep 的 `working`/能量、`energyAvailable`。

## 容器角色（别混）

- **矿边桶**（`miningSpots`）：搬运工收件箱。工人 `yieldToHauler` 时默认不碰。
- **缓冲桶**（图纸内非矿边/非粮仓 container）：工人现取现用；需求补到 `CONTAINER_REFILL_HIGH`（1500）。
- **控制器粮仓**（`upgradeSpot`）：正常时期升级工私产，**不进供给表**；建造期且不防降级时改为缓冲档供给，抽空给建造。

## 已知陷阱

### 1. 需求门槛 + 供给留底叠同一阈值

两条线画在同一个数上会形成死区：桶停在阈值出头，搬运工不认领补货，工人可取量又低于 `MIN_PICKUP_AMOUNT`（50）。表现为「桶里有几百点，builder 全房不动」。

**原则**：缓冲桶只留一条补满线；桶内能量工人应能全额取，别长期留底。

### 2. 让位让到饿死

`gatherEnergy(creep, true)`：有 hauler 或 spawn 缺货时让开矿边。若缓冲桶空、spawn 又不缺货，工人仍不碰矿边 → 纯亏工时。

**原则**：spawn 急件才死让；否则允许回退取矿边（见 `energy.ts`）。

### 3. 建造优先把粮仓锁死

建造期：`shouldFeedGranary` 关闭灌仓、upgrader `等建` 停手。若粮仓仍永不进供给表，桶里剩的几百点永远锁着。

**原则**：不喂粮仓的期间，粮仓应挂供给供 builder/hauler 抽空；恢复喂仓后重新私有。

### 4. hauler 掏缓冲桶空转

没比缓冲更急的需求时，不要从缓冲桶取货再送回缓冲桶。`availableSupplies` 应在仅有缓冲档需求时跳过 `SUPPLY_PRIORITY.buffer`。

### 5. 认领抖动

`claimDemand` / `claimSupply` 必须用 `logisticsOf(room, creep)` 忽略自己；粘旧目标看 `demandStillOpen` / `supplyStillOpen`，不要要求目标仍在被自己扣空后的表里。

### 6. 半载接下单

hauler 卸完一个目标后若身上还有能量、CARRY 没满，且房间里仍有可取供给：应切回取货补满，再接下一个需求。`working && !deliverTo && freeCapacity > 0` 时别直接 `claimDemand`。没货可补时半载继续送（旧兜底）。

## 建造 vs 升级（策略）

每个 RCL：**核心建筑优先**（extension / tower / storage / container 等，见 `hasCoreBuildPending`）。升级只在 `needsDowngradeShield` 时留人；有工地或核心未齐时 upgrader 配额归零并停手。扶持用的 pioneer 在本房核心未齐时冻结（建 spawn 的 build 阶段除外）。

改物流阈值或建造闸时，同步改：`logistics`、`spawnManager`（配额）、`upgrader`（停手）、`expansion`（pioneer）、单测。

## 改完怎么验

1. 单测：`test/unit/logistics.test.ts`（让位、缓冲区间、粮仓抽空、投喂）。
2. `npm test` + `npm run lint`。
3. `npm run push-main` 后 probe 对照：缓冲桶是否上涨、矿边是否不再撑满溢出、builder 是否 `working`、extension 是否在涨。
