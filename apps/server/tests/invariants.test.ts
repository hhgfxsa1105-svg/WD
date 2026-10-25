import { describe, expect, it } from 'vitest';
import { ActionResponseSchema, CultivationResponseSchema, PlayerStateSchema, REALMS, realmHasNeili } from '@jhz/contracts';
import { IDLE_CULTIVATION, createSeededRng } from '@jhz/game-rules';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { snapshot } from '../src/modules/audit/diff.js';
import { meetNpc } from '../src/modules/npc/memory.js';
import { LOCATION_DEFS, NPC_DEFS, QUEST_DEFS } from '@jhz/game-rules';
import { createSqliteGameStore } from '../src/modules/store/sqlite.js';
import type { OfflinePolicy } from '../src/modules/cultivation/service.js';
import { WorldClock } from '../src/shared/world-clock.js';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const H = 60 * MIN;
const PILL = 'pill_breakthrough_fan';

/** 随机操作序列的驱动：真实 SQLite 存档 + 真实 WorldClock（系统时间可前进、可回拨） */
async function world(seed: number, offline?: Partial<OfflinePolicy>) {
  const d = openDatabase(':memory:');
  runMigrations(d.db);
  const store = createSqliteGameStore(d.db);
  const wall = { t: T0 };
  const clock = new WorldClock(store.worldClock, { wall: () => wall.t });
  const rng = createSeededRng(seed);
  const app = await buildApp({ store, clock, rng: createSeededRng(seed + 1), offline });
  let n = 0;
  const key = () => `fuzz-${seed}-${String(++n).padStart(6, '0')}`;
  return {
    d,
    store,
    wall,
    clock,
    rng,
    app,
    key,
    post: (url: string, payload?: object) => app.inject({ method: 'POST', url, payload }),
    state: () => store.read((tx) => tx.player()),
    snap: () => store.read((tx) => snapshot(tx)),
  };
}
type World = Awaited<ReturnType<typeof world>>;

type Op = () => Promise<void>;
const pick = <T>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)]!;

/** 一次随机操作；返回操作名，便于失败时定位 */
async function randomOp(w: World, check: (name: string) => void): Promise<void> {
  const r = w.rng;
  const ops: [string, Op][] = [
    ['cultivate', async () => void (await w.post('/api/v1/actions', { kind: 'fixed', idempotencyKey: w.key(), actionId: 'cultivate' }))],
    ['rest', async () => void (await w.post('/api/v1/actions', { kind: 'fixed', idempotencyKey: w.key(), actionId: 'rest' }))],
    ['breakthrough', async () => void (await w.post('/api/v1/actions', { kind: 'breakthrough', idempotencyKey: w.key(), pillItemId: r() < 0.5 ? PILL : null }))],
    ['start', async () => void (await w.post('/api/v1/cultivation/start'))],
    ['settle', async () => void (await w.post('/api/v1/cultivation/settle'))],
    ['stop', async () => void (await w.post('/api/v1/cultivation/stop'))],
    ['advance', async () => void (w.wall.t += Math.floor(r() * 3 * H))],
    ['advance-small', async () => void (w.wall.t += Math.floor(r() * 10 * MIN))],
    ['regress', async () => void (w.wall.t -= Math.floor(r() * 48 * H))],
    ['move', async () => void (await w.post('/api/v1/actions', { kind: 'move', idempotencyKey: w.key(), locationId: pick(r, Object.keys(LOCATION_DEFS)) }))],
    ['quest', async () => void (await w.post('/api/v1/actions', { kind: 'quest', idempotencyKey: w.key(), questId: pick(r, Object.keys(QUEST_DEFS)), op: pick(r, ['accept', 'accept', 'claim', 'abandon'] as const) }))],
    [
      'meet',
      async () => {
        try {
          meetNpc(w.store, pick(r, Object.keys(NPC_DEFS)), w.clock.now());
        } catch {
          /* 不在场的人见不到，正常 */
        }
      },
    ],
  ];
  // 地点、任务与见面的权重加大，让整条新手任务链有机会被走通
  ops.push(ops[9]!, ops[9]!, ops[10]!, ops[11]!, ops[11]!, ops[11]!, ops[0]!, ops[1]!);
  // 放置修炼与时间推进的权重加倍，让「开始 → 时间流逝 → 结算」的路径被充分走到
  ops.push(ops[3]!, ops[4]!, ops[6]!, ops[7]!, ops[4]!, ops[7]!);
  const [name, op] = pick(r, ops);
  await op();
  check(name);
}

/** 跨用例统计随机序列实际覆盖到的事件类型与突破结果，防止测试日后悄悄空转 */
const covered = { types: new Set<string>(), outcomes: new Set<string>(), realms: new Set<string>() };
function recordCoverage(w: World) {
  for (const r of w.d.sqlite.prepare('select event_type t from audit_events').all() as { t: string }[]) covered.types.add(r.t);
  for (const r of w.d.sqlite.prepare("select json_extract(log_json,'$.breakthrough.outcome') o from audit_events where event_type='action.breakthrough'").all() as { o: string }[]) covered.outcomes.add(r.o);
  covered.realms.add(w.state().realm);
}

