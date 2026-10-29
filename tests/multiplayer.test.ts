import { expect, test } from 'bun:test';
import { decodeState, encodeState, playerName, roomName, type PlayerState } from '../src/viewer/multiplayer';

const walking: PlayerState = {
	name: 'Thrall',
	kind: 'walk',
	look: { race: 2, sex: 0, hd: true, look: 3, outfit: null },
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
