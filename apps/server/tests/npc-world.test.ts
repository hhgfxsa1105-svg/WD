import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { ActionResponseSchema, NPC_STATUSES, NpcListResponseSchema, RELATION_LIMITS } from '@jhz/contracts';
import { INITIAL_RELATIONS, LOCATION_DEFS, NPC_DEFS, NPC_STATUSES as RULE_STATUSES, RELATION_RANGE, createInitialPlayer, fixedRng } from '@jhz/game-rules';
import { buildApp } from '../src/app.js';
import { MIGRATIONS_DIR, openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { DB_NPC_STATUSES } from '../src/db/schema.js';
import { loadAiConfig } from '../src/modules/ai/config.js';
import { createAiGateway } from '../src/modules/ai/gateway.js';
import { createKeywordMockProvider, createMockProvider } from '../src/modules/ai/mock.js';
import { buildSystemPrompt } from '../src/modules/ai/prompt.js';
import { snapshot, stateDiff } from '../src/modules/audit/diff.js';
import { buildSaveFile, parseSaveFile } from '../src/modules/player/save-file.js';
import { createMemoryGameStore } from '../src/modules/store/memory.js';
import { createSqliteGameStore, ensureSeed, writePlayerState, writeWorldState } from '../src/modules/store/sqlite.js';
import type { GameStore } from '../src/modules/store/types.js';
import { mergeImportedWorld } from '../src/modules/store/world-rules.js';

const T0 = new Date(2026, 9, 23, 10, 0, 0).getTime();
const fresh = () => {
  const d = openDatabase(':memory:');
  runMigrations(d.db);
  return d;
};
const run = (d: ReturnType<typeof fresh>, sql: string, ...args: unknown[]) => d.sqlite.prepare(sql).run(...args);
const addNpc = (d: ReturnType<typeof fresh>, over: Record<string, unknown> = {}) => {
  const r = { id: 'npc_x', location_id: 'loc_x', status: 'active', goals_json: '[]', ...over };
  return run(d, 'insert into npcs (id, location_id, status, goals_json) values (@id, @location_id, @status, @goals_json)', r);
};
const addRel = (d: ReturnType<typeof fresh>, over: Record<string, unknown> = {}) => {
  const r = { npc_id: 'npc_x', target_type: 'player', target_id: 'player_1', affinity: 0, trust: 0, hostility: 0, ...over };
  return run(d, 'insert into npc_relationships (npc_id, target_type, target_id, affinity, trust, hostility) values (@npc_id, @target_type, @target_id, @affinity, @trust, @hostility)', r);
};

describe('数据库约束（npcs / npc_relationships）', () => {
  it('枚举与契约、规则表一致', () => {
    expect([...DB_NPC_STATUSES]).toEqual([...NPC_STATUSES]);
    expect([...RULE_STATUSES]).toEqual([...NPC_STATUSES]);
    expect(RELATION_LIMITS).toEqual(RELATION_RANGE);
  });

  it.each([
    ['状态非法', { status: 'dead' }],
    ['ID 没有 npc_ 前缀', { id: '赵铁牛' }],
    ['ID 过长', { id: `npc_${'a'.repeat(70)}` }],
    ['地点没有 loc_ 前缀', { location_id: 'gate' }],
    ['目标不是合法 JSON', { goals_json: '{oops' }],
    ['目标不是数组', { goals_json: '{"a":1}' }],
  ])('npcs 拒绝：%s', (_n, over) => {
    const d = fresh();
    expect(() => addNpc(d, over)).toThrow(/CHECK/);
    d.close();
  });

  it('npcs 主键唯一', () => {
    const d = fresh();
    addNpc(d, { id: 'npc_dup' });
    expect(() => addNpc(d, { id: 'npc_dup' })).toThrow(/UNIQUE|PRIMARY/);
    d.close();
  });

  it.each([
    ['好感 > 100', { affinity: 101 }],
    ['好感 < −100', { affinity: -101 }],
    ['信任 < 0', { trust: -1 }],
    ['信任 > 100', { trust: 101 }],
    ['敌意 < 0', { hostility: -1 }],
    ['敌意 > 100', { hostility: 101 }],
    ['对象类型非法', { target_type: 'faction' }],
    ['NPC 指向自己', { target_type: 'npc', target_id: 'npc_x' }],
  ])('npc_relationships 拒绝：%s', (_n, over) => {
    const d = fresh();
    addNpc(d);
    expect(() => addRel(d, over)).toThrow(/CHECK/);
    d.close();
  });

  it('边界值可以写入；同一有向边唯一；关系的 NPC 必须存在；删除 NPC 级联删除其关系', () => {
    const d = fresh();
    addNpc(d);
    expect(() => addRel(d, { affinity: -100, trust: 100, hostility: 100 })).not.toThrow();
    expect(() => addRel(d, { affinity: 100, trust: 0, hostility: 0, target_id: 'player_2' })).not.toThrow();
    expect(() => addRel(d)).toThrow(/UNIQUE|PRIMARY/);
    expect(() => addRel(d, { npc_id: 'npc_ghost' })).toThrow(/FOREIGN/);
    run(d, "delete from npcs where id = 'npc_x'");
    expect((d.sqlite.prepare('select count(*) c from npc_relationships').get() as { c: number }).c).toBe(0);
    d.close();
  });
});

describe('初始世界与升级', () => {
  const seededState = (s: GameStore) => s.read((tx) => ({ npcs: tx.npcs(), rels: tx.relationships() }));

  it('新存档（内存与 SQLite）：NPC 与关系与静态定义完全一致', () => {
    for (const store of [createMemoryGameStore(), createSqliteGameStore(fresh().db)]) {
      const { npcs, rels } = seededState(store);
      expect(npcs.map((n) => n.id).sort()).toEqual(Object.keys(NPC_DEFS).sort());
      for (const n of npcs) {
        expect(n.locationId).toBe(NPC_DEFS[n.id as keyof typeof NPC_DEFS].homeLocationId);
        expect(n.status).toBe('active');
        expect(n.goals).toEqual([...NPC_DEFS[n.id as keyof typeof NPC_DEFS].goals]);
        expect(Object.keys(LOCATION_DEFS)).toContain(n.locationId);
      }
      expect(rels).toHaveLength(INITIAL_RELATIONS.length);
      for (const seed of INITIAL_RELATIONS) expect(rels).toContainEqual(seed);
    }
  });

  it('重复初始化不会覆盖已变化的状态（地点、关系数值）', () => {
    const d = fresh();
    const s = createSqliteGameStore(d.db);
    s.transact((tx) => {
      tx.moveNpc('npc_gate_guard', 'loc_qingyun_yard');
      tx.adjustRelationship('npc_gate_guard', { type: 'player', id: 'player_1' }, { affinity: 15 });
    });
    const before = seededState(s);
    ensureSeed(d.db);
    createSqliteGameStore(d.db);
    expect(seededState(s)).toEqual(before);
    expect(before.npcs.find((n) => n.id === 'npc_gate_guard')?.locationId).toBe('loc_qingyun_yard');
  });

  it('旧存档带数据升级：玩家数据原样保留，世界数据在首次打开时补齐', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'jhz-npc-mig-'));
    try {
      cpSync(MIGRATIONS_DIR, tmp, { recursive: true });
      const journalPath = join(tmp, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      const full = journal.entries as { tag: string }[];
      const cut = full.findIndex((e) => e.tag.includes('npc_world'));
      expect(cut).toBeGreaterThan(0);
      journal.entries = full.slice(0, cut); // 去掉 NPC 相关的全部迁移，模拟 T-016 时期的数据库
      writeFileSync(journalPath, JSON.stringify(journal));

      const d = openDatabase(':memory:');
      migrate(d.db, { migrationsFolder: tmp });
      // 旧版本的存档：只有玩家与背包（直接写入，不经过当前版本的启动流程）
      d.sqlite.prepare("insert into players (id, display_name) values ('player_1', '林惊鸿')").run();
      d.sqlite
        .prepare(
          `insert into player_states (player_id, realm, realm_progress, hp, max_hp, stamina, max_stamina, yuanbao, silver, copper, attributes_json, location_id, location_name, version)
           values ('player_1','body_tempering',61,90,100,20,50,1,2,3,'{"spirit":5,"strength":5,"agility":5,"constitution":5,"comprehension":5,"fortune":5}','loc_qingyun_gate','青云山 · 山门',9)`,
        )
        .run();
      expect(() => d.sqlite.prepare('select * from npcs').all()).toThrow(/no such table/);

      runMigrations(d.db); // 升级到最新
      const s = createSqliteGameStore(d.db);
      const p = s.read((tx) => tx.player());
      expect(p.realmProgress).toBe(61);
      expect(p.version).toBe(9);
      expect(seededState(s).npcs).toHaveLength(Object.keys(NPC_DEFS).length);
      expect(seededState(s).rels).toHaveLength(INITIAL_RELATIONS.length);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

const stores: [string, () => GameStore][] = [
  ['内存', () => createMemoryGameStore()],
  ['SQLite', () => createSqliteGameStore(fresh().db)],
];

describe.each(stores)('存档层的人物与关系（%s）', (_n, make) => {
  const toPlayer = { type: 'player' as const, id: 'player_1' };
  const rel = (s: GameStore, npc: string, type = 'player', id = 'player_1') => s.read((tx) => tx.relationships()).find((r) => r.npcId === npc && r.targetType === type && r.targetId === id);

  it('关系变化走规则：单次限幅、夹在合法范围、返回新值并持久化', () => {
    const s = make();
    const start = rel(s, 'npc_gate_guard')!;
    const r1 = s.transact((tx) => tx.adjustRelationship('npc_gate_guard', toPlayer, { affinity: 9999, trust: -9999, hostility: 5 }));
    expect(r1).toMatchObject({ affinity: start.affinity + 20, trust: 0, hostility: start.hostility + 5 });
    expect(rel(s, 'npc_gate_guard')).toEqual(r1);
    for (let i = 0; i < 20; i++) s.transact((tx) => tx.adjustRelationship('npc_gate_guard', toPlayer, { affinity: 20 }));
    expect(rel(s, 'npc_gate_guard')!.affinity).toBe(100);
  });

  it('NPC → NPC 的关系：方向固定；不存在的有向边从 0 起算', () => {
    const s = make();
    expect(rel(s, 'npc_librarian', 'npc', 'npc_master_qingyun')).toBeUndefined();
    const r = s.transact((tx) => tx.adjustRelationship('npc_librarian', { type: 'npc', id: 'npc_master_qingyun' }, { trust: 12 }));
    expect(r).toEqual({ npcId: 'npc_librarian', targetType: 'npc', targetId: 'npc_master_qingyun', affinity: 0, trust: 12, hostility: 0 });
    expect(rel(s, 'npc_master_qingyun', 'npc', 'npc_librarian')).toBeUndefined(); // 反方向不受影响
  });

  it.each([
    ['未知 NPC', (tx: ReturnType<GameStoreTx>) => tx.adjustRelationship('npc_nobody', { type: 'player', id: 'player_1' }, { affinity: 1 }), 'NOT_FOUND'],
    ['显示名当 ID', (tx: ReturnType<GameStoreTx>) => tx.adjustRelationship('赵铁牛', { type: 'player', id: 'player_1' }, { affinity: 1 }), 'NOT_FOUND'],
    ['未知玩家', (tx: ReturnType<GameStoreTx>) => tx.adjustRelationship('npc_gate_guard', { type: 'player', id: 'player_9' }, { affinity: 1 }), 'NOT_FOUND'],
    ['未知 NPC 对象', (tx: ReturnType<GameStoreTx>) => tx.adjustRelationship('npc_gate_guard', { type: 'npc', id: 'npc_nobody' }, { affinity: 1 }), 'NOT_FOUND'],
    ['指向自己', (tx: ReturnType<GameStoreTx>) => tx.adjustRelationship('npc_gate_guard', { type: 'npc', id: 'npc_gate_guard' }, { affinity: 1 }), 'VALIDATION_FAILED'],
    ['移动到未知地点', (tx: ReturnType<GameStoreTx>) => tx.moveNpc('npc_gate_guard', 'loc_nowhere'), 'NOT_FOUND'],
    ['移动未知 NPC', (tx: ReturnType<GameStoreTx>) => tx.moveNpc('npc_nobody', 'loc_qingyun_gate'), 'NOT_FOUND'],
    ['非法状态', (tx: ReturnType<GameStoreTx>) => tx.setNpcStatus('npc_gate_guard', 'dead' as never), 'VALIDATION_FAILED'],
  ])('拒绝：%s', (_name, op, code) => {
    const s = make();
    const before = s.read((tx) => ({ n: tx.npcs(), r: tx.relationships() }));
    let err: { code?: string } | undefined;
    try {
      s.transact((tx) => op(tx));
    } catch (e) {
      err = e as { code?: string };
    }
    expect(err?.code).toBe(code);
    expect(s.read((tx) => ({ n: tx.npcs(), r: tx.relationships() }))).toEqual(before);
  });

  it('事务回滚：同一事务里先改后抛错，NPC 与关系都不变', () => {
    const s = make();
    const before = s.read((tx) => ({ n: tx.npcs(), r: tx.relationships() }));
    expect(() =>
      s.transact((tx) => {
        tx.moveNpc('npc_librarian', 'loc_qingyun_gate');
        tx.setNpcStatus('npc_librarian', 'away');
        tx.adjustRelationship('npc_librarian', toPlayer, { affinity: 20 });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(s.read((tx) => ({ n: tx.npcs(), r: tx.relationships() }))).toEqual(before);
  });

  it('移动与状态', () => {
    const s = make();
    const moved = s.transact((tx) => tx.moveNpc('npc_master_qingyun', 'loc_qingyun_yard'));
    expect(moved.locationId).toBe('loc_qingyun_yard');
    const rest = s.transact((tx) => tx.setNpcStatus('npc_master_qingyun', 'resting'));
    expect(rest).toMatchObject({ locationId: 'loc_qingyun_yard', status: 'resting' });
    expect(s.read((tx) => tx.npcs()).find((n) => n.id === 'npc_master_qingyun')).toEqual(rest);
  });

  it('审计快照：只有变化的关系/人物出现在差异里（嵌套展开）', () => {
    const s = make();
    const before = s.read((tx) => snapshot(tx));
    s.transact((tx) => {
      tx.adjustRelationship('npc_senior_sister', toPlayer, { affinity: 7 });
      tx.moveNpc('npc_librarian', 'loc_qingyun_hall');
    });
    const diff = stateDiff(before, s.read((tx) => snapshot(tx)))!;
    expect(Object.keys(diff.after).sort()).toEqual(['npcs', 'relations']);
    expect(Object.keys(diff.after.relations as object)).toEqual(['npc_senior_sister>player:player_1']);
    expect(diff.before.relations).toEqual({ 'npc_senior_sister>player:player_1': { affinity: 20, trust: 30, hostility: 0 } });
    expect(diff.after.relations).toEqual({ 'npc_senior_sister>player:player_1': { affinity: 27, trust: 30, hostility: 0 } });
    expect(Object.keys(diff.after.npcs as object)).toEqual(['npc_librarian']);
    expect(stateDiff(before, before)).toBeNull();
  });
});
type GameStoreTx = () => Parameters<Parameters<GameStore['transact']>[0]>[0];

describe('接口：GET /world/npcs', () => {
  it('返回静态显示文字 + 当前状态 + 对玩家的态度；随状态变化而变化', async () => {
    const store = createMemoryGameStore();
    const app = await buildApp({ store });
    const get = async () => NpcListResponseSchema.parse((await app.inject({ method: 'GET', url: '/api/v1/world/npcs' })).json()).npcs;
    const list = await get();
    expect(list).toHaveLength(Object.keys(NPC_DEFS).length);
    const guard = list.find((n) => n.id === 'npc_gate_guard')!;
    expect(guard).toMatchObject({ name: '赵铁牛', role: '守门弟子', location: { id: 'loc_qingyun_gate', name: '青云山 · 山门' }, status: 'active', towardPlayer: { affinity: 10, trust: 20, hostility: 0 } });
    store.transact((tx) => {
      tx.moveNpc('npc_gate_guard', 'loc_qingyun_library');
      tx.adjustRelationship('npc_gate_guard', { type: 'player', id: 'player_1' }, { affinity: 5 });
    });
    const after = (await get()).find((n) => n.id === 'npc_gate_guard')!;
    expect(after.location.name).toBe('青云山 · 藏经阁');
    expect(after.towardPlayer.affinity).toBe(15);
  });

  it('只读接口：POST 等写方法不存在', async () => {
    const app = await buildApp();
    expect((await app.inject({ method: 'POST', url: '/api/v1/world/npcs', payload: {} })).statusCode).toBe(404);
  });
});

describe('与人交谈（自由行动）：目标必须是存在的 NPC', () => {
  const plan = (target: unknown) =>
    JSON.stringify({ intent: '与人交谈', action_type: 'talk', target, steps: [], risk_tags: [], narrative_context: '', needs_clarification: false, clarification: null });
  async function setup(steps: string[]) {
    const store = createMemoryGameStore();
    const ai = createAiGateway({ config: { ...loadAiConfig({ AI_PROVIDER: 'mock' }), dailyCallLimit: 100 }, provider: createMockProvider({ steps }), log: store.aiLog, clock: { now: () => T0 } });
    const app = await buildApp({ store, ai, clock: { now: () => T0 }, rng: fixedRng(0) });
    let n = 0;
    const talk = async (input = '找人聊聊') => {
      const r = await app.inject({ method: 'POST', url: '/api/v1/actions', payload: { kind: 'free', idempotencyKey: `talk-key-${String(++n).padStart(4, '0')}`, input } });
      expect(r.statusCode).toBe(200);
      return ActionResponseSchema.parse(r.json());
    };
    return { store, talk };
  }
  const unchanged = async (s: Awaited<ReturnType<typeof setup>>, fn: () => Promise<ReturnType<typeof ActionResponseSchema.parse>>) => {
    const before = s.store.read((tx) => ({ p: tx.player(), n: tx.npcs(), r: tx.relationships(), seq: tx.recentLog(1) }));
    const res = await fn();
    expect(res.ai?.executed).toBe(false);
    expect(res.changes).toEqual([]);
    expect(res.log).toBeNull();
    expect(s.store.read((tx) => ({ p: tx.player(), n: tx.npcs(), r: tx.relationships(), seq: tx.recentLog(1) }))).toEqual(before);
    return res;
  };

  it('NPC 在同一地点：第一次见面留下记忆并微调关系；再次打招呼不改任何状态', async () => {
    const s = await setup([plan({ type: 'npc', id: 'npc_gate_guard' }), plan({ type: 'npc', id: 'npc_gate_guard' })]);
    const guard = () => s.store.read((tx) => tx.relationships().find((r) => r.npcId === 'npc_gate_guard' && r.targetType === 'player')!);
    const before = guard();
    const first = await s.talk('跟守门弟子打个招呼');
    expect(first.ai?.executed).toBe(true);
    expect(first.narrative).toContain('赵铁牛（守门弟子）');
    expect(first.log).toMatchObject({ type: 'system' });
    expect(guard()).toMatchObject({ affinity: before.affinity + 3, trust: before.trust + 2 });
    const mems = s.store.read((tx) => tx.memories('npc_gate_guard'));
    expect(mems).toHaveLength(1);
    expect(mems[0]).toMatchObject({ type: 'met', summary: '你与赵铁牛初次相识。', importance: 6 });
    // 再次打招呼：不再改变任何状态
    const second = await unchanged(s, () => s.talk('再跟守门弟子打个招呼'));
    expect(second.ai?.clarification).toContain('赵铁牛（守门弟子）');
    expect(s.store.read((tx) => tx.memories('npc_gate_guard'))).toHaveLength(1);
  });

  it('NPC 在别处：告知其所在地点', async () => {
    const s = await setup([plan({ type: 'npc', id: 'npc_master_qingyun' })]);
    const res = await unchanged(s, () => s.talk('去找掌门聊聊'));
    expect(res.ai?.clarification).toContain('青云山 · 大殿');
  });

  it('没有指定对象：列出这里的人', async () => {
    const s = await setup([plan(null)]);
    const res = await unchanged(s, () => s.talk());
    expect(res.ai?.clarification).toContain('赵铁牛');
    expect(res.ai?.clarification).not.toContain('苏晚晴'); // 她在练功场
  });

  it('编造的人物、用显示名当 ID：进入澄清', async () => {
    for (const id of ['npc_nobody', 'npc_zhao_tieniu']) {
      const s = await setup([plan({ type: 'npc', id })]);
      const res = await unchanged(s, () => s.talk('找神秘人'));
      expect(res.ai?.clarification).toContain('没找到');
    }
  });

  it('NPC 被移到玩家所在地点后可以见礼', async () => {
    const s = await setup([plan({ type: 'npc', id: 'npc_librarian' })]);
    s.store.transact((tx) => tx.moveNpc('npc_librarian', 'loc_qingyun_gate'));
    const res = await s.talk('找陆先生');
    expect(res.ai?.executed).toBe(true);
    expect(res.narrative).toContain('陆先生（藏经阁执事）');
  });

  it('提示词列出全部人物 ID；关键词模拟能按名字或称呼认人', async () => {
    const sys = buildSystemPrompt();
    for (const [id, d] of Object.entries(NPC_DEFS)) {
      expect(sys).toContain(id);
      expect(sys).toContain(d.name);
    }
    const mock = createKeywordMockProvider();
    const ask = async (text: string) => JSON.parse((await mock.complete({ purpose: 'parse', messages: [{ role: 'user', content: text }] })).text);
    expect((await ask('去找掌门聊聊')).target).toEqual({ type: 'npc', id: 'npc_master_qingyun' });
    expect((await ask('跟苏晚晴说说话')).target).toEqual({ type: 'npc', id: 'npc_senior_sister' });
    expect((await ask('找人聊聊')).target).toBeNull();
  });
});

describe('存档导出 / 导入包含人物状态', () => {
  const worldOf = (s: GameStore) => s.read((tx) => ({ npcs: tx.npcs(), relationships: tx.relationships() }));

  it('v2 往返一致：地点、状态、关系数值都被保留', () => {
    const d1 = fresh();
    const s1 = createSqliteGameStore(d1.db);
    s1.transact((tx) => {
      tx.moveNpc('npc_senior_sister', 'loc_qingyun_library');
      tx.setNpcStatus('npc_senior_sister', 'away');
      tx.adjustRelationship('npc_senior_sister', { type: 'player', id: 'player_1' }, { affinity: 13, hostility: 4 });
      tx.adjustRelationship('npc_librarian', { type: 'npc', id: 'npc_master_qingyun' }, { trust: 9 });
    });
    const text = JSON.stringify(buildSaveFile(s1.read((tx) => tx.player()), { ...worldOf(s1), memories: [] }));

    const d2 = fresh();
    const s2 = createSqliteGameStore(d2.db);
    const parsed = parseSaveFile(text);
    expect(parsed.schemaVersion).toBe(2);
    writePlayerState(d2.db, parsed.player);
    writeWorldState(d2.db, mergeImportedWorld(parsed.world!));
    expect(worldOf(s2)).toEqual(worldOf(s1));
  });

  it('导入覆盖当前世界：先前的变化被替换而不是叠加', () => {
    const d = fresh();
    const s = createSqliteGameStore(d.db);
    const original = worldOf(s);
    s.transact((tx) => tx.adjustRelationship('npc_gate_guard', { type: 'player', id: 'player_1' }, { affinity: 20 }));
    writeWorldState(d.db, mergeImportedWorld(original));
    expect(worldOf(s)).toEqual(original);
  });

  it('v1（旧格式，无人物状态）仍可导入，人物状态重置为初始', () => {
    const v1 = JSON.stringify({ format: 'jianghu-save', schemaVersion: 1, exportedAt: 'x', player: createInitialPlayer() });
    const parsed = parseSaveFile(v1);
    expect(parsed.world).toBeNull();
    const d = fresh();
    const s = createSqliteGameStore(d.db);
    s.transact((tx) => tx.moveNpc('npc_gate_guard', 'loc_qingyun_hall'));
    writeWorldState(d.db, null);
    expect(s.read((tx) => tx.npcs().find((n) => n.id === 'npc_gate_guard')!.locationId)).toBe('loc_qingyun_gate');
    expect(worldOf(s).relationships).toHaveLength(INITIAL_RELATIONS.length);
  });

  it('文件里缺少的 NPC 与关系用初始值补齐', () => {
    const merged = mergeImportedWorld({ npcs: [], relationships: [] });
    expect(merged.npcs).toHaveLength(Object.keys(NPC_DEFS).length);
    expect(merged.relationships).toHaveLength(INITIAL_RELATIONS.length);
  });

  const good = () => buildSaveFile(createInitialPlayer(), { ...worldOf(createMemoryGameStore()), memories: [] });
  it.each([
    ['未知 NPC', (w: ReturnType<typeof good>) => ((w as { world: { npcs: unknown[] } }).world.npcs = [{ id: 'npc_nobody', locationId: 'loc_qingyun_gate', status: 'active', goals: [] }]), /未知人物/],
    ['未知地点', (w: ReturnType<typeof good>) => ((w as { world: { npcs: unknown[] } }).world.npcs = [{ id: 'npc_gate_guard', locationId: 'loc_nowhere', status: 'active', goals: [] }]), /未知地点/],
    ['NPC 重复', (w: ReturnType<typeof good>) => ((w as { world: { npcs: unknown[] } }).world.npcs = [0, 1].map(() => ({ id: 'npc_gate_guard', locationId: 'loc_qingyun_gate', status: 'active', goals: [] }))), /重复/],
    ['关系指向自己', (w: ReturnType<typeof good>) => ((w as { world: { relationships: unknown[] } }).world.relationships = [{ npcId: 'npc_gate_guard', targetType: 'npc', targetId: 'npc_gate_guard', affinity: 0, trust: 0, hostility: 0 }]), /不合法/],
    ['关系对象是未知玩家', (w: ReturnType<typeof good>) => ((w as { world: { relationships: unknown[] } }).world.relationships = [{ npcId: 'npc_gate_guard', targetType: 'player', targetId: 'player_9', affinity: 0, trust: 0, hostility: 0 }]), /不合法/],
    ['关系重复', (w: ReturnType<typeof good>) => ((w as { world: { relationships: unknown[] } }).world.relationships = [0, 1].map(() => ({ npcId: 'npc_gate_guard', targetType: 'player', targetId: 'player_1', affinity: 0, trust: 0, hostility: 0 }))), /重复/],
  ])('导入拒绝：%s', (_n, mutate, msg) => {
    const f = good();
    mutate(f);
    const parsed = parseSaveFile(JSON.stringify(f));
    expect(() => mergeImportedWorld(parsed.world!)).toThrow(msg);
  });

  it.each([
    ['好感越界', (w: { world: { relationships: { affinity: number }[] } }) => (w.world.relationships[0]!.affinity = 101)],
    ['信任为负', (w: { world: { relationships: { trust: number }[] } }) => (w.world.relationships[0]!.trust = -1)],
    ['人物状态非法', (w: { world: { npcs: { status: string }[] } }) => (w.world.npcs[0]!.status = 'dead')],
    ['含未知字段', (w: { world: Record<string, unknown> }) => (w.world.extra = 1)],
  ])('格式层拒绝：%s', (_n, mutate) => {
    const f = JSON.parse(JSON.stringify(good()));
    mutate(f);
    expect(() => parseSaveFile(JSON.stringify(f))).toThrow(/存档文件格式无效/);
  });
});
