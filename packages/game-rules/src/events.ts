import type { PlayerState, StateChange } from '@jhz/contracts';
import { MINUTES_PER_DAY, MINUTES_PER_HOUR } from './clock.js';

/**
 * 系统轨世界事件（静态定义）：由程序按游戏时间表发生，AI 不能取消、推迟或替换。
 * 每个事件有「传闻」（发生前约 1 时辰）、「参与窗口」（玩家在窗口内到场参加，结果包含玩家）；
 * 没有参加就由规则自行了结，以新闻告知。世界效果（如封锁地点）无论玩家是否参加都会发生。
 */

export const WORLD_EVENT_STATES = ['scheduled', 'open', 'resolved', 'missed'] as const;
export type WorldEventState = (typeof WORLD_EVENT_STATES)[number];

/** 参加事件对玩家的直接影响（程序定义的小额奖励；AI 从不决定资源） */
export interface PlayerEffect {
  stat: 'realmProgress' | 'copper';
  delta: number;
}

/** 事件对世界的影响：只能通过共享的世界状态产生（这里是地点开放/封锁） */
export type WorldEffect = { kind: 'location'; locationId: string; status: 'open' | 'blocked'; reason?: string };

export interface SystemEventDef {
  id: string;
  title: string;
  /** 事件发生的地点；null = 不限地点 */
  locationId: string | null;
  /** 开始的游戏时间（游戏分钟） */
  startAt: number;
  /** 参与窗口长度；没有参与环节的事件（join = null）到点即了结 */
  windowMinutes: number;
  /** 传闻提前多久放出 */
  rumorLeadMinutes: number;
  /** 传闻：只透露一点风声 */
  rumor: string;
  /** 事件开始时对在场者的提示 */
  opening: string;
  /** 参与环节；null = 玩家无法参与，到点由规则了结 */
  join: null | { minutes: number; narrative: string; effects: PlayerEffect[]; news: string };
  /** 没有玩家参与时的新闻（或无参与环节事件的新闻） */
  resolved: string;
  worldEffects: WorldEffect[];
}

const day = (d: number, hour: number, minute = 0) => (d - 1) * MINUTES_PER_DAY + hour * MINUTES_PER_HOUR + minute;

/** 演示用时间线（按开始时间排序）。势力冲突链见 T-023 */
export const SYSTEM_EVENT_DEFS: readonly SystemEventDef[] = [
  {
    id: 'evt_morning_class',
    title: '练功场晨课',
    locationId: 'loc_qingyun_yard',
    startAt: day(2, 7),
    windowMinutes: 120,
    rumorLeadMinutes: 120,
    rumor: '听山门的弟子说，明早练功场有晨课，大师姐要亲自带着练一套剑。',
    opening: '练功场上钟声刚过，弟子们陆续列队，晨课开始了。',
    join: {
      minutes: 60,
      narrative: '你站进队列，跟着大师姐把一套入门剑法从头走到尾，额头见了汗，招式却顺了不少。',
      effects: [{ stat: 'realmProgress', delta: 4 }],
      news: '晨课上你跟着众弟子练完了剑，大师姐点了点头。',
    },
    resolved: '练功场的晨课照常举行，弟子们练到日上三竿才散。',
    worldEffects: [],
  },
  {
    id: 'evt_library_repair',
    title: '藏经阁整修',
    locationId: 'loc_qingyun_library',
    startAt: day(2, 12),
    windowMinutes: 0,
    rumorLeadMinutes: 120,
    rumor: '陆先生念叨着，藏经阁的房梁该修了，过两天怕是要关门。',
    opening: '',
    join: null,
    resolved: '藏经阁今日起闭门整修，匠人搬着梁木进进出出，典籍暂不外借。',
    worldEffects: [{ kind: 'location', locationId: 'loc_qingyun_library', status: 'blocked', reason: '整修中，暂不开放' }],
  },
  {
    id: 'evt_town_market',
    title: '山下集市',
    locationId: 'loc_foot_town',
    startAt: day(3, 9),
    windowMinutes: 360,
    rumorLeadMinutes: 120,
    rumor: '赶集的货郎说，后天小镇有大集，从早摆到午后。',
    opening: '小镇上人声鼎沸，摊子沿街排开，货郎们正缺人手。',
    join: {
      minutes: 60,
      narrative: '你在集市上帮一位摊主搬了半天货，摊主笑着塞给你几十文工钱。',
      effects: [{ stat: 'copper', delta: 30 }],
      news: '集市上你帮摊主搬货挣了几十文，货郎们都夸你手脚麻利。',
    },
    resolved: '山下的大集热闹了一整天，货郎们的生意都不错。',
    worldEffects: [],
  },
  {
    id: 'evt_library_reopen',
    title: '藏经阁重开',
    locationId: 'loc_qingyun_library',
    startAt: day(3, 12),
    windowMinutes: 0,
    rumorLeadMinutes: 120,
    rumor: '听说藏经阁的梁木快换好了，明天就能重开。',
    opening: '',
    join: null,
    resolved: '藏经阁整修完毕，大门重开，陆先生又坐回了窗边的老位置。',
    worldEffects: [{ kind: 'location', locationId: 'loc_qingyun_library', status: 'open' }],
  },
];

