import { expect, test } from 'bun:test';
import { decodeEvent, decodeMobs, decodeState, encodeState, playerName, roomName, type PlayerState } from '../src/viewer/multiplayer';

const walking: PlayerState = {
	name: 'Thrall',
	kind: 'walk',
	look: { race: 2, sex: 0, hd: true, look: 3, outfit: null },
	map: 1,
	position: [100.123, -20.5, 3000.987],
	facing: 1.5,
	state: 'swim',
	intent: [1, -1],
	velocity: [7, 0, -1],
	moveSpeed: 7,
	jumped: false,
	walkMode: true,
	turning: 1,
	emote: 'dance',
	hp: 80,
	maxHp: 120,
	level: 7,
	cls: 8,
};

test('a state survives the trip, positions to the centimetre', () => {
	const back = decodeState(encodeState(walking));
	expect(back).toEqual({ ...walking, position: [100.12, -20.5, 3000.99] });
});

test('malformed or hostile messages are dropped or tamed', () => {
	expect(decodeState('not json')).toBeNull();
	expect(decodeState('null')).toBeNull();
	expect(decodeState(JSON.stringify({ k: 'walk', p: [0, 0], f: 0, l: { race: 1, sex: 0, look: 0 } }))).toBeNull();
	expect(decodeState(JSON.stringify({ k: 'walk', p: [0, 0, Infinity], f: 0, l: { race: 1, sex: 0, look: 0 } }))).toBeNull();
	expect(decodeState(JSON.stringify({ k: 'admin', p: [0, 0, 0], f: 0, l: { race: 1, sex: 0, look: 0 } }))).toBeNull();
	expect(decodeState('x'.repeat(5000))).toBeNull();
	const odd = decodeState(JSON.stringify({ n: '\u0007x'.repeat(40), k: 'fly', p: [1, 2, 3], f: 0, l: { race: 1, sex: 1, look: 0, outfit: '__proto__' }, s: 'flying', i: [1, -0.2], e: 'explode', m: -3 }));
	expect(odd).not.toBeNull();
	expect(odd!.name).toBe('x'.repeat(24));
	expect(odd!.look.outfit).toBeNull();
	expect(odd!.state).toBe('ground');
	expect(odd!.intent).toEqual([1, -1]);
	expect(odd!.emote).toBeNull();
	expect(odd!.moveSpeed).toBe(0);
});

test('names and rooms are made safe', () => {
	expect(roomName('  Mowl Server! ')).toBe('mowl-server');
	expect(roomName('###')).toBe('azeroth');
	expect(roomName('a/b/+/#')).toBe('a-b');
	expect(playerName('   ')).toBe('Adventurer');
	expect(playerName(' Jaina ')).toBe('Jaina');
});

test('combat events and mob reports are checked like states', () => {
	expect(decodeEvent(JSON.stringify({ t: 'hit', k: '775971:creature:12', a: 30, s: 2 }))).toEqual({ t: 'hit', k: '775971:creature:12', a: 30, s: 2 });
	expect(decodeEvent(JSON.stringify({ t: 'hit', k: 'x', a: -5 }))).toBeNull();
	expect(decodeEvent(JSON.stringify({ t: 'hit', k: '../../etc', a: 5 }))).toBeNull();
	expect(decodeEvent(JSON.stringify({ t: 'dmg', to: 'abc123', a: 12, n: 'Wolf' }))).toEqual({ t: 'dmg', to: 'abc123', a: 12, n: 'Wolf' });
	expect(decodeEvent(JSON.stringify({ t: 'kill', k: 'k1', e: 299, l: 3, x: false, by: ['abc', 7, 'BAD ID'] }))).toEqual({ t: 'kill', k: 'k1', e: 299, l: 3, x: false, by: ['abc'] });
	expect(decodeEvent(JSON.stringify({ t: 'heal', k: 'k1' }))).toBeNull();
	const mobs = decodeMobs(JSON.stringify({ mobs: [
		{ k: 'k1', e: 299, l: 3, hp: 999, max: 50, m: 0, p: [1, 2, 3], f: 0.5, s: 0, t: 'abc', w: 4 },
		{ k: 'k2', e: 1, l: 1, hp: 1, max: 1, p: [1, 2], f: 0, s: 0, t: '', w: 0 },
		{ k: 'k3', e: 1, l: 1, hp: 1, max: 1, p: [1, 2, 3], f: 0, s: 7, t: '', w: 0 },
	] }));
	expect(mobs).toEqual([{ k: 'k1', e: 299, l: 3, hp: 50, max: 50, m: 0, p: [1, 2, 3], f: 0.5, s: 0, t: 'abc', w: 4 }]);
	expect(decodeMobs('[]')).toBeNull();
});
