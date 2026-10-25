import { REALM_LABELS, type AttributeKey, type Grade, type Realm } from '@jhz/contracts';

export const REALM_LABEL: Record<Realm, string> = REALM_LABELS;

export const GRADE_LABEL: Record<Grade, string> = { fan: '凡', huang: '黄', xuan: '玄', di: '地', tian: '天' };
export const GRADE_RANK: Record<Grade, number> = { fan: 1, huang: 2, xuan: 3, di: 4, tian: 5 };

/** 六维显示顺序：神、力、敏、根、悟、福 */
export const ATTRIBUTE_ORDER: { key: AttributeKey; label: string }[] = [
  { key: 'spirit', label: '神' },
  { key: 'strength', label: '力' },
  { key: 'agility', label: '敏' },
  { key: 'constitution', label: '根' },
  { key: 'comprehension', label: '悟' },
  { key: 'fortune', label: '福' },
];