describe('不变量：任意操作序列下状态始终合法', () => {
  it.each([1, 2, 3, 4, 5])('种子 %i：400 步随机操作（含系统时间前进与回拨）', async (seed) => {
    const w = await world(seed, {}); // 真实默认离线策略
    let lastVersion = 0;
    let lastHigh = 0;
    for (let i = 0; i < 400; i++) {
      await randomOp(w, (name) => {
        const s = w.state();
        const ctx = `seed=${seed} step=${i} op=${name}`;
        expect(PlayerStateSchema.safeParse(s).success, ctx).toBe(true);
        expect(s.version, ctx).toBeGreaterThanOrEqual(lastVersion); // 版本单调不减
        lastVersion = s.version;
        expect(s.stamina, ctx).toBeGreaterThanOrEqual(0);
        expect(s.stamina, ctx).toBeLessThanOrEqual(s.maxStamina);
        expect(s.hp, ctx).toBeGreaterThanOrEqual(1); // 突破失败不会致死
        expect(s.hp, ctx).toBeLessThanOrEqual(s.maxHp);
        expect(s.realmProgress, ctx).toBeGreaterThanOrEqual(0);
        expect(s.realmProgress, ctx).toBeLessThanOrEqual(100);
        expect((s.neili !== null) === realmHasNeili(s.realm), ctx).toBe(true);
        expect(REALMS.includes(s.realm), ctx).toBe(true);
        const pills = w.store.read((tx) => tx.inventory().find((x) => x.itemId === PILL)?.quantity ?? 0);
        expect(pills, ctx).toBeGreaterThanOrEqual(0);
        // 丹药只有初始 1 枚，外加已领取任务奖励里的丹药，不可能凭空增加
        const rewarded = w.store
          .read((tx) => tx.quests())
          .filter((q) => q.claimed)
          .flatMap((q) => QUEST_DEFS[q.id as keyof typeof QUEST_DEFS].reward.items ?? [])
          .filter((i) => i.itemId === PILL)
          .reduce((n, i) => n + i.quantity, 0);
        expect(pills, ctx).toBeLessThanOrEqual(1 + rewarded);
        const high = w.clock.now();
        expect(high, ctx).toBeGreaterThanOrEqual(lastHigh); // 世界时间只增不减
        lastHigh = high;
        // 同一时刻最多一个进行中的修炼
        const running = (w.d.sqlite.prepare("select count(*) c from cultivation_jobs where status='running'").get() as { c: number }).c;
        expect(running, ctx).toBeLessThanOrEqual(1);
      });
    }
    recordCoverage(w);
    w.d.close();
  });
});

describe('审计可重放：按序重放全部审计差异，必须恰好得到最终状态', () => {
  type Snap = Record<string, unknown>;
  const NESTED = ['inventory', 'npcs', 'relations', 'memories', 'quests'];
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  function replay(w: World, initial: Snap): Snap {
    const cur: Snap = structuredClone(initial);
    const rows = w.d.sqlite.prepare('select seq, event_type, before_json, after_json from audit_events order by seq').all() as {
      seq: number;
      event_type: string;
      before_json: string | null;
      after_json: string | null;
    }[];
    for (const r of rows) {
      const before = (r.before_json ? JSON.parse(r.before_json) : {}) as Snap;
      const after = (r.after_json ? JSON.parse(r.after_json) : {}) as Snap;
      for (const k of Object.keys(before)) {
        if (NESTED.includes(k)) {
          for (const id of Object.keys(before[k] as object)) {
            expect(((cur[k] ?? {}) as Snap)[id], `事件 ${r.seq}(${r.event_type}) 的前值与重放状态不符：${k}.${id}`).toEqual((before[k] as Snap)[id]);
          }
        } else {
          expect(cur[k], `事件 ${r.seq}(${r.event_type}) 的前值与重放状态不符：${k}`).toEqual(before[k]);
        }
      }
      for (const k of Object.keys(after)) {
        if (NESTED.includes(k)) Object.assign((cur[k] ??= {}) as Snap, after[k]);
        else cur[k] = after[k];
      }
    }
    return cur;
  }

  it.each([11, 12, 13, 14, 15, 16])('种子 %i：400 步随机操作后，审计重放 = 最终状态（没有任何未被审计的变更）', async (seed) => {
    const w = await world(seed, {});
    const initial = w.snap();
    for (let i = 0; i < 400; i++) await randomOp(w, () => undefined);
    const final = w.snap();
    const replayed = replay(w, initial);
    for (const k of new Set([...Object.keys(final), ...Object.keys(replayed)])) {
      expect(eq(replayed[k], final[k]), `字段 ${k}：重放=${JSON.stringify(replayed[k])} 最终=${JSON.stringify(final[k])}`).toBe(true);
    }
    const events = (w.d.sqlite.prepare('select count(*) c from audit_events').get() as { c: number }).c;
    expect(events).toBeGreaterThan(20); // 确保序列确实产生了足够多的变更
    recordCoverage(w);
    w.d.close();
  });
});

