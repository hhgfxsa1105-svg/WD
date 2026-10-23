import { PlayerStateSchema, type PlayerState } from '@jhz/contracts';

/** 新存档的初始角色（种子数据；名号与评级后续由规则表提供） */
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
      effects: [{ kind: 'exp_multiplier', value: 5, text: '修炼经验 +5%' }],
    },
    epithet: {
      id: 'epithet_newcomer',
      name: '初出茅庐',
      grade: 'fan',
      effects: [{ kind: 'affinity_modifier', value: 2, text: '初次与人交谈，好感 +2' }],
    },
    fate: {
      id: 'fate_qisha',
      name: '七杀',
      grade: 'xuan',
      effects: [
        { kind: 'attribute_bonus', value: 3, text: '力 +3，气血上限 +10%' },
        { kind: 'chance_modifier', value: 10, text: '结仇概率提高' },
      ],
    },
    location: { id: 'loc_qingyun_gate', name: '青云山 · 山门' },
    version: 0,
  });
}
