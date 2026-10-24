# 接口一览（`/api/v1`）

所有错误统一为 `{ code, message, request_id }`，不含堆栈或内部信息。请求体上限 16KB，未知字段一律拒绝。

| 方法与路径 | 说明 |
|---|---|
| `GET /health` | 健康检查 |
| `GET /ai/status` | AI 功能状态：是否启用、模型名、未启用原因、每日额度与已用次数；**不含任何密钥与地址** |
| `GET /world/time` | 服务端时间、离线规则（阈值/上限/效率）、`clockBehindMs`（系统时间落后游戏时间的时长，正常为 0） |
| `GET /player/state` | 当前角色 |
| `GET /player/inventory` | 背包（名称、评级、数量；数量为 0 的不返回） |
| `POST /actions` | 提交行动，必带 `idempotencyKey`。`kind`：`fixed`（`actionId`: `cultivate`/`rest`）、`breakthrough`（`pillItemId`: 突破丹药物品 ID 或 `null`）、`free`（`input`: 玩家原话，由 AI 解析，见 `docs/ai-contract.md`）、`move`（`locationId`: 相邻地点 ID）、`quest`（`questId`、`op`: `accept` / `claim` / `abandon`） |
| `POST /actions/:id/narrate` | 重新生成叙事（仅对叙事待补的行动调用 AI；只改文字，不改任何状态）。失败 503 `AI_UNAVAILABLE`；已完成的行动直接返回 |
| `GET /world/npcs` | NPC 列表：名字、身份、简介、当前地点与状态、目标、对玩家的态度（好感/信任/敌意）。只读 |
| `GET /world/npcs/:id/memories` | 该 NPC 的记忆（按时间正序）。`?context=1` 返回对话上下文用的精选（≤8 条、≤600 字）。只读；未知 NPC 404 |
| `GET /quests` | 任务列表：名称、说明、状态、步骤完成情况、奖励说明、是否已领取、锁定原因。只读 |
| `GET /world/npcs/:id/relation` | 解释该 NPC 对玩家（`?target=npc_xxx` 为对其他 NPC）的关系数值来源：初始值、每次变化（审计事件序号、原因、增量）、当前值，并自检是否一致。只读 |
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
`ActionResponse`：`actionId`、`status`、`narrative`、`changes`（数值变化）、`breakthrough`（仅突破：`outcome`、`chancePercent`、`roll`）、`log`（本次写入的日志记录，重试回放时与首次相同）、`ai`（仅自由行动：`intent`、`actionType`、`executed`、`clarification`）、`player`（最新角色）。澄清与查看状态不产生行动记录，`GET /actions/:id` 查不到它们。

## 日志记录的叙事标记
`LogRecord.narration`（可选）：交给 AI 叙事的行动带 `{ actionId, pending }`。`pending: true` 表示结算已生效、叙事待补，前端据此显示「叙事待补 · 重新叙事」并调用 `POST /actions/:id/narrate`；成功后 `pending` 变为 `false`。旧记录与不叙事的行动没有此字段。

## 叙事状态（`status`）
- `COMPLETED`：结算与叙事都已完成（含不需要 AI 叙事的行动，直接用模板）。
- `COMMITTED`：**结算已提交**，叙事待补（`narrative` 暂为模板文字）。刷新、重启后依然如此；`POST /actions/:id/narrate` 可补写。
- 同一幂等键重试：返回首次结果，不会再次结算，也不会再次调用 AI。

## 自由行动的错误
- `503 AI_UNAVAILABLE`：AI 未开启、额度用完、超时、限流、鉴权问题等；提示语不含内部细节。
- `422 PRECONDITION_FAILED`：模型的意图合法，但服务端按当前状态判定不满足规则（体力不足、没有该丹药……）。
- `409 CONFLICT`：同一幂等键用于了不同的输入。
- `400 VALIDATION_FAILED`：输入为空白或超长。

## 突破的错误（均为 422 `PRECONDITION_FAILED`，状态与丹药不变）
进度未满 · 冷却中（需隔一日）· 已是最高境界 · 丹药不足 · 该物品不能用于突破。

## 幂等
同一幂等键 + 同一参数重试：返回首次结果（含日志），不重复结算、不重复扣丹药、不重复审计；同键不同参数：409。失败的请求整体回滚，不占用幂等键。幂等记录保存在数据库 `actions` 表（`(玩家, 幂等键)` 唯一），重启后依然有效。

## 审计与日志
行动结算、扣除丹药、行动记录、审计事件、日志记录在**同一个事务**里提交或回滚。审计事件只记录发生变化的字段（含丹药数量与修炼状态）；放置修炼的空结算（没有收益也没有离线说明）不写事件，避免噪声。日志内容为结构化记录（类型、叙事、数值变化、突破/离线明细），文字排版由前端渲染。

## 存档文件格式
`npm run db:export` 导出 `{ format: "jianghu-save", schemaVersion, exportedAt, player, world }`。
- **v2**（当前）：`world` 含 `npcs`（地点、状态、目标）与 `relationships`（好感/信任/敌意）。
- **v1**（旧）：只有 `player`；导入后人物状态重置为初始。
- 任务：导出带上任务状态；导入时校验任务存在、步数与状态自洽、领取标记合理、前置任务已完成；缺省视为全部初始。
- 背包：导出带上物品与数量；导入时整体替换。文件没有 `inventory` 字段（旧文件）则不改动目标存档的背包。
- 记忆：导出带上全部记忆；导入时**原样保留**（类型、摘要、重要性、条数、时间），原来引用的事件属于旧存档，统一改为引用本次导入事件，并替换目标存档里原有的记忆。「已相识」等依赖记忆的判定因此不受影响。
- 审计：导入会写 `save.import`（标记）与 `save.state`（整体前后差异）两个事件，状态跳变因此也可追溯；整个导入在一个事务里，任何一步失败全部回滚。
- 导入先严格校验：未知字段、数值越界、未知 NPC/地点、关系指向自己或重复，均拒绝；文件里缺少的 NPC/关系用初始值补齐；导入前自动备份当前存档。
