import { expect, test } from 'bun:test';
import { describe } from '../src/explorer/spells';

test('spell descriptions get their numbers, durations and grammar filled in', () => {
	const values: Record<number, number[]> = { 1: [-20, 5000], 2: [3] };
	const value = (spell: number, e: number) => values[spell]?.[e] ?? null;
	const time = (spell: number) => (spell === 1 ? '15 sec' : null);
	expect(describe('Reduces damage by $s1% for $d.', value, time, 1)).toBe('Reduces damage by 20% for 15 sec.');
	expect(describe('Lasts $/1000;S2 sec, $2s1 $lpoint:points;.', value, time, 1)).toBe('Lasts 5 sec, 3 points.');
	expect(describe('$?s436895[Rune text][Usual text] with $h% and $s3.', value, time, 1)).toBe('Usual text with …% and ….');
});
