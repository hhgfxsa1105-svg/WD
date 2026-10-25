import { describe, expect, it } from 'vitest';
import { ActionResponseSchema, RelationExplainResponseSchema, type NpcMemory, type RelationExplainResponse } from '@jhz/contracts';
import { LOCATION_DEFS, MEMORY_CAP, NPC_DEFS, QUEST_DEFS, RELATION_RANGE, createInitialPlayer, createSeededRng, fixedRng } from '@jhz/game-rules';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { explainRelation } from '../src/modules/npc/explain.js';
import { meetNpc } from '../src/modules/npc/memory.js';
import { importSave } from '../src/modules/player/import.js';
import { buildSaveFile, parseSaveFile } from '../src/modules/player/save-file.js';
import { createMemoryGameStore } from '../src/modules/store/memory.js';
import { createSqliteGameStore } from '../src/modules/store/sqlite.js';
import type { GameStore } from '../src/modules/store/types.js';
import { snapshotWorld } from '../src/modules/store/world-rules.js';

const T0 = new Date(2026, 9, 23, 10, 0, 0).getTime();
const GUARD = 'npc_gate_guard';
const SISTER = 'npc_senior_sister';
const Q1 = 'quest_first_steps';
const Q2 = 'quest_prove_yourself';
const PILL = 'pill_breakthrough_fan';

const sqliteStore = () => {
  const d = openDatabase(':memory:');
  runMigrations(d.db);
  return { store: createSqliteGameStore(d.db), d };
};
const STORES: [string, () => GameStore][] = [
  ['内存', () => createMemoryGameStore()],
  ['SQLite', () => sqliteStore().store],
];

/** 一局游戏：固定时钟（每步前进 1 秒）与固定幂等键，便于逐字段比较 */
async function game(store: GameStore, rng: () => number) {
  const clock = { t: T0 };
  const app = await buildApp({ store, clock: { now: () => clock.t }, rng, offline: { thresholdMs: Number.MAX_SAFE_INTEGER } });
  let n = 0;
  const post = async (payload: object) => {
    clock.t += 1000;
    const r = await app.inject({ method: 'POST', url: '/api/v1/actions', payload: { idempotencyKey: `reg-key-${String(++n).padStart(6, '0')}`, ...payload } });
    return r.statusCode;
  };
  return {
    store,
    app,
    clock,
    post,
    quest: (questId: string, op: 'accept' | 'claim' | 'abandon') => post({ kind: 'quest', questId, op }),
    move: (locationId: string) => post({ kind: 'move', locationId }),
    fixed: (actionId: 'cultivate' | 'rest') => post({ kind: 'fixed', actionId }),
    breakthrough: (pill: string | null = null) => post({ kind: 'breakthrough', pillItemId: pill }),
    meet: (npc: string) => {
      clock.t += 1000;
      try {
        return meetNpc(store, npc, clock.t).firstMeeting;
      } catch {
        return null; // 不在场
      }
    },
    setProgress: (v: number) => {
      store.transact((tx) => tx.savePlayer({ ...tx.player(), realmProgress: v }));
    },
  };
}
type Game = Awaited<ReturnType<typeof game>>;

/** 世界状态的规范化视图：去掉随机 ID，排序，便于跨存储、跨运行逐字段比较 */
function normalized(store: GameStore) {
  return store.read((tx) => {
    const p = tx.player();
    const mem = (m: NpcMemory) => ({ type: m.type, summary: m.summary, importance: m.importance, sourceCount: m.sourceCount, createdAt: m.createdAt });
    const npcs = [...tx.npcs()].sort((a, b) => a.id.localeCompare(b.id));
    return {
      player: p,
      inventory: tx.inventory(),
      npcs,
      relationships: [...tx.relationships()].sort((a, b) => `${a.npcId}${a.targetType}${a.targetId}`.localeCompare(`${b.npcId}${b.targetType}${b.targetId}`)),
      quests: [...tx.quests()].sort((a, b) => a.id.localeCompare(b.id)),
      memories: Object.fromEntries(npcs.map((n) => [n.id, tx.memories(n.id).map(mem)])),
      log: tx.recentLog(500).map((l) => ({ type: l.type, narrative: l.narrative, changes: l.changes, note: l.note })),
    };
  });
}

