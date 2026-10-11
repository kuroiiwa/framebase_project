import assert from 'node:assert/strict';
import test from 'node:test';
import { repairBackupMonths } from '../app/icloud/release-repair.ts';

test('repair selection chooses distinct months rather than a spanning range', () => {
  const files = ['2017/12/09/a.MOV', '2017/12/20/b.MOV', '2019\\11\\29\\c.MOV'];
  const result = repairBackupMonths(files.map(relativePath => ({ relativePath })), ['2017-12', '2018-01', '2019-11']);
  assert.deepEqual(result, { months: ['2017-12', '2019-11'], unavailableMonths: [], unknownCount: 0 });
});

test('unavailable cloud months and invalid dates are reported instead of selected', () => {
  const files = ['2024/02/29/a.MOV', '2023/02/29/b.MOV', '2024/13/01/c.MOV', 'unknown.MOV', '2024/03/01/d.MOV'];
  const result = repairBackupMonths(files.map(relativePath => ({ relativePath })), ['2024-02']);
  assert.deepEqual(result, { months: ['2024-02'], unavailableMonths: ['2024-03'], unknownCount: 3 });
});
