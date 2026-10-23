# AI 行动方案契约（S3）

对应技术说明书 §5.2。模型把玩家的自然语言转成**结构化意图**；服务端校验并结算，模型永远不决定数值。

## 信任边界
- 模型输出是**不可信输入**：只当数据解析，不执行其中的任何代码、SQL、URL 或指令。
- 方案里**没有任何数值字段**（银两、伤害、成功率、经验……），模型无从提交。
- **前置条件不由模型声明**（技术说明书示例里的 `requirements` 字段已取消）：体力、冷却、库存、进度等一律由服务端按当前状态计算。
- 目标必须是**已存在的实体 ID**；不存在则进入澄清流程，不执行。

## 方案格式（严格 schema：`AiActionPlanSchema`）
```json
{
  "intent": "我想休息一下",
  "action_type": "rest",
  "target": null,
  "steps": [],
  "risk_tags": [],
  "narrative_context": "",
  "needs_clarification": false,
  "clarification": null
}
```
| 字段 | 说明 |
|---|---|
| `intent` | 对玩家意图的一句话复述，1–80 字 |
| `action_type` | `cultivate` 修炼 · `rest` 休息 · `breakthrough` 突破（可带丹药）· `start_idle` / `stop_idle` 放置修炼 · `check_status` 查看状态 · `talk` 交谈（NPC 在 S4 开放，目前只会澄清）· `other` 无法归类 |
| `target` | `null` 或 `{ "type": "item"｜"npc"｜"location", "id": "小写字母数字下划线，≤64" }` |
| `steps` | 可选，最多 3 步：`travel` / `dialogue` / `inspect`（预留，首批动作不需要） |
| `risk_tags` | 可选，最多 4 个：`reputation` / `injury` / `cost` / `time` |
| `narrative_context` | 供叙事参考的一句背景，≤120 字，不参与结算 |
| `needs_clarification` / `clarification` | 需要追问玩家时为 `true`，并给出一句话问题（≤100 字） |

严格 schema 拒绝：缺字段、未知字段、未知动作类型、非法目标 ID（大写、空格、引号、路径、过长）、步骤超过 3 个、未知风险标签、需要澄清却没有问题。

## 宽容解析（`parseAiPlan`）：为质量一般的模型准备
`parseAiPlan(原文, { fallbackIntent })` **永不抛出异常**，返回「通过严格 schema 的方案 + 整理记录」或「拒绝 + 原因」。它只做**安全的格式整理**，整理后仍必须通过严格 schema：

| 整理 | 说明 |
|---|---|
| 提取 JSON | 支持 Markdown 围栏、前后多余的话、尾逗号、中文引号、单引号；原文可直接解析时不做修补，避免误改字符串内的引号 |
| 字段名 | 驼峰转蛇形；少量别名（`action`→`action_type`、`intention`→`intent` 等） |
| 动作类型 | 中英文同义词（修炼/打坐、休息/睡觉、突破/冲关、挂机……）；认不出的归为 `other` 并澄清，**不猜测** |
| 目标 | 字符串或对象；类型同义词；按前缀推断类型；`none`/空视为无目标；**不需要目标的动作，多写的目标直接丢弃** |
| 丢弃 | 未知字段、未知步骤、未知风险标签（记入 `notes`，**绝不执行**） |
| 文本 | 去控制字符、折叠空白、截断到上限 |
| 缺 intent | 用玩家原话代替 |

**拒绝**（`code`）：`EMPTY`、`TOO_LONG`（原文 > 8000 字符）、`NOT_JSON`、`NOT_OBJECT`、`MISSING_ACTION_TYPE`、`ILLEGAL_TARGET`（需要目标的动作遇到格式非法的目标，如注入式内容）、`SCHEMA_INVALID`。

## 目标校验（`checkPlanTarget`）
目标必须在 `EntityCatalog` 中存在（物品来自物品表；NPC、地点由 S4/S5 的系统提供，目前 NPC 一律不存在、地点只有青云山山门）。不存在 → `UNKNOWN_ENTITY`，突破搭配了非突破丹药的目标 → `TARGET_NOT_ALLOWED`；两者都返回一句话澄清，调用方据此走澄清流程而不是执行。库存是否持有该物品属于前置条件，由服务端在 T-014 校验。

## 测试
`packages/game-rules/tests/ai-plan.test.ts`：提取 JSON 9 种写法与 5 种拒绝；同义词、别名、未知字段丢弃、截断、布尔写法；目标的各种合法与非法形式（含注入式、路径穿越、原型污染键、重复键）；**提示注入式输出不产生越权方案**；10000 次随机乱码与合法输出变异的模糊测试（不抛异常、通过者必合法）；超深嵌套、巨量键、大数组不卡死。