/** 每个 NPC 对玩家与对其他 NPC 的全部关系解释（含事件序号）：用来比较「事件级」的一致性 */
function explanations(store: GameStore): RelationExplainResponse[] {
  return store.read((tx) => {
    const ids = tx.npcs().map((n) => n.id).sort();
    return ids.flatMap((id) => [
      explainRelation(tx, id, { type: 'player', id: 'player_1' }),
      ...ids.filter((o) => o !== id).map((o) => explainRelation(tx, id, { type: 'npc', id: o })),
    ]);
  });
}
const stripIds = (xs: RelationExplainResponse[]) => xs.map((x) => ({ ...x, changes: x.changes.map(({ eventId: _e, ...c }) => c) }));

/* ------------------------------------------------------------------ */
/* 1. 固定剧本：每一步都断言关系、记忆、任务、日志与审计                         */
/* ------------------------------------------------------------------ */

async function playNewbieChain(g: Game) {
  const log: Record<string, unknown> = {};
  const q = (id: string) => g.store.read((tx) => tx.quests()).find((x) => x.id === id)!;
  const rel = (npc: string) => g.store.read((tx) => tx.relationships()).find((r) => r.npcId === npc && r.targetType === 'player')!;

  expect(await g.quest(Q1, 'accept')).toBe(200);
  log.afterAccept = q(Q1).status;
  expect(g.meet(GUARD)).toBe(true);
  log.guardAfterMeet = { ...rel(GUARD) };
  expect(q(Q1).stepIndex).toBe(1);
  expect(await g.move('loc_qingyun_yard')).toBe(200);
  expect(q(Q1).stepIndex).toBe(2);
  expect(g.meet(SISTER)).toBe(true);
  expect(q(Q1).status).toBe('completed');
  expect(q(Q2).status).toBe('available');
  expect(await g.quest(Q1, 'claim')).toBe(200);
  log.guardAfterClaim = { ...rel(GUARD) };
  expect(await g.quest(Q2, 'accept')).toBe(200);
  g.setProgress(100);
  expect(await g.fixed('rest')).toBe(200); // 触发评估：第一步
  expect(q(Q2).stepIndex).toBe(1);
  expect(await g.breakthrough()).toBe(200); // 在练功场，苏晚晴见证
  expect(q(Q2).status).toBe('completed');
  expect(await g.quest(Q2, 'claim')).toBe(200);
  return log;
}

