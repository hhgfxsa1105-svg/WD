# 接口一览（`/api/v1`）

所有错误统一为 `{ code, message, request_id }`，不含堆栈或内部信息。请求体上限 16KB，未知字段一律拒绝。

| 方法与路径 | 说明 |
|---|---|
| `GET /health` | 健康检查 |
| `GET /ai/status` | AI 功能状态：是否启用、模型名、未启用原因、每日额度与已用次数；**不含任何密钥与地址** |
| `GET /world/time` | 服务端时间、离线规则（阈值/上限/效率）、`clockBehindMs`（系统时间落后游戏时间的时长，正常为 0） |
| `GET /player/state` | 当前角色 |
| `GET /player/inventory` | 背包（名称、评级、数量；数量为 0 的不返回） |
| `POST /actions` | 提交行动，必带 `idempotencyKey`。`kind`：`fixed`（`actionId`: `cultivate`/`rest`）、`breakthrough`（`pillItemId`: 突破丹药物品 ID 或 `null`）、`free`（暂未开放） |
| `GET /actions/:id` | 查询已完成行动的结果 |
| `GET /log?limit=` | 玩家可见日志（结构化记录，按时间正序；`limit` 1–200，默认 100）。刷新、重启后据此还原 |
| `GET /audit/actions/:id` | 内部审计：行动及其审计事件（前后状态差异）。**仅本机访问**，其他来源 403 |
| `GET /cultivation` | 放置修炼状态（不结算） |
| `POST /cultivation/start` | 开始放置修炼；已在修炼则保持不变；进度已满返回 422 |
| `POST /cultivation/settle` | 领取已累计收益；重复调用不会重复领取 |
| `POST /cultivation/stop` | 先结算再停止；未在修炼则保持不变 |

## 放置修炼响应
`CultivationResponse`：`job`（进行中的任务或 null）、`player`、`changes`、`ticks`、`serverNow`、`offline`（按离线结算时有值：`gapMs`、`countedMs`、`capped`、`efficiencyPercent`；在线为 null）、`notice`。

## 行动结果
`ActionResponse`：`actionId`、`status`、`narrative`、`changes`（数值变化）、`breakthrough`（仅突破：`outcome`、`chancePercent`、`roll`）、`log`（本次写入的日志记录，重试回放时与首次相同）、`player`（最新角色）。

## 突破的错误（均为 422 `PRECONDITION_FAILED`，状态与丹药不变）
进度未满 · 冷却中（需隔一日）· 已是最高境界 · 丹药不足 · 该物品不能用于突破。

## 幂等
同一幂等键 + 同一参数重试：返回首次结果（含日志），不重复结算、不重复扣丹药、不重复审计；同键不同参数：409。失败的请求整体回滚，不占用幂等键。幂等记录保存在数据库 `actions` 表（`(玩家, 幂等键)` 唯一），重启后依然有效。

## 审计与日志
行动结算、扣除丹药、行动记录、审计事件、日志记录在**同一个事务**里提交或回滚。审计事件只记录发生变化的字段（含丹药数量与修炼状态）；放置修炼的空结算（没有收益也没有离线说明）不写事件，避免噪声。日志内容为结构化记录（类型、叙事、数值变化、突破/离线明细），文字排版由前端渲染。
