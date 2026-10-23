**技术说明书**

系统架构与实现规范 / Technical Specification

版本：V1.0 \| 日期：2026-10-23

*项目内部文档 · 用于 AI 辅助开发、评审与验收*

# 文档控制

| **项目项** | **定义**                                             |
|------------|------------------------------------------------------|
| 文档编号   | JHZ-TECH-001                                         |
| 版本       | V1.0                                                 |
| 关联基线   | JHZ-PROJ-001 项目书                                  |
| 目的       | 定义模块边界、数据模型、行动流程、接口约定和实现约束 |
| 状态       | 首期技术基线；实现中可经变更评审修订                 |

# 1. 架构决策

## 1.1 模块化单体

首期采用单一后端应用内的模块化设计，不拆分微服务。模块之间通过明确的服务接口交互；数据库访问集中在各模块的数据访问层。这样可降低部署和调试复杂度，同时保留未来拆分的边界。

## 1.2 权威状态与信任边界

- PostgreSQL 中已提交的游戏状态是唯一权威事实来源。

- 浏览器提交的是意图，不是可信的资源数值或成功结果。

- AI 输出是不可信输入，必须通过 Zod 结构校验和业务规则校验。

- AI 不能直接执行 SQL、访问数据库凭据或自行授权资源变更。

- 叙事文本与状态更新分离；状态提交失败时不得宣称成功完成。

# 2. 建议目录结构

以下为建议结构，可在实际初始化时微调，但应保持模块职责与依赖方向。

jianghu-zhi/  
apps/  
web/  
src/  
components/  
pages/  
features/  
api/  
styles/  
server/  
src/  
app.ts  
config/  
modules/  
player/  
cultivation/  
action/  
combat/  
npc/  
world/  
quest/  
ai/  
audit/  
shared/  
jobs/  
tests/  
packages/  
contracts/ \# 共享 DTO、Zod schemas、枚举  
game-rules/ \# 纯规则函数；尽量不依赖 IO  
db/  
migrations/  
seeds/  
docs/  
project-charter.md  
technical-spec.md  
task-plan.md  
audit-checklist.md  
.env.example  
package.json  
README.md

# 3. 模块职责与依赖

| **模块**    | **职责**                     | **不允许做的事**               |
|-------------|------------------------------|--------------------------------|
| player      | 角色档案、属性与资源读写     | 不接受前端直接指定最终数值     |
| cultivation | 修炼进度、收益与离线结算     | 不调用 AI 计算普通收益         |
| action      | 行动状态机、校验与执行编排   | 不把 AI 输出直接当执行结果     |
| combat      | 战斗数值、伤害、胜负判定     | 不让叙事文本决定伤害           |
| npc         | NPC 状态、关系、记忆与计划   | 不把原始聊天全文无限追加为记忆 |
| world       | 世界时钟、地点、事件与调度   | 不依赖每秒模型调用             |
| quest       | 任务条件、步骤、奖励与状态   | 不由 AI 越权完成任务           |
| ai          | 模型适配、提示词、解析与重试 | 不直接写游戏表                 |
| audit       | 行动日志、状态变更与成本记录 | 不记录明文密钥或不必要敏感信息 |

# 4. 核心数据模型

以下是逻辑模型。具体字段类型、索引和约束应在数据库迁移中定义；所有实体均应具备创建/更新时间，必要时增加版本号。

| **实体**          | **关键字段建议**                                                         | **约束/说明**                            |
|-------------------|--------------------------------------------------------------------------|------------------------------------------|
| players           | id, display_name, created_at, updated_at                                 | 玩家账号或匿名玩家标识；身份验证另行定义 |
| player_states     | player_id, level, realm, hp, stamina, silver, attributes_json, version   | 角色当前状态；资源不得无约束为负         |
| cultivation_jobs  | id, player_id, method_id, started_at, last_settled_at, status            | 用于可恢复的修炼进度                     |
| items / inventory | item_id, owner_id, quantity, metadata_json                               | 数量校验；关键物品变更记审计             |
| locations         | id, name, region_id, tags_json                                           | 地点需有稳定 ID，不以显示名称作为主键    |
| npcs              | id, name, role, location_id, status_json, goals_json                     | 人物状态与显示文本分离                   |
| npc_relationships | npc_id, target_type, target_id, affinity, trust, hostility               | 数值范围与方向定义固定                   |
| npc_memories      | id, npc_id, event_id, memory_type, summary, importance, created_at       | 结构化、可检索、可更新                   |
| quests            | id, player_id, quest_def_id, status, progress_json                       | 状态机与前置条件明确                     |
| world_events      | id, event_type, scheduled_at, status, payload_json                       | 可去重、可重试，避免重复触发             |
| actions           | id, player_id, idempotency_key, input, parsed_plan, status, outcome_json | 唯一幂等键；状态机约束                   |
| audit_events      | id, actor_id, action_id, event_type, before_json, after_json, created_at | 关键变更可追踪；限制敏感数据             |
| ai_call_logs      | id, action_id, provider, model, latency_ms, token_usage, status          | 按配置保留成本与故障信息                 |

# 5. 行动处理协议

## 5.1 行动状态机

建议状态：RECEIVED → PARSING → VALIDATING → RESOLVING → COMMITTED → NARRATED → COMPLETED。可失败的阶段转入 FAILED；可重试的模型调用记录重试次数。已经 COMMITTED 的行动不得因叙事生成失败而再次执行资源变更。

