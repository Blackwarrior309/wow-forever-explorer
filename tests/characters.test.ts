import { expect, test } from 'bun:test';
import { CharacterRoster, type CharacterSave } from '../src/game/characters';

const state = (cls = 1): CharacterSave => ({ cls, level: 4, xp: 25, money: 80, learned: ['rend'], quests: { active: [], done: [783], bag: {} } });
const storage = () => {
	const values = new Map<string, string>();
	return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

test('the previous single character migrates without changing its saved quests and abilities', () => {
	const data = storage();
	data.setItem('mapExplorer.adventure', JSON.stringify(state()));
	const roster = new CharacterRoster(data);
	expect(roster.current.state).toEqual(state());
	roster.update('First', roster.current.state);
	expect(new CharacterRoster(data).current.state).toEqual(state());
	expect(data.getItem('mapExplorer.adventure')).toBe(JSON.stringify(state()));
});

test('switching and reloading keeps each character progress independent', () => {
	const data = storage();
	const roster = new CharacterRoster(data);
	const first = roster.current.id;
	roster.update('Warrior', state());
	const mage = { ...state(8), level: 1, xp: 0, money: 0, learned: ['smite'], quests: { active: [], done: [], bag: {} } };
	const second = roster.create('Mage', mage);
	expect(roster.list()).toHaveLength(2);
	expect(roster.select(first)).toBe(true);
	expect(roster.current.state.quests.done).toEqual([783]);
	expect(roster.current.state.learned).toEqual(['rend']);
	roster.select(second);
	const reloaded = new CharacterRoster(data);
	expect(reloaded.current.name).toBe('Mage');
	expect(reloaded.current.state).toEqual(mage);
	expect(reloaded.select('missing')).toBe(false);
	expect(reloaded.current.id).toBe(second);
});

test('reading a slot does not allow another character to mutate its quests', () => {
	const roster = new CharacterRoster(null);
	roster.update('First', state());
	const snapshot = roster.current;
	snapshot.state.quests.done.push(999);
	expect(roster.current.state.quests.done).toEqual([783]);
});

test('characters remain usable in session when browser storage is blocked', () => {
	const roster = new CharacterRoster({ getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } });
	roster.create('New Mage', state(8));
	expect(roster.current.name).toBe('New Mage');
	expect(roster.list()).toHaveLength(2);
});

test('a stale browser tab cannot erase slots created in another tab', () => {
	const data = storage();
	const first = new CharacterRoster(data);
	const second = new CharacterRoster(data);
	const warrior = first.create('Warrior', state());
	second.update('Original', state(8));
	expect(new CharacterRoster(data).list().some((s) => s.id === warrior)).toBe(true);
	const mage = second.create('Mage', state(8));
	first.update('Warrior', { ...state(), money: 123 });
	const loaded = new CharacterRoster(data);
	expect(loaded.list()).toHaveLength(3);
	expect(loaded.list().find((s) => s.id === mage)?.name).toBe('Mage');
	expect(loaded.list().find((s) => s.id === warrior)?.state.money).toBe(123);
});