describe.each(STORES)('固定剧本：新手任务链（%s）', (_n, make) => {
  it('每一步的关系、记忆、任务、物品与货币都与预期逐项一致，且每个数值都能解释', async () => {
    const g = await game(make(), fixedRng(0));
    const mid = await playNewbieChain(g);
    // 中间检查点
    expect(mid.afterAccept).toBe('active');
    expect(mid.guardAfterMeet).toMatchObject({ affinity: 13, trust: 22, hostility: 0 }); // 种子 10/20 + 初次相识 +3/+2
    expect(mid.guardAfterClaim).toMatchObject({ affinity: 16, trust: 25, hostility: 0 }); // + 任务反应 +3/+3

    const w = normalized(g.store);
    // 苏晚晴：种子 20/30 + 初次相识 +3/+2 + 目睹突破成功 +3/+1 + 任务反应 +8/+6
    expect(w.relationships.find((r) => r.npcId === SISTER && r.targetType === 'player')).toMatchObject({ affinity: 34, trust: 39, hostility: 0 });
    // 没有参与的 NPC 完全不变
    expect(w.relationships.find((r) => r.npcId === 'npc_librarian' && r.targetType === 'player')).toMatchObject({ affinity: 0, trust: 10, hostility: 0 });
    expect(w.relationships.find((r) => r.npcId === 'npc_master_qingyun' && r.targetType === 'player')).toMatchObject({ affinity: 5, trust: 10, hostility: 0 });
    // 记忆：只有在场、亲历的人才有，摘要来自模板
    expect(w.memories[GUARD]!.map((m) => m.type)).toEqual(['met']);
    expect(w.memories[SISTER]!.map((m) => [m.type, m.summary])).toEqual([
      ['met', '你与苏晚晴初次相识。'],
      ['breakthrough_success', '苏晚晴亲眼见你突破至通窍。'],
    ]);
    expect(w.memories.npc_librarian).toEqual([]);
    expect(w.memories.npc_master_qingyun).toEqual([]);
    // 任务、境界、奖励
    expect(w.quests).toEqual([
      { id: Q1, status: 'completed', stepIndex: 3, claimed: true },
      { id: Q2, status: 'completed', stepIndex: 2, claimed: true },
    ]);
    expect(w.player.realm).toBe('opening');
    expect(w.player.location.id).toBe('loc_qingyun_yard');
    expect(w.player.currency).toMatchObject({ silver: expect.any(Number) });
    expect(w.inventory.find((i) => i.itemId === PILL)?.quantity).toBe(2); // 初始 1 + 任务奖励 1（突破时没有消耗丹药）
    // 玩家日志里依次出现各阶段的提示
    const text = w.log.map((l) => l.narrative).join('\n');
    for (const s of ['你接下了任务「初入山门」', '与守门弟子赵铁牛相识 ✓', '前往练功场 ✓', '任务「初入山门」完成，获得：铜钱 100', '新任务「证明自己」可以接取了', '修炼进度达到 50% ✓', '任务「证明自己」完成，获得：银两 20、凡阶突破丹 ×1']) expect(text, s).toContain(s);

    // 可解释性：初始值 + 每次变化 = 当前值，并且每次都对应一个审计事件
    const ex = explanations(g.store);
    expect(ex.every((e) => e.consistent)).toBe(true);
    const guard = ex.find((e) => e.npcId === GUARD && e.target.type === 'player')!;
    expect(guard.changes.map((c) => c.cause)).toEqual(['初次相识', '任务奖励的反应']);
    expect(guard.initial).toEqual({ affinity: 10, trust: 20, hostility: 0 });
    const sister = ex.find((e) => e.npcId === SISTER && e.target.type === 'player')!;
    expect(sister.changes.map((c) => c.cause)).toEqual(['初次相识', '目睹你突破', '任务奖励的反应']);
    expect(sister.changes.map((c) => c.delta.affinity)).toEqual([3, 3, 8]);
    for (const e of ex) {
      const sum = e.changes.reduce((a, c) => ({ affinity: a.affinity + c.delta.affinity, trust: a.trust + c.delta.trust, hostility: a.hostility + c.delta.hostility }), { affinity: 0, trust: 0, hostility: 0 });
      expect({ affinity: e.initial.affinity + sum.affinity, trust: e.initial.trust + sum.trust, hostility: e.initial.hostility + sum.hostility }).toEqual(e.current);
    }
  });

  it('同一初始状态、同一操作序列，重复运行得到逐字段相同的结果', async () => {
    const run = async () => {
      const g = await game(make(), fixedRng(0));
      await playNewbieChain(g);
      return { w: normalized(g.store), ex: stripIds(explanations(g.store)) };
    };
    expect(await run()).toEqual(await run());
  });

  it('突破失败的剧本：目睹失败只留下较轻的记忆，任务第二步不成立', async () => {
    const g = await game(make(), fixedRng(0.9999));
    g.meet(GUARD);
    await g.move('loc_qingyun_yard');
    g.meet(SISTER);
    await g.quest(Q1, 'accept');
    await g.quest(Q1, 'claim');
    await g.quest(Q2, 'accept');
    g.setProgress(100);
    await g.fixed('rest');
    await g.breakthrough();
    const w = normalized(g.store);
    expect(w.memories[SISTER]!.map((m) => m.type)).toEqual(['met', 'breakthrough_failure']);
    expect(w.quests.find((q) => q.id === Q2)).toMatchObject({ status: 'active', stepIndex: 1 });
    expect(w.player.realm).toBe('body_tempering');
    expect(explanations(g.store).every((e) => e.consistent)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 2. 同样的随机操作序列：内存与 SQLite 必须得到完全相同的世界                    */
/* ------------------------------------------------------------------ */

type Op = { t: 'cultivate' | 'rest' | 'breakthrough' | 'move' | 'quest' | 'meet' | 'progress'; a?: string; b?: string; n?: number };
function genOps(seed: number, count: number): Op[] {
  const r = createSeededRng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const locs = Object.keys(LOCATION_DEFS);
  const npcs = Object.keys(NPC_DEFS);
  const quests = Object.keys(QUEST_DEFS);
  const kinds: Op['t'][] = ['cultivate', 'rest', 'rest', 'breakthrough', 'move', 'move', 'quest', 'quest', 'meet', 'meet', 'progress'];
  return Array.from({ length: count }, () => {
    const t = pick(kinds);
    if (t === 'move') return { t, a: pick(locs) };
    if (t === 'quest') return { t, a: pick(quests), b: pick(['accept', 'accept', 'claim', 'abandon']) };
    if (t === 'meet') return { t, a: pick(npcs) };
    if (t === 'progress') return { t, n: 40 + Math.floor(r() * 61) };
    if (t === 'breakthrough') return { t, a: r() < 0.3 ? PILL : undefined };
    return { t };
  });
}
async function apply(g: Game, ops: Op[]) {
  for (const o of ops) {
    if (o.t === 'cultivate' || o.t === 'rest') await g.fixed(o.t);
    else if (o.t === 'breakthrough') await g.breakthrough(o.a ?? null);
    else if (o.t === 'move') await g.move(o.a!);
    else if (o.t === 'quest') await g.quest(o.a!, o.b as 'accept' | 'claim' | 'abandon');
    else if (o.t === 'meet') g.meet(o.a!);
    else g.setProgress(o.n!);
  }
}

describe('确定性：相同种子与操作序列，内存与 SQLite 逐字段一致', () => {
  it.each([101, 102, 103, 104])('种子 %i：400 步', async (seed) => {
    const ops = genOps(seed, 400);
    const results = [] as { w: ReturnType<typeof normalized>; ex: ReturnType<typeof stripIds> }[];
    for (const make of [() => createMemoryGameStore(), () => sqliteStore().store, () => createMemoryGameStore()]) {
      const g = await game(make(), createSeededRng(seed + 1));
      await apply(g, ops);
      results.push({ w: normalized(g.store), ex: stripIds(explanations(g.store)) });
    }
    expect(results[1]).toEqual(results[0]); // 内存 = SQLite
    expect(results[2]).toEqual(results[0]); // 重复运行 = 第一次
    // 这个序列确实走到了东西（防止空转）
    expect(results[0]!.ex.some((e) => e.changes.length > 0)).toBe(true);
  }, 60_000);
});

describe('长期游玩：数千次操作后世界依然合法、可解释', () => {
  it('3000 步：记忆有上限且重要记忆不丢，关系始终在范围内，任务状态合法，每个关系数值都能解释', async () => {
    const { store } = sqliteStore();
    const g = await game(store, createSeededRng(7));
    for (let chunk = 0; chunk < 6; chunk++) {
      await apply(g, genOps(500 + chunk, 500));
      const w = normalized(store);
      for (const [id, mems] of Object.entries(w.memories)) {
        const important = mems.filter((m) => m.importance > 5).length;
        expect(mems.length, id).toBeLessThanOrEqual(MEMORY_CAP + important);
      }
      for (const r of w.relationships) {
        expect(r.affinity).toBeGreaterThanOrEqual(RELATION_RANGE.affinity.min);
        expect(r.affinity).toBeLessThanOrEqual(RELATION_RANGE.affinity.max);
        expect(r.trust).toBeGreaterThanOrEqual(RELATION_RANGE.trust.min);
        expect(r.trust).toBeLessThanOrEqual(RELATION_RANGE.trust.max);
        expect(r.hostility).toBeGreaterThanOrEqual(RELATION_RANGE.hostility.min);
        expect(r.hostility).toBeLessThanOrEqual(RELATION_RANGE.hostility.max);
      }
      for (const q of w.quests) expect(['locked', 'available', 'active', 'completed', 'failed']).toContain(q.status);
      expect(explanations(store).every((e) => e.consistent), `第 ${chunk} 段后存在无法解释的关系数值`).toBe(true);
    }
    // 不会重复「初次相识」：每个 NPC 至多一条 met 记忆
    for (const n of Object.keys(NPC_DEFS)) expect(store.read((tx) => tx.memories(n)).filter((m) => m.type === 'met').length).toBeLessThanOrEqual(1);
  }, 120_000);
});

/* ------------------------------------------------------------------ */
/* 3. 存档回归：中途导出再导入，继续同一剧本，与不中断完全一致                       */
/* ------------------------------------------------------------------ */

describe('存档回归：导出再导入不改变后续', () => {
  it.each([201, 202, 203])('种子 %i：前 200 步后导出并导入到全新存档，后 200 步结果与不中断一致', async (seed) => {
    const first = genOps(seed, 200);
    const second = genOps(seed + 1000, 200);
    const a = sqliteStore();
    const ga = await game(a.store, fixedRng(0));
    await apply(ga, first);

    const text = JSON.stringify(a.store.read((tx) => buildSaveFile(tx.player(), snapshotWorld(tx))));
    const b = sqliteStore();
    importSave(b.d.db, parseSaveFile(text));
    const noLog = (x: ReturnType<typeof normalized>) => ({ ...x, log: [] }); // 玩家日志是历史记录，不属于存档状态
    expect(noLog(normalized(b.store))).toEqual(noLog(normalized(a.store))); // 导入后世界完全相同（记忆也原样保留，含「已相识」）

    const gb = await game(b.store, fixedRng(0));
    gb.clock.t = ga.clock.t; // 同一时刻继续
    await apply(ga, second);
    await apply(gb, second);
    expect(noLog(normalized(b.store))).toEqual(noLog(normalized(a.store)));
    // 导入后的存档同样可解释（导入事件 save.state 记录了跳变）
    expect(explanations(b.store).every((e) => e.consistent)).toBe(true);
  }, 60_000);
});

/* ------------------------------------------------------------------ */
/* 4. 解释接口                                                          */
/* ------------------------------------------------------------------ */

describe('接口：GET /world/npcs/:id/relation', () => {
  it('返回初始值、每次变化（对应审计事件序号）、当前值，并自检一致；NPC 之间的关系也可解释', async () => {
    const g = await game(createMemoryGameStore(), fixedRng(0));
    g.meet(GUARD);
    const get = async (url: string) => g.app.inject({ method: 'GET', url });
    const r = RelationExplainResponseSchema.parse((await get(`/api/v1/world/npcs/${GUARD}/relation`)).json());
    expect(r).toMatchObject({ npcId: GUARD, target: { type: 'player', id: 'player_1' }, initial: { affinity: 10, trust: 20, hostility: 0 }, current: { affinity: 13, trust: 22, hostility: 0 }, consistent: true });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ eventType: 'npc.memory', cause: '初次相识', delta: { affinity: 3, trust: 2, hostility: 0 } });
    // NPC → NPC：没有变化也能解释（初始 = 当前）
    const n = RelationExplainResponseSchema.parse((await get(`/api/v1/world/npcs/${SISTER}/relation?target=npc_master_qingyun`)).json());
    expect(n).toMatchObject({ initial: { affinity: 60, trust: 90, hostility: 0 }, current: { affinity: 60, trust: 90, hostility: 0 }, changes: [], consistent: true });
    // 从未建立过的有向边：全 0
    const z = RelationExplainResponseSchema.parse((await get(`/api/v1/world/npcs/${GUARD}/relation?target=npc_librarian`)).json());
    expect(z).toMatchObject({ initial: { affinity: 0, trust: 0, hostility: 0 }, current: { affinity: 0, trust: 0, hostility: 0 }, consistent: true });
  });

  it('未知 NPC / 未知对象 / 指向自己 404，非法参数 400，只读', async () => {
    const g = await game(createMemoryGameStore(), fixedRng(0));
    const get = (url: string) => g.app.inject({ method: 'GET', url });
    expect((await get('/api/v1/world/npcs/npc_nobody/relation')).statusCode).toBe(404);
    expect((await get(`/api/v1/world/npcs/${GUARD}/relation?target=npc_nobody`)).statusCode).toBe(404);
    expect((await get(`/api/v1/world/npcs/${GUARD}/relation?target=${GUARD}`)).statusCode).toBe(404);
    expect((await get(`/api/v1/world/npcs/${GUARD}/relation?foo=1`)).statusCode).toBe(400);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) expect((await g.app.inject({ method, url: `/api/v1/world/npcs/${GUARD}/relation`, payload: {} })).statusCode, method).toBe(404);
  });

  it('有未被审计的改动时，自检会报告不一致（这是该接口存在的意义）', async () => {
    const store = createMemoryGameStore();
    const g = await game(store, fixedRng(0));
    g.meet(GUARD);
    // 绕过审计直接改关系（只有 tx 层才能做到，业务代码不允许这样）
    store.transact((tx) => tx.adjustRelationship(GUARD, { type: 'player', id: 'player_1' }, { affinity: 5 }));
    const r = RelationExplainResponseSchema.parse((await g.app.inject({ method: 'GET', url: `/api/v1/world/npcs/${GUARD}/relation` })).json());
    expect(r.consistent).toBe(false);
    expect(r.current.affinity).toBe(18);
  });

  it('SQLite 与内存的解释结果相同（含事件序号）', async () => {
    const out = [];
    for (const [, make] of STORES) {
      const g = await game(make(), fixedRng(0));
      await playNewbieChain(g);
      out.push(stripIds(explanations(g.store)));
    }
    expect(out[1]).toEqual(out[0]);
  });
});

void ActionResponseSchema;

/* ------------------------------------------------------------------ */
/* 5. 存档里的背包（回归发现：此前导出/导入不带背包）                          */
/* ------------------------------------------------------------------ */

describe('存档带背包', () => {
  const exportOf = (s: GameStore) => s.read((tx) => buildSaveFile(tx.player(), snapshotWorld(tx)));
  const qty = (s: GameStore, id = PILL) => s.read((tx) => tx.inventory().find((i) => i.itemId === id)?.quantity ?? 0);

  it('往返一致：导出时的丹药数量导入后原样恢复（包括用完的）', () => {
    const a = sqliteStore();
    a.store.transact((tx) => tx.addItem(PILL, 4)); // 5 枚
    const b = sqliteStore();
    importSave(b.d.db, parseSaveFile(JSON.stringify(exportOf(a.store))));
    expect(qty(b.store)).toBe(5);
    a.store.transact((tx) => tx.takeItem(PILL, 5)); // 用完
    importSave(b.d.db, parseSaveFile(JSON.stringify(exportOf(a.store))));
    expect(qty(b.store)).toBe(0);
    expect(b.store.read((tx) => tx.inventory())).toEqual([]);
  });

  it('文件没有 inventory 字段（旧文件）：不改动目标存档的背包', () => {
    const a = sqliteStore();
    const f = JSON.parse(JSON.stringify(exportOf(a.store)));
    delete f.world.inventory;
    const b = sqliteStore();
    b.store.transact((tx) => tx.addItem(PILL, 2));
    importSave(b.d.db, parseSaveFile(JSON.stringify(f)));
    expect(qty(b.store)).toBe(3);
  });

  it.each([
    ['未知物品', [{ itemId: 'pill_breakthrough_god', quantity: 1 }], /未知物品/],
    ['物品重复', [{ itemId: PILL, quantity: 1 }, { itemId: PILL, quantity: 2 }], /物品重复/],
  ])('导入拒绝：%s（数据库不变）', (_n, inventory, msg) => {
    const a = sqliteStore();
    const f = JSON.parse(JSON.stringify(exportOf(a.store)));
    f.world.inventory = inventory;
    const b = sqliteStore();
    const before = qty(b.store);
    expect(() => importSave(b.d.db, parseSaveFile(JSON.stringify(f)))).toThrow(msg);
    expect(qty(b.store)).toBe(before);
  });

  it.each([
    ['数量为负', { itemId: PILL, quantity: -1 }],
    ['数量超过上限', { itemId: PILL, quantity: 10_000 }],
    ['数量为小数', { itemId: PILL, quantity: 1.5 }],
    ['含未知字段', { itemId: PILL, quantity: 1, price: 0 }],
  ])('格式层拒绝：%s', (_n, bad) => {
    const f = JSON.parse(JSON.stringify(exportOf(sqliteStore().store)));
    f.world.inventory = [bad];
    expect(() => parseSaveFile(JSON.stringify(f))).toThrow(/存档文件格式无效/);
  });

  it('数量为 0 的条目导入后不留行；导入造成的背包变化记在 save.state 事件里', () => {
    const a = sqliteStore();
    const f = JSON.parse(JSON.stringify(exportOf(a.store)));
    f.world.inventory = [{ itemId: PILL, quantity: 0 }];
    const b = sqliteStore();
    importSave(b.d.db, parseSaveFile(JSON.stringify(f)));
    expect(b.store.read((tx) => tx.inventory())).toEqual([]);
    const row = b.d.sqlite.prepare("select after_json a from audit_events where event_type='save.state'").get() as { a: string };
    expect(JSON.parse(row.a).inventory).toEqual({ [PILL]: 0 });
  });
});
