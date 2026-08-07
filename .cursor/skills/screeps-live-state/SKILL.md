---
name: screeps-live-state
description: Query live Screeps room/Memory state via repo tools/ scripts after push or when verifying in-game behavior. Use when checking room objects, creeps, Memory, map ownership, post-deploy runtime, or confirming what the game server actually shows on shard3.
---

# Screeps 游戏内状态查询

需要确认**真实服务器上的房间/运行状态**时，用仓库 `tools/` 脚本拉取，不要猜。本地单测验不了真实房间里的返回值与现场布局。

## 前置条件

- 仓库根目录有 `screeps.json`（含 `main.token`，已 gitignore）
- API 固定 `shard3`（见 `tools/api.ts` 的 `SHARD`）
- 在仓库根目录执行；命令可能需网络权限

常用房间（以当前 probe 为准，可随局势改）：基地 `E52S29`；外矿候选 `E52S28`（双源）、`E53S29`（单源）。

## 怎么选工具

| 目的 | 命令 |
|------|------|
| 推送后看运行快照（能量、孵化、配额、扩张等） | 编辑 `tools/probe.expr.js` → 见下方「probe」 |
| 读 Memory 路径 | `npx ts-node tools/show-memory.ts rooms.E28S36`（无参=顶层键） |
| 房间现役 creep / 能量 / 工地 | `npx ts-node tools/roster.ts E28S36` |
| 地面真实对象清单 + 俯视图 | `npx ts-node tools/inspect-room.ts E28S36` |
| 放大一块地形/建筑/血量 | `npx ts-node tools/peek.ts E28S35 32 10` |
| 房间归属 / 新手区 / RCL | `npx ts-node tools/room-status.ts E29S36 E28S34` |
| 出口与邻房 | `npx ts-node tools/exits.ts E28S36 E28S35` |
| 房间间实际路程 | `npx ts-node tools/route.ts E28S36 E29S36` |
| 拆墙路径 | `npx ts-node tools/breach-plan.ts E28S35 controller` |

规划/选址类（非日常运行检查）：`scan-rooms`、`pick-expansion`、`survey-region`、`find-safe-rooms`、`show-room`、`show-bunker`。其中依赖 path alias 的脚本需：

```powershell
$env:TS_NODE_PROJECT="tsconfig.test.json"
npx ts-node -r tsconfig-paths/register tools/<脚本>.ts ...
```

## probe（控制台表达式 → Memory.probe）

结果必须赋给 `Memory.probe`。只能用游戏全局与挂在 `global` 上的 CLI，**不能** `require("managers/...")`（线上只有打包后的 `main.js`）。

Windows / PowerShell（本机实测需要 commonjs，否则 `.ts` 扩展名报错）：

```powershell
npx ts-node --compiler-options '{\"module\":\"commonjs\"}' tools/probe.ts tools/probe.expr.js
```

### 踩坑（对话里踩过）

- **表达式宜短**：约 400–500 字符稳；到 ~1300 可能静默不执行，HTTP 仍返回**上一轮**的 `Memory.probe`。先写最小表达式确认管道：`Memory.probe = { time: Game.time };`
- **判读是否跑成功**：连续两次结果完全一样（含 `Game.time` / 正在孵的 creep 名）→ 多半没写入，缩短表达式或加 `try/catch` 写 `Memory.probe = { err: String(e) }`。
- **别用复杂 IIFE / 中文键名凑长度**；字段用短英文键，多批 probe 拼状态。
- **改完 `probe.expr.js` 别提交**：那是临时调试文件；查完用 `git checkout -- tools/probe.expr.js` 还原。

## 推送后核对流程

1. 确认代码已 `push-main`（或用户已上传）。发版步骤见 `screeps-ship`。
2. probe 本身会等约 12s；要看「修完是否好转」再等几十 tick 后复测。
3. 优先短 probe；需要人员/工地/对象时再补 `roster`、`inspect-room`、`show-memory`。
4. 对照预期；异常改表达式再探，勿臆测现场。能量物流类异常对照 `screeps-logistics`。

## 规则

- 先跑工具，再下结论；把关键输出摘要给用户。
- 不要提交或打印 `screeps.json` 里的 token。
- 注意 API 限流（`api.ts` 已处理 429）；map-stats / terrain 有本地 `.cache`，勿无意义刷接口。
- 写 Memory 用 `setMemory`（`api.ts`）只改路径，勿覆盖整棵 Memory。
- API **签名**查 `screeps-api-docs`；本 Skill 只管**线上状态**。
