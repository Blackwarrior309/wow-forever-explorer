import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CLASSES } from '../src/game/classes';
import { QuestBook, questText, type QuestData } from '../src/game/quests';
import { gainXp, greyLevel, killXp, mobStats, money, questXp, sideOf } from '../src/game/rules';

const data = JSON.parse(readFileSync('public/game/quests.json', 'utf8')) as QuestData;
const human = { level: 1, race: 1 };
const orc = { level: 1, race: 2 };

test('experience follows vanilla: more for higher mobs, none for grey ones, double for elites', () => {
	expect(killXp(1, 1, false)).toBe(50);
	expect(killXp(10, 12, false)).toBe(Math.round(105 * 1.1));
	expect(killXp(20, greyLevel(20), false)).toBe(0);
	expect(killXp(10, 10, true)).toBe(2 * killXp(10, 10, false));
	expect(killXp(60, 60, false)).toBe(0);
	expect(questXp(1000, 10, 20)).toBe(100);
});

test('levelling carries spare experience over', () => {
	expect(gainXp(1, 300, 200, data.xp)).toEqual({ level: 2, xp: 100, levels: 1 });
	expect(gainXp(1, 0, 400 + 900 + 5, data.xp)).toEqual({ level: 3, xp: 5, levels: 2 });
	expect(gainXp(59, 0, 1e9, data.xp).level).toBe(60);
});

test('creature stats come from the template, else from level', () => {
	const s = mobStats([50, 50, 3, 5, 2000, 20, 0], 2);
	expect(s.health).toBe(50);
	expect(s.damage).toEqual([3, 5]);
	expect(mobStats(undefined, 10, 1).health).toBeGreaterThan(mobStats(undefined, 10, 0).health);
	expect(money(12345)).toBe('1g 23s 45c');
	expect(money(0)).toBe('0c');
	expect(sideOf(2)).toBe('horde');
	expect(sideOf(4)).toBe('alliance');
});

test('every class has a level 1 ability and unique ability ids', () => {
	for (const c of CLASSES) {
		expect(c.abilities.some((a) => a.level === 1)).toBe(true);
		expect(new Set(c.abilities.map((a) => a.id)).size).toBe(c.abilities.length);
	}
});

test('Northshire: a quest chain opens step by step, for its own side only', () => {
	const book = new QuestBook(data);
	// Wolves Across the Border (33) needs the quest before it.
	expect(book.canTake(33, human)).toBe(false);
	// Back to the start of the chain: A Threat Within (783), then Eagan Peltskinner (5261).
	let first = 33;
	while (data.quests[first].prev > 0) first = data.quests[first].prev;
	expect(first).toBe(783);
	expect(book.accept(first, orc)).not.toBeNull();
	expect(book.accept(first, human)).toBeNull();
	expect(book.canTake(5261, human)).toBe(false);
	expect(book.marker('c', 196, human)).toBeNull();
});

test('kills and drops count toward a quest, and handing it in pays and clears the bag', () => {
	const book = new QuestBook(data, { done: [data.quests[33].prev] });
	expect(book.offered('c', 196, human)).toEqual([33]);
	expect(book.marker('c', 196, human)).toBe('!');
	expect(book.accept(33, human)).toBeNull();
	const [[meat, need]] = data.quests[33].items;
	const wolf = Number(Object.entries(data.drops.c).find(([, d]) => d.some(([i]) => i === meat))![0]);
	for (let i = 0; i < need - 1; i++) book.killed(wolf, () => 0);
	expect(book.complete(33)).toBe(false);
	expect(book.marker('c', 196, human)).toBe('…');
	expect(book.killed(wolf, () => 0).at(-1)).toContain(`${need}/${need}`);
	expect(book.killed(wolf, () => 0)).toEqual([]);
	expect(book.complete(33)).toBe(true);
	expect(book.marker('c', 196, human)).toBe('?');
	const reward = book.turnIn(33, 1);
	expect(reward?.xp).toBe(data.quests[33].xp);
	expect(reward?.items).toHaveLength(1);
	expect(book.isDone(33)).toBe(true);
	expect(book.snapshot().bag[meat]).toBeUndefined();
	// Saved and read back.
	expect(new QuestBook(data, JSON.parse(JSON.stringify(book.snapshot()))).isDone(33)).toBe(true);
});

test('quest text codes are filled in', () => {
	expect(questText('Hail, $N the $R $C.$B$Gsir:madam;!', { name: 'Ana', className: 'Mage', raceName: 'Gnome', female: true })).toBe('Hail, Ana the Gnome Mage.\nmadam!');
});
