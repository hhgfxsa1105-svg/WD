# 江湖志

单机、自用的 AI 驱动文字放置武侠网页游戏。文档见 [`docs/`](docs/)（单机调整见 [`docs/adjustments.md`](docs/adjustments.md)）。

## 环境
Node.js ≥ 20。

## 快速开始
```bash
npm install
cp .env.example .env     # 可选，默认值即可运行
npm run dev              # 开发：服务 127.0.0.1:3000，前端 127.0.0.1:5173
npm start                # 构建前端并由本机服务托管：http://127.0.0.1:3000
```

## 常用命令
| 命令 | 作用 |
|---|---|
| `npm run typecheck` | 全工作区类型检查 |
| `npm test` | 运行 Vitest |
| `npm run build` | 构建前端 |

## 结构
`apps/web` 前端 · `apps/server` 本地后端 · `packages/contracts` 共享 Zod 契约 · `packages/game-rules` 纯规则 · `db/` 迁移与种子。

真实密钥只放 `.env`（已被 `.gitignore` 忽略）。