/** 事件的结束时间（含窗口）；没有参与环节的事件到点即结束 */
export const eventEndsAt = (def: SystemEventDef): number => def.startAt + (def.join ? def.windowMinutes : 0);

/** 单次调度最多处理的状态转换数（防御：一次很大的时间推进不会卡住服务） */
export const MAX_EVENT_TRANSITIONS_PER_TICK = 50;

export type EventStep = { kind: 'rumor'; late: boolean } | { kind: 'open' } | { kind: 'close' };

/**
 * 在游戏时间 now 时，这个事件还应发生哪些状态转换（按先后顺序，纯函数）。
 * - 传闻在开始前 rumorLeadMinutes 放出；时间已越过开始点才发现没放过的，只标记，不再补发（late）。
 * - 开始后进入 open；窗口结束（或无参与环节的事件到点）即 close：了结并产生新闻与世界效果。
 * - 一次很大的时间推进可以连续经过多步，但每一步只发生一次。
 */
export function planSteps(def: SystemEventDef, row: { state: WorldEventState; rumored: boolean }, now: number): EventStep[] {
  if (row.state === 'resolved' || row.state === 'missed') return [];
  const steps: EventStep[] = [];
  if (row.state === 'scheduled') {
    if (!row.rumored && now >= def.startAt - def.rumorLeadMinutes) steps.push({ kind: 'rumor', late: now >= def.startAt });
    if (now >= def.startAt) steps.push(def.join ? { kind: 'open' } : { kind: 'close' });
  }
  if (def.join && now >= eventEndsAt(def)) steps.push({ kind: 'close' });
  return steps;
}

/** 应用对玩家的影响：进度封顶 100、不为负；返回实际变化 */
export function applyPlayerEffects(player: PlayerState, effects: readonly PlayerEffect[]): { player: PlayerState; changes: StateChange[] } {
  let next = player;
  const changes: StateChange[] = [];
  for (const e of effects) {
    if (e.stat === 'realmProgress') {
      const progress = Math.max(0, Math.min(100, next.realmProgress + e.delta));
      if (progress !== next.realmProgress) changes.push({ stat: 'realmProgress', delta: progress - next.realmProgress });
      next = { ...next, realmProgress: progress };
    } else {
      const copper = Math.max(0, next.currency.copper + e.delta);
      if (copper !== next.currency.copper) changes.push({ stat: 'copper', delta: copper - next.currency.copper });
      next = { ...next, currency: { ...next.currency, copper } };
    }
  }
  return { player: next, changes };
}
