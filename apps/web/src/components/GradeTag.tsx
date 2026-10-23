import type { Grade } from '@jhz/contracts';
import { GRADE_LABEL, GRADE_RANK } from '../labels';

export function GradeTag({ grade }: { grade: Grade }) {
  return (
    <em className="g" data-g={GRADE_RANK[grade]}>
      {GRADE_LABEL[grade]}
    </em>
  );
}
