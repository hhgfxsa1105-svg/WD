# 江湖志

AI 驱动的文字放置武侠网页游戏。**完全单机、自用**：存档在本机，服务只监听 `127.0.0.1`，无账号、无公开部署计划。

> 核心原则：规则确定性、剧情生成性、世界持续性、行动开放性、状态可追溯性。
> 程序（数据库）是唯一权威；AI 只负责理解意图与叙事，不直接改写游戏状态；挂机结算不调用 AI。

## 玩法循环
修炼 / 日常行动 → 遇到人物、任务、事件 → 选择固定选项或自由输入 → AI 转为结构化行动、服务端校验并结算 → 提交状态后 AI 生成叙事 → 记录历史、更新 NPC 记忆并存档。

## 技术栈
React + Vite · Fastify + TypeScript · SQLite（better-sqlite3）+ Drizzle· Zod · Vitest · 可替换的 AI 适配层（S3 起）

## 环境要求
Node.js ≥ 20（`better-sqlite3` 为原生模块，常见平台自带预编译包；若安装失败请安装 C++ 构建工具后重试）

## 快速开始
```bash
npm install
cp .env.example .env     # 可选，默认值即可运行
npm run dev              # 开发：服务 127.0.0.1:3000，前端 127.0.0.1:5173
npm start                # 构建前端并由本机服务托管：http://127.0.0.1:3000
```
存档默认在 `data/jianghu.sqlite`（可用 `DB_PATH` 修改，相对路径以仓库根目录为准，已被 `.gitignore` 忽略）。
真实密钥（AI API Key）只放 `.env`，已被 `.gitignore` 忽略，不会进入前端或仓库。

## 常用命令
| 命令 | 作用 |
|---|---|
| `npm run dev` | 同时启动后端与前端开发服务 |
| `npm start` | 构建并以生产方式本机运行 |
| `npm run build` | 构建前端 |
| `npm run db:migrate` | 迁移数据库到最新版本并写入初始角色（`npm start`/`dev` 启动时也会自动执行） |
| `npm run db:export -- [文件]` | 导出存档为 JSON（不带文件名则输出到终端） |
| `npm run db:import -- <文件>` | 导入存档（先自动备份当前存档，文件经严格校验） |
| `npm run db:generate` | 修改 `schema.ts` 后生成新的迁移文件到 `db/migrations` |
| `npm run typecheck` | 全工作区 TypeScript 类型检查 |
| `npm test` | 运行 Vitest（单元与集成） |
| `npm run test:e2e` | 浏览器端到端 26 条（需 `npx playwright install chromium`，或设置 `PW_CHROMIUM_PATH`） |

## 目录结构
```
apps/web              前端（React + Vite）
apps/server           本地后端（Fastify，模块化单体）
packages/contracts    共享 DTO 与 Zod schema
packages/game-rules   纯规则函数（无 IO，可固定种子复现）
db/migrations         Drizzle 生成的 SQL 迁移（schema 见 apps/server/src/db/schema.ts）
db/seeds              种子说明（初始角色由 packages/game-rules 提供）
docs/                 项目文档与任务记录
```

## 文档
| 文档 | 说明 |
|---|---|
| [项目书](docs/project-charter.md) | 目标、范围、玩法循环、阶段规划 |
| [技术说明书](docs/technical-spec.md) | 架构、数据模型、行动协议、API |
| [开发任务书](docs/task-plan.md) | S1–S6 共 28 项任务与验收条件 |
| [审计检查清单](docs/audit-checklist.md) | 质量门槛与发布判定 |
| [单机调整说明](docs/adjustments.md) | 相对 V1.0 文档的单机自用调整（**优先于原文**） |
| [任务记录](docs/task-records/) | 每项任务的实现、验证命令与证据 |
| [接口一览](docs/api.md) | 所有接口、错误与幂等约定 |
| [核心规则](docs/rules.md) | 修炼、货币、突破、魅力的公式与数据表 |
| [原型演示](docs/demo.md) | 从零安装到走完原型循环的步骤 |
| [已知问题](docs/known-issues.md) | 当前限制与处理阶段 |
| [审计报告](docs/audit/) | 各阶段审计与签核记录 |

## 开发进度
| 阶段 | 内容 | 状态 |
|---|---|---|
| S1 原型 | T-001 ~ T-005 ✅ · T-006 原型验收与说明 ✅（S1 待验收签核，见 [S1 审计报告](docs/audit/S1-report.md)） | 待验收 |
| S2 规则与时间 | T-007 核心规则纯函数 ✅（待验收，见 [规则说明](docs/rules.md)）· T-008 修炼任务与结算（后端+前端）✅（待验收）· T-009 ~ T-011 | 进行中 |
| S3 AI 行动 | 结构化解析、判定、叙事分离 | 未开始 |
| S4 NPC 记忆 | 关系、记忆、任务状态机 | 未开始 |
| S5 动态江湖 | 地点、势力、世界事件 | 未开始 |
| S6 发布审计 | 安全、备份恢复、回归 | 未开始 |

## 开发约定
- 每次只做一个可验证的垂直切片，附验证命令与证据。
- 数据库结构变更须有迁移文件；核心规则变更须同步测试、技术说明书和审计项。
- 未经评审不引入新框架或大范围重构；P0/P1 未清零不得验收。