describe('幂等：重复提交不重复生效', () => {
  it.each([21, 22, 23])('种子 %i：随机穿插重复提交，结果与「每个幂等键只执行一次」的参照完全一致', async (seed) => {
    const real = await world(seed, {});
    const ref = await world(seed, {}); // 参照：同样的操作，但从不重复提交
    const sent: { key: string; body: object; first: unknown }[] = [];

    for (let i = 0; i < 200; i++) {
      const r = real.rng;
      const kind = pick(r, ['cultivate', 'rest', 'breakthrough'] as const);
      const body =
        kind === 'breakthrough'
          ? { kind: 'breakthrough', idempotencyKey: `idem-${seed}-${String(i).padStart(5, '0')}`, pillItemId: r() < 0.5 ? PILL : null }
          : { kind: 'fixed', idempotencyKey: `idem-${seed}-${String(i).padStart(5, '0')}`, actionId: kind };
      const clockStep = Math.floor(r() * 2 * H);
      real.wall.t += clockStep;
      ref.wall.t += clockStep;

      const res = await real.post('/api/v1/actions', body);
      const refRes = await ref.post('/api/v1/actions', body);
      expect(res.statusCode).toBe(refRes.statusCode);
      sent.push({ key: (body as { idempotencyKey: string }).idempotencyKey, body, first: res.statusCode === 200 ? res.json() : null });

      // 随机重放此前成功的请求若干次（含并发）
      const successes = sent.filter((s) => s.first !== null);
      if (successes.length > 0 && r() < 0.6) {
        const picks = Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(r, successes));
        const replays = await Promise.all(picks.map((p) => real.post('/api/v1/actions', p.body)));
        replays.forEach((rp, j) => {
          expect(rp.statusCode).toBe(200);
          expect(ActionResponseSchema.parse(rp.json())).toEqual(ActionResponseSchema.parse(picks[j]!.first));
        });
      }
    }
    expect(real.state()).toEqual(ref.state());
    expect(real.snap()).toEqual(ref.snap());
    const count = (w: World, t: string) => (w.d.sqlite.prepare(`select count(*) c from ${t}`).get() as { c: number }).c;
    expect(count(real, 'actions')).toBe(count(ref, 'actions'));
    expect(count(real, 'audit_events')).toBe(count(ref, 'audit_events'));
    real.d.close();
    ref.d.close();
  });
});

describe('时间：系统时间乱序时，放置修炼收益不超过理论上限', () => {
  it.each([31, 32, 33, 34])('种子 %i：随机前进/回拨/结算，收益单调且不超过「世界时间 × 速率」', async (seed) => {
    // 只做放置修炼；使用「始终在线」策略得到最宽松的上限（离线策略只会更少）
    const w = await world(seed, { thresholdMs: Number.MAX_SAFE_INTEGER });
    const perTick = IDLE_CULTIVATION.progressPerTick * 1.05; // 凡阶 + 头衔 5%
    await w.post('/api/v1/cultivation/start');
    const startWorld = w.clock.now();
    let last = w.state().realmProgress;
    for (let i = 0; i < 300; i++) {
      const r = w.rng();
      if (r < 0.35) w.wall.t += Math.floor(w.rng() * 6 * H);
      else if (r < 0.55) w.wall.t -= Math.floor(w.rng() * 72 * H); // 回拨
      else if (r < 0.9) {
        const res = await w.post('/api/v1/cultivation/settle');
        const cur = CultivationResponseSchema.parse(res.json()).player.realmProgress;
        expect(cur, `step ${i}`).toBeGreaterThanOrEqual(last); // 收益只增不减
        const maxPossible = Math.ceil(((w.clock.now() - startWorld) / IDLE_CULTIVATION.tickMs) * perTick) + 1;
        expect(cur, `step ${i}`).toBeLessThanOrEqual(Math.min(100, maxPossible));
        last = cur;
      } else {
        w.wall.t += Math.floor(w.rng() * 5 * MIN);
      }
    }
    w.d.close();
  });
});

describe('随机序列的覆盖面（防止测试空转）', () => {
  it('覆盖到全部事件类型、突破成功与失败、以及后天以上境界', () => {
    expect([...covered.types].sort()).toEqual(
      expect.arrayContaining(['action.breakthrough', 'action.cultivate', 'action.rest', 'cultivation.settle', 'cultivation.start', 'cultivation.stop', 'action.move', 'action.quest.accept', 'npc.met', 'npc.memory', 'quest.progress']),
    );
    expect([...covered.outcomes].sort()).toEqual(['failure', 'success']);
    expect([...covered.realms].some((r) => r !== 'body_tempering' && r !== 'opening')).toBe(true);
  });
});
