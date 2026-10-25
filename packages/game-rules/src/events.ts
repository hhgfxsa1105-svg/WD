import type { PlayerState, StateChange } from '@jhz/contracts';
import { MINUTES_PER_DAY, MINUTES_PER_HOUR } from './clock.js';
import type { FactionEffect } from './factions.js';

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

/** 分支条件：看前面事件的结果，或势力当前的实力 */
export type BranchCondition = { event: string; outcome: 'joined' | 'missed' } | { faction: string; atLeast?: number; atMost?: number };

/** 满足条件时（按顺序取第一个）：替换结果新闻文字，并追加影响 */
export interface EventBranch {
  when: BranchCondition;
  news?: string;
  worldEffects?: WorldEffect[];
  factionEffects?: FactionEffect[];
}

/** 玩家参加 / 没参加时各自附加的影响 */
export interface OutcomeEffects {
  worldEffects?: WorldEffect[];
  factionEffects?: FactionEffect[];
}

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
  /** 无论怎样都会发生的世界影响 */
  worldEffects: WorldEffect[];
  /** 无论怎样都会发生的势力影响 */
  factionEffects?: FactionEffect[];
  /** 仅在玩家参加时 */
  onJoin?: OutcomeEffects;
  /** 仅在玩家没参加时 */
  onMiss?: OutcomeEffects;
  /** 事件链：按前面事件的结果或势力现状改变结局（按顺序取第一个满足的） */
  branches?: EventBranch[];
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

  // ---- 事件链「黑风寨之患」：每一步的结局取决于玩家前面是否出手，以及两派此刻的实力 ----
  {
    id: 'evt_bandit_raid',
    title: '山道劫案',
    locationId: 'loc_foot_path',
    startAt: day(4, 9),
    windowMinutes: 180,
    rumorLeadMinutes: 600,
    rumor: '山下来的货郎说，黑风寨的人最近在山道上拦路，明天一早怕是要动手。',
    opening: '山道上传来呼喝声，几个蒙面汉子拦住了一队商旅。',
    join: {
      minutes: 90,
      narrative: '你抢上前去喝退几个蒙面汉子，一番交手，逼得他们扔下货物退进了林子。商旅们连声道谢。',
      effects: [
        { stat: 'realmProgress', delta: 6 },
        { stat: 'copper', delta: 20 },
      ],
      news: '山道上有人出手喝退了拦路的山贼，商旅们都说那是青云山的弟子。',
    },
    resolved: '黑风寨的人在山道上劫了一队商旅，得手后扬长而去，往来的行人都不敢再走山道。',
    worldEffects: [],
    onJoin: {
      factionEffects: [
        { kind: 'strength', faction: 'fac_blackwind', delta: -8 },
        { kind: 'attitude', faction: 'fac_qingyun', delta: 4 },
        { kind: 'attitude', faction: 'fac_blackwind', delta: -6 },
        { kind: 'relation', a: 'fac_qingyun', b: 'fac_blackwind', delta: -6 },
      ],
    },
    onMiss: {
      worldEffects: [{ kind: 'location', locationId: 'loc_foot_town', status: 'blocked', reason: '山贼拦路，镇上去不得' }],
      factionEffects: [
        { kind: 'strength', faction: 'fac_blackwind', delta: 8 },
        { kind: 'strength', faction: 'fac_qingyun', delta: -2 },
        { kind: 'relation', a: 'fac_qingyun', b: 'fac_blackwind', delta: -4 },
      ],
    },
  },
  {
    id: 'evt_sect_council',
    title: '大殿议事',
    locationId: 'loc_qingyun_hall',
    startAt: day(4, 18),
    windowMinutes: 240,
    rumorLeadMinutes: 240,
    rumor: '赵铁牛说，掌门今晚要在大殿召集长老议事，像是为山下的事。',
    opening: '大殿里灯火通明，掌门与长老们围坐，门边还留着旁听的位子。',
    join: {
      minutes: 60,
      narrative: '你在门边旁听了一场议事，听掌门与长老们为山下的事争得面红耳赤，最后才定下章程。',
      effects: [{ stat: 'realmProgress', delta: 2 }],
      news: '大殿议事时有个年轻弟子在门边旁听，掌门看了他一眼，什么也没说。',
    },
    resolved: '掌门在大殿召集长老议事，灯火亮到半夜。',
    worldEffects: [],
    branches: [
      {
        when: { event: 'evt_bandit_raid', outcome: 'joined' },
        news: '山道上有人喝退了山贼，掌门趁势整顿山门防务，青云派上下士气一振。',
        factionEffects: [
          { kind: 'strength', faction: 'fac_qingyun', delta: 4 },
          { kind: 'attitude', faction: 'fac_qingyun', delta: 3 },
        ],
      },
      {
        when: { event: 'evt_bandit_raid', outcome: 'missed' },
        news: '山下被山贼拦路的消息传回山门，掌门面色凝重，下令各处加紧戒备。',
        factionEffects: [{ kind: 'strength', faction: 'fac_qingyun', delta: 2 }],
      },
    ],
  },
  {
    id: 'evt_blackwind_assault',
    title: '黑风寨来犯',
    locationId: 'loc_qingyun_gate',
    startAt: day(6, 15),
    windowMinutes: 180,
    rumorLeadMinutes: 360,
    rumor: '山门的弟子说，黑风寨的探子这几天在山脚晃悠，怕是有人要来闹事。',
    opening: '山门外尘土飞扬，一队黑风寨的人马逼近了，守门弟子正在敲钟示警。',
    join: {
      minutes: 120,
      narrative: '你守在山门前与同门并肩迎敌，几番冲杀，把来犯的山贼逼退到山脚。',
      effects: [{ stat: 'realmProgress', delta: 8 }],
      news: '黑风寨来犯时，山门前有位年轻弟子与同门并肩迎敌，立了头功。',
    },
    resolved: '黑风寨的人马冲到山门前撒野一阵，砸坏了几处栅栏才退走。',
    worldEffects: [],
    onJoin: {
      factionEffects: [
        { kind: 'strength', faction: 'fac_blackwind', delta: -12 },
        { kind: 'strength', faction: 'fac_qingyun', delta: 4 },
        { kind: 'attitude', faction: 'fac_qingyun', delta: 6 },
        { kind: 'attitude', faction: 'fac_blackwind', delta: -8 },
        { kind: 'relation', a: 'fac_qingyun', b: 'fac_blackwind', delta: -8 },
      ],
    },
    onMiss: {
      factionEffects: [
        { kind: 'strength', faction: 'fac_qingyun', delta: -8 },
        { kind: 'strength', faction: 'fac_blackwind', delta: 10 },
        { kind: 'relation', a: 'fac_qingyun', b: 'fac_blackwind', delta: -6 },
      ],
    },
    branches: [
      {
        when: { faction: 'fac_blackwind', atLeast: 55 },
        news: '黑风寨来势汹汹，人马比往日多了一倍，山门前的栅栏被撞塌了好几处，青云派吃了亏。',
        factionEffects: [{ kind: 'strength', faction: 'fac_qingyun', delta: -4 }],
      },
    ],
  },
  {
    id: 'evt_blackwind_aftermath',
    title: '风波过后',
    locationId: null,
    startAt: day(7, 9),
    windowMinutes: 0,
    rumorLeadMinutes: 240,
    rumor: '听说这几天山下的风波快要有个了断了。',
    opening: '',
    join: null,
    resolved: '黑风寨暂时退去，山下渐渐恢复了往来。',
    worldEffects: [{ kind: 'location', locationId: 'loc_foot_town', status: 'open' }],
    branches: [
      {
        when: { faction: 'fac_blackwind', atLeast: 55 },
        news: '黑风寨气焰未消，山下商旅仍心有余悸，不少人宁可绕远路也不走山道。',
        factionEffects: [{ kind: 'attitude', faction: 'fac_qingyun', delta: -2 }],
      },
      {
        when: { faction: 'fac_blackwind', atMost: 30 },
        news: '黑风寨元气大伤，寨主闭门不出，山下的商旅又敢走山道了。',
        factionEffects: [{ kind: 'strength', faction: 'fac_blackwind', delta: -3 }],
      },
    ],
  },
];