## 5.2 AI 结构化行动输出

{  
"intent": "向青云派掌门打听失传剑谱",  
"action_type": "social.inquire",  
"target": { "type": "npc", "id": "npc_master_qingyun" },  
"steps": \[  
{ "type": "travel", "destination_id": "loc_qingyun_sect" },  
{ "type": "dialogue", "topic": "lost_sword_manual" }  
\],  
"requirements": \["target_known"\],  
"risk_tags": \["reputation"\],  
"narrative_context": "玩家希望打听剑谱下落"  
}

- 上述结构是建议协议，必须用 Zod 定义正式 schema；字段不能通过任意字符串执行代码。

- 目标必须引用存在的实体 ID；未知目标需返回澄清或失败结果。

- 模型不得提交最终银两、伤害、成功概率或直接写入的数据库操作。

- 解析失败时最多有限次重试，随后提示玩家改写或走安全的默认失败路径。

## 5.3 规则判定与状态提交

1.  验证玩家身份、请求参数和幂等键。

2.  读取必要的当前状态与实体版本。

3.  校验行动前置条件、地点、资源、冷却和目标状态。

4.  使用可测试的纯函数计算概率与结果；随机源可注入，测试可固定种子。

5.  在事务中校验版本并更新资源、任务、NPC/世界状态及审计记录。

6.  提交成功后才生成叙事；叙事失败不回滚已成功的行动，提供重试生成机制。

# 6. API 设计约定

| **方法与路径**                  | **用途**               | **关键要求**                      |
|---------------------------------|------------------------|-----------------------------------|
| GET /api/v1/player/state        | 读取当前角色与资源     | 只返回当前玩家有权读取的数据      |
| POST /api/v1/cultivation/start  | 开始修炼               | 服务端检查状态与修炼条件          |
| POST /api/v1/cultivation/settle | 结算修炼               | 幂等；服务端计算时间差            |
| POST /api/v1/actions            | 提交固定选项或自由行动 | 要求幂等键；返回 action_id/status |
| GET /api/v1/actions/:id         | 查询行动进度与结果     | 不重复执行行动                    |
| GET /api/v1/world/summary       | 读取可见世界摘要       | 仅返回玩家可见信息                |
| GET /api/v1/audit/actions/:id   | 内部查询行动审计       | 仅开发/管理权限可用               |

统一错误响应建议包含 code、message、request_id；不向客户端返回堆栈、密钥或内部提示词。涉及玩家状态变更的接口必须验证身份、权限、幂等性和数据版本。

# 7. 时间与离线结算

- 使用服务端时间作为权威时间，客户端时间仅用于显示。

- 记录 last_settled_at；结算时计算有效时间差并应用离线收益上限。

- 定时世界事件应具有唯一事件 ID、状态与可去重执行机制。

- 世界模拟应采用定时/条件触发，不通过每秒 AI 请求推进。

- 对系统时间异常、未来时间戳和过长离线时间进行防护。

# 8. AI 接入、成本与故障处理

- 使用统一接口封装供应商差异，业务模块不直接依赖特定 SDK。

- 配置超时、有限重试、速率限制、Token 上限和每玩家成本上限。

- 对同一行动的重复请求使用幂等键；不要因网络重试重复执行已提交的行动。

- 记录模型名、延迟、Token 用量、状态和错误类型；避免记录密钥及不必要的完整私人输入。

- 模型不可用时，固定选项、挂机和存档读取等基础功能仍应工作。

# 9. 安全、隐私与权限

- 模型 API Key 只存在于服务端环境变量或密钥管理设施中。

- 所有玩家数据查询均按身份和所有权过滤，不能信任前端传入的 player_id。

- 对自然语言输入做长度限制、频率限制和内容边界检查。

- AI 输出只作为数据解析，不执行其包含的代码、SQL、URL 或工具指令。

- 日志遵循最小必要原则；定义保留期限与删除/导出策略。

# 10. 测试与工程门槛

| **检查项**  | **门槛**                                                 |
|-------------|----------------------------------------------------------|
| 格式与类型  | 格式检查（若配置）、TypeScript 类型检查通过              |
| 单元测试    | 核心规则、资源结算、行动状态机覆盖关键分支               |
| 集成测试    | 数据库事务、幂等、存档和 API 权限测试通过                |
| AI 合约测试 | 合法、缺字段、未知实体、恶意输入、超时和拒答样例均有测试 |
| 迁移测试    | 新建数据库可完整迁移；重要变更有备份/恢复考虑            |
| 发布安全    | 无已知 P0/P1 问题；密钥不进入仓库                        |

# 11. 未决技术决策

| **决策**     | **当前默认**                                            | **确定时机**         |
|--------------|---------------------------------------------------------|----------------------|
| 账号体系     | 原型可先用开发账号/匿名玩家，公开测试前明确登录方案     | 阶段一后、公开测试前 |
| 模型供应商   | 通过适配层接入；先选一个稳定可用的服务                  | 阶段三开始前         |
| 定时任务方式 | 首期使用服务端调度/按请求惰性结算，避免过早引入复杂队列 | 阶段二               |
| 部署平台     | 前端静态托管 + 支持 Node/PostgreSQL 的后端环境          | 阶段六前             |
| 成本阈值     | 先记录基线，再根据实测设预算与告警                      | 阶段三试运行后       |
