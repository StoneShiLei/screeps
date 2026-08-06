---
name: screeps-ship
description: Lint, unit-test, build, and upload this Screeps TypeScript AI to shard3. Use when finishing a fix, deploying after code changes, running the verify loop, push-main, or when the user asks to upload/ship/deploy the bot.
---

# Screeps 发版验证

本仓库没有本地游戏循环；`src/` 经 Rollup 打成 `dist/main.js` 再上传到 Screeps。改完逻辑按这个顺序收口。

## 标准流程

在仓库根目录：

```powershell
npm test
npm run lint
npm run push-main
```

| 步骤 | 命令 | 作用 |
|------|------|------|
| 单测 | `npm test`（=`test-unit`） | Mocha + `test/unit/**/*.ts`，可跑到真实 `loop()` mock |
| Lint | `npm run lint` | ESLint `src/**/*.ts`（含 `sort-imports`） |
| 上传 | `npm run push-main` | Rollup → 上传 main；需根目录 `screeps.json` token |
| 仅编译 | `npm run build` | 出 `dist/main.js`，不上传 |

PowerShell 不要用 `&&` 链命令（旧版会解析失败）；用 `;` 或分行。

## 上传后（默认必做）

用户要求改完自动上线并核对时（项目规则 `ship-and-verify`）：

1. 等约 30–60s（upload 后下一 tick 才加载新代码；再跑几 tick 才看得出行为）。
2. 用 `screeps-live-state` 短 probe / `roster`，对照修前现象与预期字段。
3. 能量物流类问题对照 `screeps-logistics`；把结论回报用户。
4. 查完还原 `tools/probe.expr.js`（勿提交）。

## 注意

- **不要**在无凭证环境假装已上传；缺 `screeps.json` 时说明只能测/编，不能 push。
- `dist/` gitignore；勿把 token、整棵 Memory dump 提交进库。
- Node 见根目录 `AGENTS.md` / `.nvmrc`（钉 v20）；一般 `node_modules` 可跨 20/22。
- 用户没要求时不要 `git commit`；要提交时按仓库既有中文 `feat:` / `fix:` 风格。
- 集成测 `test-integration` 默认空操作，日常不必跑。

## 改动范围自检

- 动了物流阈值 / 建造优先 → 同步单测 + 必要时 probe。
- 动了孵化优先级 / 配额 → `test/unit/maintenance.test.ts`、`expansion.test.ts`。
- 动了角色体型 → `bodyFor` 相关单测（MOVE 比例、filler）。
