import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const nowMs = sql`(unixepoch('subsec') * 1000)`;
/** 与 @jhz/contracts 的 REALMS 保持一致（测试校验）；drizzle-kit 无法加载 TS 源码包，故此处内联 */
export const DB_REALMS = ['body_tempering', 'opening', 'houtian', 'xiantian', 'grandmaster', 'mingshen', 'land_immortal'] as const;
const realmList = sql.raw(DB_REALMS.map((r) => `'${r}'`).join(', '));

export const players = sqliteTable('players', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  createdAt: integer('created_at').notNull().default(nowMs),
  updatedAt: integer('updated_at').notNull().default(nowMs),
});

/** 角色当前状态（权威存档）。名号与六维以 JSON 存储，数值型资源拆列以便约束。 */
export const playerStates = sqliteTable(
  'player_states',
  {
    playerId: text('player_id').primaryKey(),
    realm: text('realm').notNull(),
    realmProgress: integer('realm_progress').notNull(),
    hp: integer('hp').notNull(),
    maxHp: integer('max_hp').notNull(),
    stamina: integer('stamina').notNull(),
    maxStamina: integer('max_stamina').notNull(),
    neiliCurrent: integer('neili_current'),
    neiliMax: integer('neili_max'),
    yuanbao: integer('yuanbao').notNull(),
    silver: integer('silver').notNull(),
    copper: integer('copper').notNull(),
    attributesJson: text('attributes_json').notNull(),
    titleJson: text('title_json'),
    epithetJson: text('epithet_json'),
    fateJson: text('fate_json'),
    locationId: text('location_id').notNull(),
    locationName: text('location_name').notNull(),
    breakthroughAvailableAt: integer('breakthrough_available_at'),
    version: integer('version').notNull().default(0),
    createdAt: integer('created_at').notNull().default(nowMs),
    updatedAt: integer('updated_at').notNull().default(nowMs),
  },
  (t) => [
    foreignKey({ columns: [t.playerId], foreignColumns: [players.id] }).onDelete('cascade'),
    check('player_states_realm_valid', sql`${t.realm} in (${realmList})`),
    check('player_states_progress_range', sql`${t.realmProgress} between 0 and 100`),
    check('player_states_hp_range', sql`${t.hp} >= 0 and ${t.maxHp} >= 1 and ${t.hp} <= ${t.maxHp}`),
    check('player_states_stamina_range', sql`${t.stamina} >= 0 and ${t.maxStamina} >= 1 and ${t.stamina} <= ${t.maxStamina}`),
    check(
      'player_states_neili_consistent',
      sql`(${t.neiliCurrent} is null and ${t.neiliMax} is null) or (${t.neiliCurrent} is not null and ${t.neiliMax} is not null and ${t.neiliCurrent} >= 0 and ${t.neiliMax} >= 1 and ${t.neiliCurrent} <= ${t.neiliMax})`,
    ),
    check('player_states_currency_nonneg', sql`${t.yuanbao} >= 0 and ${t.silver} >= 0 and ${t.copper} >= 0`),
    check('player_states_version_nonneg', sql`${t.version} >= 0`),
    check('player_states_cooldown_nonneg', sql`${t.breakthroughAvailableAt} is null or ${t.breakthroughAvailableAt} >= 0`),
  ],
);
