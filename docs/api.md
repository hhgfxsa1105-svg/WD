# 接口一览（`/api/v1`）

所有错误统一为 `{ code, message, request_id }`，不含堆栈或内部信息。请求体上限 16KB，未知字段一律拒绝。

| 方法与路径 | 说明 |
|---|---|
| `GET /health` | 健康检查 |
| `GET /player/state` | 当前角色 |
| `GET /player/inventory` | 背包（名称、评级、数量；数量为 0 的不返回） |
| `POST /actions` | 提交行动，必带 `idempotencyKey`。`kind`：`fixed`（`actionId`: `cultivate`/`rest`）、`breakthrough`（`pillItemId`: 突破丹药物品 ID 或 `null`）、`free`（暂未开放） |
| `GET /actions/:id` | 查询已完成行动的结果 |
| `GET /cultivation` | 放置修炼状态（不结算） |
| `POST /cultivation/start` | 开始放置修炼；已在修炼则保持不变；进度已满返回 422 |
| `POST /cultivation/settle` | 领取已累计收益；重复调用不会重复领取 |
| `POST /cultivation/stop` | 先结算再停止；未在修炼则保持不变 |

## 行动结果
`ActionResponse`：`actionId`、`status`、`narrative`、`changes`（数值变化）、`breakthrough`（仅突破：`outcome`、`chancePercent`、`roll`）、`player`（最新角色）。

## 突破的错误（均为 422 `PRECONDITION_FAILED`，状态与丹药不变）
进度未满 · 冷却中（需隔一日）· 已是最高境界 · 丹药不足 · 该物品不能用于突破。

## 幂等
同一幂等键 + 同一参数重试：返回首次结果，不重复结算、不重复扣丹药；同键不同参数：409。失败的请求不占用幂等键。（幂等记录目前在内存中，重启后失效，见 K-01，T-010 持久化。）