export interface OutcomeContext {
  /** 玩家是否参加了这个事件 */
  joined: boolean;
  /** 其他事件当前的状态（分支条件用） */
  events: Readonly<Record<string, { state: WorldEventState; participated: boolean }>>;
  /** 势力当前的实力（分支条件用；应用本事件的影响之前的值） */
  factionStrength: Readonly<Record<string, number>>;
}

export interface EventOutcome {
  news: string;
  worldEffects: WorldEffect[];
  factionEffects: FactionEffect[];
}

function branchMatches(c: BranchCondition, ctx: OutcomeContext): boolean {
  if ('event' in c) {
    const e = ctx.events[c.event];
    if (!e) return false;
    return c.outcome === 'joined' ? e.state === 'resolved' && e.participated : e.state === 'missed';
  }
  const s = ctx.factionStrength[c.faction];
  if (s === undefined) return false;
  return (c.atLeast === undefined || s >= c.atLeast) && (c.atMost === undefined || s <= c.atMost);
}

/**
 * 事件了结时的结果（纯函数）：基础影响 + 参加/没参加各自的影响 + 第一个满足条件的分支。
 * 结果新闻默认是 join.news / resolved，分支可以替换文字。条件只看已了结的前序事件和势力实力，
 * 所以同样的历史永远得到同样的结局；AI 无法左右。
 */
export function resolveOutcome(def: SystemEventDef, ctx: OutcomeContext): EventOutcome {
  const side = ctx.joined ? def.onJoin : def.onMiss;
  const branch = def.branches?.find((b) => branchMatches(b.when, ctx));
  return {
    news: branch?.news ?? (ctx.joined && def.join ? def.join.news : def.resolved),
    worldEffects: [...def.worldEffects, ...(side?.worldEffects ?? []), ...(branch?.worldEffects ?? [])],
    factionEffects: [...(def.factionEffects ?? []), ...(side?.factionEffects ?? []), ...(branch?.factionEffects ?? [])],
  };
}

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
