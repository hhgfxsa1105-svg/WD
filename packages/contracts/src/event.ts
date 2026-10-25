import { z } from 'zod';
import { StateChangeSchema } from './action.js';
import { LogRecordSchema } from './log.js';
import { PlayerStateSchema } from './player.js';

export const WORLD_EVENT_STATES = ['scheduled', 'open', 'resolved', 'missed'] as const;
export const WorldEventStateSchema = z.enum(WORLD_EVENT_STATES);

const EventIdSchema = z.string().regex(/^evt_[a-z0-9_]+$/).max(48);

/** 世界事件的可变状态（名字、时间表来自静态定义）；也是存档里的事件记录 */
export const WorldEventRecordSchema = z
  .object({
    id: EventIdSchema,
    state: WorldEventStateSchema,
    /** 传闻是否已放出（或已错过放出时机） */
    rumored: z.boolean(),
    /** 玩家是否参加了（参加 ⇒ resolved） */
    participated: z.boolean(),
    /** 了结时的游戏时间；了结（resolved / missed）当且仅当有值 */
    resolvedAt: z.number().int().min(0).nullable(),
  })
  .strict()
  .refine((e) => (e.state === 'resolved' || e.state === 'missed') === (e.resolvedAt !== null), '了结的事件必须有了结时间，未了结的不能有')
  .refine((e) => !e.participated || e.state === 'resolved', '参加过的事件必定是 resolved');
export type WorldEventRecord = z.infer<typeof WorldEventRecordSchema>;

export const NEWS_KINDS = ['rumor', 'news'] as const;
/** 传闻（发生前的风声）与新闻（发生后的结果） */
export const NewsItemSchema = z
  .object({
    id: z.string().min(1).max(64),
    eventId: EventIdSchema,
    kind: z.enum(NEWS_KINDS),
    text: z.string().min(1).max(400),
    /** 新闻所述的游戏时间 */
    gameMinutes: z.number().int().min(0),
    /** 结果新闻里是否包含玩家 */
    participated: z.boolean(),
  })
  .strict();
export type NewsItem = z.infer<typeof NewsItemSchema>;

export const NewsResponseSchema = z.object({ news: z.array(NewsItemSchema).max(200) }).strict();
export type NewsResponse = z.infer<typeof NewsResponseSchema>;

const WhenSchema = z.object({ minutes: z.number().int().min(0), label: z.string().min(1).max(32) }).strict();

/** 玩家看到的事件：只传闻时不透露名字与地点 */
export const WorldEventViewSchema = z
  .object({
    id: EventIdSchema,
    state: WorldEventStateSchema,
    /** 只放出传闻时为 null */
    title: z.string().max(40).nullable(),
    /** 传闻 / 开场提示 / 结果新闻 */
    summary: z.string().max(400),
    location: z.object({ id: z.string(), name: z.string() }).strict().nullable(),
    startsAt: WhenSchema,
    /** 仅 open 时有：窗口结束的时间 */
    closesAt: WhenSchema.nullable(),
    participated: z.boolean(),
    canJoin: z.boolean(),
    /** open 但现在不能参加的原因，如「你不在现场」 */
    joinBlockedReason: z.string().max(80).nullable(),
  })
  .strict();
export type WorldEventView = z.infer<typeof WorldEventViewSchema>;

export const WorldEventsResponseSchema = z.object({ events: z.array(WorldEventViewSchema).max(200) }).strict();
export type WorldEventsResponse = z.infer<typeof WorldEventsResponseSchema>;

export const JoinEventResponseSchema = z
  .object({
    narrative: z.string().max(4000),
    changes: z.array(StateChangeSchema).max(16),
    player: PlayerStateSchema,
    log: LogRecordSchema.nullable(),
    event: WorldEventViewSchema,
  })
  .strict();
export type JoinEventResponse = z.infer<typeof JoinEventResponseSchema>;
