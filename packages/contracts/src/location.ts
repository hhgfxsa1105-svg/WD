import { z } from 'zod';

export const LOCATION_STATUSES = ['open', 'blocked'] as const;
export const LocationStatusSchema = z.enum(LOCATION_STATUSES);
export type LocationStatus = z.infer<typeof LocationStatusSchema>;

export const LOCATION_REASON_MAX = 60;
const ID = z.string().regex(/^[a-z0-9_]{1,64}$/);

/** 地点的可变状态（名字、地区、描述来自静态定义）。被封锁时必须有原因，开放时不能有 */
export const LocationStateSchema = z
  .object({
    id: ID,
    status: LocationStatusSchema,
    reason: z.string().min(1).max(LOCATION_REASON_MAX).nullable(),
    /** 玩家是否去过（去过的地点才能看到详情） */
    visited: z.boolean(),
  })
  .strict()
  .refine((l) => (l.status === 'blocked') === (l.reason !== null), { message: '封锁必须有原因，开放不能有原因' });
export type LocationState = z.infer<typeof LocationStateSchema>;

const RegionRef = z.object({ id: ID, name: z.string().min(1).max(32) }).strict();

/** 玩家当前所在的地点：能看到全部详情 */
export const MapCurrentSchema = z
  .object({
    id: ID,
    name: z.string().min(1).max(32),
    region: RegionRef,
    description: z.string().max(200),
    status: LocationStatusSchema,
    reason: z.string().max(LOCATION_REASON_MAX).nullable(),
    npcs: z.array(z.object({ id: ID, name: z.string().max(32), role: z.string().max(32) }).strict()).max(50),
  })
  .strict();

/** 相邻的出口：只显示名字、状态、体力与耗时；没去过的地点看不到描述 */
export const MapExitSchema = z
  .object({
    id: ID,
    name: z.string().min(1).max(32),
    region: RegionRef,
    status: LocationStatusSchema,
    reason: z.string().max(LOCATION_REASON_MAX).nullable(),
    visited: z.boolean(),
    stamina: z.number().int().min(0).max(100),
    /** 走这一步的游戏耗时（分钟） */
    minutes: z.number().int().min(0).max(1440),
  })
  .strict();

/** 已知的地点按地区分组（去过的与当前所在） */
export const MapRegionSchema = z
  .object({
    id: ID,
    name: z.string().min(1).max(32),
    summary: z.string().max(120),
    locations: z.array(z.object({ id: ID, name: z.string().max(32), visited: z.boolean(), current: z.boolean() }).strict()).max(50),
  })
  .strict();

export const WorldMapResponseSchema = z.object({ current: MapCurrentSchema, exits: z.array(MapExitSchema).max(20), regions: z.array(MapRegionSchema).max(20) }).strict();
export type WorldMapResponse = z.infer<typeof WorldMapResponseSchema>;
