// Builds public/game/creatures.json and public/game/quests.json, what the Adventure mode plays
// with (combat and quests), from the VMaNGOS world database (vanilla 1.12, GPL) as tab-separated
// tables: creature_templates, quests, quest_relations, loot, items, gameobject_templates and
// xp_for_level, with a header row starting "# " (as AzerothWanderer's data folder has them).
// Usage: bun run game -- path/to/data
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.argv[2];
if (!DIR) throw new Error('Usage: bun run game -- path/to/data (the folder with quests.tsv and the rest)');
const OUT = 'public/game';

/** A table's rows as objects keyed by its header. */
function table(name: string): Record<string, string>[] {
	const [head, ...lines] = readFileSync(join(DIR, `${name}.tsv`), 'utf8').split(/\r?\n/);
	const columns = head.replace(/^#\s*/, '').split('\t');
	return lines.filter((l) => l.trim()).map((l) => {
		const cells = l.split('\t');
		return Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? '']));
	});
}
const num = (v: string | undefined) => Number(v) || 0;
/** Quest text with the client's placeholders ($N name, $C class, $R race, $B line break, $g…:…; by sex) left for the page. */
const text = (v: string | undefined) => (v ?? '').replace(/\\n/g, '\n');

// Creatures: what combat needs that the spawn files don't carry.
const creatures: Record<number, number[]> = {};
const trainers: Record<number, number> = {};
const creatureNames = new Map<number, string>();
for (const c of table('creature_templates')) {
	creatureNames.set(num(c.entry), c.name);
	if ((num(c.npc_flags) & 16) && num(c.trainer_type) === 0 && num(c.trainer_class)) trainers[num(c.entry)] = num(c.trainer_class);
	// [health min, max, damage min, max, attack ms, aggro range, rank]
	creatures[num(c.entry)] = [num(c.health_min), num(c.health_max), num(c.dmg_min), num(c.dmg_max), num(c.attack_time), num(c.detection_range), num(c.rank)];
}

// Quest items and what drops them (loot rows flagged as quest drops).
const gameobjectLoot = new Map<number, number[]>();
const objectNames = new Map<number, string>();
for (const o of table('gameobject_templates')) {
	objectNames.set(num(o.entry), o.name);
	const loot = num(o.loot_id);
	if (loot) gameobjectLoot.set(loot, [...(gameobjectLoot.get(loot) ?? []), num(o.entry)]);
}
const drops: { c: Record<number, [number, number][]>; o: Record<number, [number, number][]> } = { c: {}, o: {} };
for (const l of table('loot')) {
	if (num(l.quest) !== 1) continue;
	const item = num(l.item);
	const chance = Math.abs(num(l.chance)) || 100;
	if (l.kind === 'creature') (drops.c[num(l.entry)] ??= []).push([item, chance]);
	else if (l.kind === 'gameobject') for (const entry of gameobjectLoot.get(num(l.entry)) ?? []) (drops.o[entry] ??= []).push([item, chance]);
}

interface Quest {
	t: string; d: string; o: string; r: string; q: string;
	lv: number; min: number; races: number; prev: number; next: number; xp: number; money: number;
	kill: [number, number][]; use: [number, number][]; items: [number, number][];
	rew: [number, number][]; choice: [number, number][]; ot: string[];
}
const quests: Record<number, Quest> = {};
const itemIds = new Set<number>();
const pairs = (q: Record<string, string>, id: string, count: string, n: number) =>
	Array.from({ length: n }, (_, i) => [num(q[`${id}${i + 1}`]), num(q[`${count}${i + 1}`])] as [number, number]).filter(([a, c]) => a && c);
for (const q of table('quests')) {
	const id = num(q.entry);
	const objectives = pairs(q, 'ReqCreatureOrGOId', 'ReqCreatureOrGOCount', 4);
	const items = pairs(q, 'ReqItemId', 'ReqItemCount', 4);
	const rew = pairs(q, 'RewItemId', 'RewItemCount', 4);
	const choice = pairs(q, 'RewChoiceItemId', 'RewChoiceItemCount', 6);
	for (const [item] of [...items, ...rew, ...choice]) itemIds.add(item);
	quests[id] = {
		t: q.Title, d: text(q.Details), o: text(q.Objectives), r: text(q.OfferRewardText), q: text(q.RequestItemsText),
		lv: num(q.QuestLevel), min: num(q.MinLevel), races: num(q.RequiredRaces), prev: num(q.PrevQuestId), next: num(q.NextQuestInChain),
		xp: num(q.RewXP), money: Math.max(0, num(q.RewOrReqMoney)),
		kill: objectives.filter(([e]) => e > 0), use: objectives.filter(([e]) => e < 0).map(([e, c]) => [-e, c]), items, rew, choice,
		ot: [1, 2, 3, 4].map((i) => q[`ObjectiveText${i}`] ?? ''),
	};
}

// Who starts and ends each quest: creatures and game objects by entry.
const starts: { c: Record<number, number[]>; o: Record<number, number[]> } = { c: {}, o: {} };
const ends: { c: Record<number, number[]>; o: Record<number, number[]> } = { c: {}, o: {} };
for (const r of table('quest_relations')) {
	const quest = num(r.quest);
	if (!quests[quest]) continue;
	const [who, what] = r.kind.split('_');
	const list = (what === 'start' ? starts : ends)[who === 'creature' ? 'c' : 'o'];
	(list[num(r.id)] ??= []).push(quest);
}

const items: Record<number, string> = {};
for (const i of table('items')) if (itemIds.has(num(i.entry))) items[num(i.entry)] = i.name;

// Names of what quests ask to kill or use, for the quest log.
const names: { c: Record<number, string>; o: Record<number, string> } = { c: {}, o: {} };
for (const q of Object.values(quests)) {
	for (const [entry] of q.kill) names.c[entry] = creatureNames.get(entry) ?? '';
	for (const [entry] of q.use) names.o[entry] = objectNames.get(entry) ?? '';
}

const xp = table('xp_for_level').map((r) => num(r.xp));

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'creatures.json'), JSON.stringify(creatures));
writeFileSync(join(OUT, 'trainers.json'), JSON.stringify(trainers));
writeFileSync(join(OUT, 'quests.json'), JSON.stringify({ xp, quests, starts, ends, drops, items, names }));
console.log(`${Object.keys(creatures).length} creatures, ${Object.keys(quests).length} quests, ${Object.keys(items).length} items written to ${OUT}`);
