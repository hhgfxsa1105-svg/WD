import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ActionResponseSchema,
  ErrorResponseSchema,
  InventoryResponseSchema,
  PlayerStateSchema,
  type PlayerState,
} from '@jhz/contracts';
import { BREAKTHROUGH_RULES, createInitialPlayer, fixedRng } from '@jhz/game-rules';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { createMemoryGameStore } from '../src/modules/store/memory.js';
import { createSqliteGameStore } from '../src/modules/store/sqlite.js';
import type { GameStore } from '../src/modules/store/types.js';

const T0 = 1_800_000_000_000;
const PILL = 'pill_breakthrough_fan';
const full = (patch: Partial<PlayerState> = {}): PlayerState => ({ ...createInitialPlayer(), realmProgress: 100, ...patch });

async function setup(opts: { player?: PlayerState; rng?: number; store?: GameStore } = {}) {
  const store = opts.store ?? createMemoryGameStore(opts.player ?? full());
  const time = { t: T0 };
  const app = await buildApp({ store, clock: { now: () => time.t }, rng: fixedRng(opts.rng ?? 0) });
  const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/v1/actions', payload: payload as object });
  const bt = (n: number, pill: string | null = null) => post({ kind: 'breakthrough', idempotencyKey: `bt-key-${String(n).padStart(4, '0')}`, pillItemId: pill });
  const state = () => store.read((tx) => tx.player());
  const pills = () => store.read((tx) => tx.inventory().find((i) => i.itemId === PILL)?.quantity ?? 0);
  return { app, store, time, post, bt, state, pills };
}

describe('POST /actions 突破', () => {
  it('成功：晋级、进度清零、上限提升，返回成功率与掷点；不带丹药不扣库存', async () => {
    const { bt, state, pills } = await setup({ rng: 0 });
    const res = await bt(1);
    expect(res.statusCode).toBe(200);
    const body = ActionResponseSchema.parse(res.json());
    expect(body.breakthrough).toEqual({ outcome: 'success', chancePercent: 70, roll: 0 });
    expect(body.player.realm).toBe('opening');
    expect(body.player.realmProgress).toBe(0);
    expect(body.changes).toContainEqual({ stat: 'maxHp', delta: 30 });
    expect(state()).toEqual(body.player);
    expect(pills()).toBe(1);
  });

  it('带丹药：成功率 +10，丹药消耗 1 枚', async () => {
    const { bt, pills } = await setup({ rng: 0 });
    const body = ActionResponseSchema.parse((await bt(1, PILL)).json());
    expect(body.breakthrough!.chancePercent).toBe(80);
    expect(pills()).toBe(0);
  });

  it('失败：进度回落、气血受损、进入 24 小时冷却，且丹药照样消耗', async () => {
    const { bt, state, pills, time } = await setup({ rng: 0.9999 });
    const body = ActionResponseSchema.parse((await bt(1, PILL)).json());
    expect(body.breakthrough!.outcome).toBe('failure');
    expect(body.player.realm).toBe('body_tempering');
    expect(body.player.realmProgress).toBe(80);
    expect(body.player.hp).toBe(80);
    expect(state().breakthroughAvailableAt).toBe(time.t + BREAKTHROUGH_RULES.cooldownMs);
    expect(pills()).toBe(0);
  });

  it('冷却中被拒绝且不消耗丹药；24 小时后恢复可用', async () => {
    const { bt, post, store, state, pills, time } = await setup({ rng: 0.9999 });
    await bt(1); // 失败，进入冷却（不带丹药）
    store.transact((tx) => tx.savePlayer({ ...tx.player(), realmProgress: 100 })); // 假设已重新修炼满
    const before = state();

    time.t += BREAKTHROUGH_RULES.cooldownMs - 1;
    const early = await bt(2, PILL);
    expect(early.statusCode).toBe(422);
    expect(ErrorResponseSchema.parse(early.json()).message).toContain('隔一日');
    expect(pills()).toBe(1); // 丹药未被扣
    expect(state()).toEqual(before);

    time.t += 1;
    expect((await bt(3, PILL)).statusCode).toBe(200);
    expect(pills()).toBe(0);
    void post;
  });

  it('进度未满被拒绝，丹药与状态都不变', async () => {
    const { bt, state, pills } = await setup({ player: full({ realmProgress: 99 }) });
    const before = state();
    const res = await bt(1, PILL);
    expect(res.statusCode).toBe(422);
    expect(pills()).toBe(1);
    expect(state()).toEqual(before);
  });

  it('丹药不足被拒绝，状态不变（事务整体回滚）', async () => {
    const { bt, state, pills } = await setup({ rng: 0 });
    expect((await bt(1, PILL)).statusCode).toBe(200); // 用掉唯一的丹药
    expect(pills()).toBe(0);
    const before = state();
    const again = await bt(2, PILL);
    expect(again.statusCode).toBe(422);
    expect(state()).toEqual(before);
  });

  it('非突破物品 / 未知物品被拒绝', async () => {
    const { bt, pills } = await setup();
    expect((await bt(1, 'bogus_item')).statusCode).toBe(422);
    expect(pills()).toBe(1);
  });

  it('非法请求：物品 ID 格式错误返回 400', async () => {
    const { post } = await setup();
    const res = await post({ kind: 'breakthrough', idempotencyKey: 'bt-key-0001', pillItemId: 'Drop Table;' });
    expect(res.statusCode).toBe(400);
    expect((await post({ kind: 'breakthrough', idempotencyKey: 'bt-key-0001' })).statusCode).toBe(400);
  });

  it('幂等：同一幂等键重试只结算一次、只扣一枚丹药，返回同一 actionId', async () => {
    const { bt, pills } = await setup({ rng: 0 });
    const a = ActionResponseSchema.parse((await bt(7, PILL)).json());
    const b = ActionResponseSchema.parse((await bt(7, PILL)).json());
    expect(b.actionId).toBe(a.actionId);
    expect(pills()).toBe(0);
  });

  it('并发 5 路同一幂等键：只产生一次状态变更与一次扣除', async () => {
    const { bt, state, pills } = await setup({ rng: 0 });
    const rs = await Promise.all(Array.from({ length: 5 }, () => bt(9, PILL)));
    expect(new Set(rs.map((r) => ActionResponseSchema.parse(r.json()).actionId)).size).toBe(1);
    expect(state().version).toBe(1);
    expect(pills()).toBe(0);
  });

  it('同一幂等键换了丹药参数返回 409', async () => {
    const { bt } = await setup();
    await bt(5, PILL);
    expect((await bt(5, null)).statusCode).toBe(409);
  });

  it('最高境界被拒绝', async () => {
    const { bt } = await setup({ player: full({ realm: 'land_immortal', neili: { current: 1, max: 300 }, maxHp: 400, hp: 400 }) });
    expect((await bt(1)).statusCode).toBe(422);
  });

  it('逐级突破到后天会获得内力，并通过契约校验', async () => {
    const { bt, state } = await setup({ rng: 0 });
    await bt(1);
    const s1 = state();
    expect(s1.realm).toBe('opening');
    const { store, bt: bt2, state: st2 } = await setup({ player: full({ realm: 'opening' }), rng: 0 });
    void store;
    await bt2(1);
    expect(st2().neili).toEqual({ current: 0, max: 60 });
    expect(PlayerStateSchema.safeParse(st2()).success).toBe(true);
  });
});

