import { PlayerStateSchema, type PlayerState } from '@jhz/contracts';

/** T-003 本地示例数据；T-004 起由服务端提供。加载时同样经过契约校验。 */
export function createInitialPlayer(): PlayerState {
  return PlayerStateSchema.parse({
    displayName: '林惊鸿',
    realm: 'body_tempering',
    realmProgress: 0,
    hp: 100,
    maxHp: 100,
    stamina: 50,
    maxStamina: 50,
    neili: null,
    currency: { yuanbao: 0, silver: 10, copper: 320 },
    attributes: { spirit: 5, strength: 5, agility: 5, constitution: 5, comprehension: 5, fortune: 5 },
    title: {
      id: 'title_sect_disciple',
      name: '山门弟子',
      grade: 'fan',
      effects: [{ kind: 'exp_multiplier', text: '修炼经验 +5%' }],
    },
    epithet: {
      id: 'epithet_newcomer',
      name: '初出茅庐',
      grade: 'fan',
      effects: [{ kind: 'affinity_modifier', text: '初次与人交谈，好感 +2' }],
    },
    fate: {
      id: 'fate_qisha',
      name: '七杀',
      grade: 'xuan',
      effects: [
        { kind: 'attribute_bonus', text: '力 +3，气血上限 +10%' },
        { kind: 'chance_modifier', text: '结仇概率提高' },
      ],
    },
    location: { id: 'loc_qingyun_gate', name: '青云山 · 山门' },
    version: 0,
  });
}

export const INITIAL_LOG = [
  { id: 0, time: '辰时', text: '你醒来时，天光尚淡。远处山门钟声一响，今日的江湖便开始了。', chips: [] as LogChip[], system: true },
];

export interface LogChip {
  text: string;
  tone: 'up' | 'down';
}
export interface LogEntry {
  id: number;
  time: string;
  text: string;
  chips: LogChip[];
  system?: boolean;
}