describe('GET /player/inventory', () => {
  it('返回带名称与评级的库存，使用后数量为 0 的不显示', async () => {
    const { app, bt } = await setup({ rng: 0 });
    const inv = () => app.inject({ method: 'GET', url: '/api/v1/player/inventory' }).then((r) => InventoryResponseSchema.parse(r.json()));
    expect((await inv()).items).toEqual([{ itemId: PILL, name: '凡阶突破丹', kind: 'breakthrough_pill', grade: 'fan', quantity: 1 }]);
    await bt(1, PILL);
    expect((await inv()).items).toEqual([]);
  });
});

describe('持久化：突破冷却与丹药在重启后保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jhz-bt-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('失败后重启，冷却仍然生效；丹药消耗不会回滚', async () => {
    const file = join(dir, 's.sqlite');
    const open = () => {
      const d = openDatabase(file);
      runMigrations(d.db);
      return { d, store: createSqliteGameStore(d.db, full()) };
    };

    const a = open();
    const s1 = await setup({ store: a.store, rng: 0.9999 });
    expect((await s1.bt(1, PILL)).statusCode).toBe(200); // 失败 → 冷却
    await s1.app.close();
    a.d.close();

    const b = open();
    const s2 = await setup({ store: b.store, rng: 0 });
    b.store.transact((tx) => tx.savePlayer({ ...tx.player(), realmProgress: 100 }));
    expect(s2.pills()).toBe(0);
    const res = await s2.bt(2);
    expect(res.statusCode).toBe(422);
    expect(ErrorResponseSchema.parse(res.json()).message).toContain('隔一日');
    b.d.close();
  });
});
