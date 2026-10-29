/**
 * RestedXP-style leveling guides (the text format the addon's guides are written in): read,
 * narrowed to one character (faction, race, class, game version) and followed guide by guide
 * along their #next links. The guide file is the player's own; it is read in the browser and
 * never shipped with this project.
 */

export interface Character {
	faction: 'Alliance' | 'Horde';
	/** Race and class as guides name them: NightElf, Druid. */
	race: string;
	cls: string;
}

/** Game versions and modes the guides tell apart: Forever plays as Classic Era, normal (softcore) realm. */
const ON = new Set(['forever', 'classic', 'era', 'softcore']);
const OFF = new Set(['tbc', 'wotlk', 'sod', 'som', 'season', 'hardcore', 'hardcoreserver', 'skip', 'ssf']);
const RACES = new Set(['Human', 'Dwarf', 'NightElf', 'Gnome', 'Draenei', 'Orc', 'Undead', 'Scourge', 'Tauren', 'Troll', 'BloodElf', 'Goblin']);
const CLASSES = new Set(['Warrior', 'Paladin', 'Hunter', 'Rogue', 'Priest', 'Shaman', 'Mage', 'Warlock', 'Druid', 'DeathKnight']);

/**
 * Whether a condition ("Alliance !Hunter", "NightElf/Druid") holds: within a kind (classes, say)
 * any one listed is enough, across kinds all must hold, and a negated one must not.
 */
export function holds(condition: string, who: Character): boolean {
	const tokens = condition.split(/[\s/]+/).filter(Boolean);
	const wanted = new Map<string, boolean>();
	for (const raw of tokens) {
		const negated = raw.startsWith('!');
		const t = negated ? raw.slice(1) : raw;
		const kind = t === 'Alliance' || t === 'Horde' ? 'faction' : RACES.has(t) ? 'race' : CLASSES.has(t) ? 'class' : 'flag';
		// Flags the page doesn't know (SoD runes, hardcore...) count as not holding.
		const value = kind === 'faction' ? t === who.faction : kind === 'race' ? t === who.race : kind === 'class' ? t === who.cls : ON.has(t.toLowerCase());
		if (negated) {
			if (value) return false;
			continue;
		}
		// Flags each must hold; races and classes any of those listed.
		if (kind === 'flag') {
			if (!value) return false;
		} else wanted.set(kind, (wanted.get(kind) ?? false) || value);
	}
	return [...wanted.values()].every(Boolean);
}

/** Splits " << condition" off the end of a line. */
function splitCondition(line: string): [string, string | null] {
	const m = /^(.*?)\s*<<\s*([!A-Za-z/ ]+)$/.exec(line);
	return m ? [m[1], m[2].trim()] : [line, null];
}

interface RawStep {
	condition: string | null;
	lines: string[];
}

export interface Guide {
	name: string;
	group: string;
	subgroup: string;
	/** The guide's own condition (the "<< Alliance !Hunter" line under its header). */
	condition: string;
	/** Guides to go on to, each with its condition. */
	next: { name: string; condition: string | null }[];
	/** Who starts with this guide (the "#defaultfor NightElf" line), if anyone. */
	defaultFor: string | null;
	steps: RawStep[];
}

/**
 * Reads every guide in a file: guide text as the addon imports it, or the addon's own .lua
 * files, whose guides sit each in a RegisterGuide([[...]]) call.
 */
export function parseGuides(text: string): Guide[] {
	const blocks = [...text.matchAll(/RegisterGuide\(\s*\[(=*)\[([\s\S]*?)\]\1\]/g)].map((m) => m[2]);
	return blocks.length ? blocks.flatMap(parseText) : parseText(text);
}

function parseText(text: string): Guide[] {
	const guides: Guide[] = [];
	let header: { group?: string; subgroup?: string; condition?: string; defaultFor?: string; next: Guide['next'] } = { next: [] };
	let guide: Guide | null = null;
	let step: RawStep | null = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('--')) continue;
		// After a guide's steps, its header lines start the next guide.
		if (step && /^#(version|group|forever)\b/.test(line)) {
			step = null;
			guide = null;
			header = { next: [] };
		}
		const [body, condition] = splitCondition(line);
		if (body === 'step') {
			if (guide) guide.steps.push((step = { condition, lines: [] }));
			continue;
		}
		if (step) {
			step.lines.push(line);
			continue;
		}
		// Header lines may come before or after the guide's #name.
		if (body.startsWith('#group ')) {
			header.group = body.slice(7);
			if (guide) guide.group = header.group;
		} else if (body.startsWith('#subgroup ')) {
			header.subgroup ??= body.slice(10);
			if (guide) guide.subgroup ||= header.subgroup;
		}
		else if (body.startsWith('#name ')) {
			guide = { name: body.slice(6), group: header.group ?? '', subgroup: header.subgroup ?? '', condition: header.condition ?? '', next: header.next, defaultFor: header.defaultFor ?? null, steps: [] };
			guides.push(guide);
		} else if (body.startsWith('#next ')) {
			for (const n of body.slice(6).split(';')) (guide ?? header).next.push({ name: n.trim().replace(/^.*\\/, ''), condition });
		} else if (body.startsWith('#defaultfor ')) {
			const who = body.slice(12).trim();
			// "#defaultfor None" turns an earlier one off.
			const value = who === 'None' ? null : who;
			if (guide) guide.defaultFor = value;
			else header.defaultFor = value ?? undefined;
		} else if (!body && condition) {
			header.condition = condition;
			if (guide) guide.condition = condition;
		}
	}
	return guides;
}

/** A place to go: WoW coordinates on a UiMap's continent, or a share of a zone's map (0-100). */
export type Waypoint = { ui: number; x: number; y: number } | { zone: string; px: number; py: number };

/** One step of the route, as far as this page shows and follows it. */
export interface RouteStep {
	guide: string;
	/** What to do, in short lines with the guide's highlights (friendly, enemy, loot...). */
	text: Segment[][];
	accept: number[];
	turnin: number[];
	complete: number[];
	/** Where to go; the last is where the step happens. */
	goto: Waypoint[];
	/** Optional steps and those done alongside the next can be passed by. */
	optional: boolean;
}

export interface Segment {
	text: string;
	/** RXP colour name (FRIENDLY, ENEMY, LOOT, PICK, BUY, WARN...), if any. */
	tone?: string;
}

/** The guide's in-game text codes turned into plain segments: icons dropped, colours kept as tones. */
export function segments(text: string): Segment[] {
	const out: Segment[] = [];
	const clean = text.replace(/\|T[^|]*\|t/g, '').replace(/\|H[^|]*\|h(.*?)\|h/g, '$1').replace(/::\d+/g, '');
	const re = /\|c(?:RXP_([A-Z]+)_|[0-9a-fA-F]{8})(.*?)\|r/g;
	let at = 0;
	for (let m: RegExpExecArray | null; (m = re.exec(clean)); ) {
		if (m.index > at) out.push({ text: clean.slice(at, m.index) });
		out.push({ text: m[2], tone: m[1] ?? 'WHITE' });
		at = re.lastIndex;
	}
	if (at < clean.length) out.push({ text: clean.slice(at) });
	return out.filter((s) => s.text);
}

function waypoint(args: string): Waypoint | null {
	const parts = args.split(',').map((p) => p.trim());
	const world = /^(\d+)\/\d+$/.exec(parts[0]);
	const a = Number(parts[1]), b = Number(parts[2]);
	if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
	// World coordinates come as y, x (as the game's map pins do).
	if (world) return { ui: Number(world[1]), x: b, y: a };
	return { zone: parts[0], px: a, py: b };
}

/** What a guide's step comes to for one character: null when the step isn't theirs. */
function toStep(guide: string, raw: RawStep, who: Character): RouteStep | null {
	if (raw.condition && !holds(raw.condition, who)) return null;
	const step: RouteStep = { guide, text: [], accept: [], turnin: [], complete: [], goto: [], optional: false };
	for (const line of raw.lines) {
		const [body, condition] = splitCondition(line);
		if (condition && !holds(condition, who)) continue;
		if (body.startsWith('#')) {
			const tag = body.slice(1).split(/\s/)[0].toLowerCase();
			if (OFF.has(tag)) return null;
			if (tag === 'optional' || tag === 'completewith') step.optional = true;
			continue;
		}
		if (body.startsWith('+')) {
			step.text.push(segments(body.slice(1)));
			continue;
		}
		const [command, ...rest] = body.split('>>');
		const said = rest.join('>>').trim();
		if (!command.trim()) {
			if (said) step.text.push(segments(said));
			continue;
		}
		const m = /^\.(\w+)\s*(.*)$/.exec(command.trim());
		if (!m) continue;
		const [, cmd, args] = m;
		const ids = args.split(/[\s,]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
		if (cmd === 'goto') {
			const w = waypoint(args);
			if (w) step.goto.push(w);
		} else if (cmd === 'accept') step.accept.push(ids[0]);
		else if (cmd === 'turnin') step.turnin.push(ids[0]);
		else if (cmd === 'complete') step.complete.push(ids[0]);
		else if (cmd === 'xp' && !said) step.text.push([{ text: `Grind to level ${args.split(/\s/)[0]}` }]);
		else if (cmd === 'hs' && !said) step.text.push([{ text: `Hearth to ${args}` }]);
		if (said && cmd !== 'target' && cmd !== 'mob' && cmd !== 'unitscan') step.text.push(segments(said));
	}
	if (!step.text.length && !step.goto.length && !step.accept.length && !step.turnin.length) return null;
	return step;
}

/** The level a guide starts at, from its name ("13-15 Westfall" is 13). */
const startLevel = (g: Guide) => Number(/^\d+/.exec(g.name)?.[0] ?? 99);

/** A character's guides of a group, one of each name, by the level they start at. */
export function guidesFor(guides: Guide[], who: Character, group = /Forever Guide/): Guide[] {
	const byName = new Map<string, Guide>();
	for (const g of guides) if (group.test(g.group) && holds(g.condition, who) && !byName.has(g.name)) byName.set(g.name, g);
	return [...byName.values()].sort((a, b) => startLevel(a) - startLevel(b));
}

/**
 * The route for a character: from a guide (by name), or else from where their race starts
 * (the guide that's #defaultfor them, or the lowest no other guide leads to), along each
 * guide's #next to the first that's theirs too, step by step.
 */
export function route(guides: Guide[], who: Character, from?: string, group = /Forever Guide/): { names: string[]; steps: RouteStep[] } {
	const mine = guidesFor(guides, who, group);
	const byName = new Map(mine.map((g) => [g.name, g]));
	const nextOf = (g: Guide) => g.next.find((n) => (!n.condition || holds(n.condition, who)) && byName.has(n.name));
	const led = new Set(mine.map((g) => nextOf(g)?.name));
	const starts = mine.filter((g) => !led.has(g.name));
	const names: string[] = [];
	const steps: RouteStep[] = [];
	let guide: Guide | undefined = (from ? byName.get(from) : undefined) ?? starts.find((g) => g.defaultFor && holds(g.defaultFor, who)) ?? starts[0] ?? mine[0];
	const seen = new Set<string>();
	while (guide && !seen.has(guide.name)) {
		seen.add(guide.name);
		names.push(guide.name);
		for (const raw of guide.steps) {
			const step = toStep(guide.name, raw, who);
			if (step) steps.push(step);
		}
		const next = nextOf(guide);
		guide = next && byName.get(next.name);
	}
	return { names, steps };
}

/**
 * Classic's zone maps (UiMap IDs) by the English names guides use, so a zone's map is found
 * whatever the language of the install.
 */
const ZONE_IDS: Record<string, number> = {
	durotar: 1411, mulgore: 1412, thebarrens: 1413, kalimdor: 1414, easternkingdoms: 1415, alteracmountains: 1416, arathihighlands: 1417,
	badlands: 1418, blastedlands: 1419, tirisfalglades: 1420, silverpineforest: 1421, westernplaguelands: 1422, easternplaguelands: 1423,
	hillsbradfoothills: 1424, thehinterlands: 1425, dunmorogh: 1426, searinggorge: 1427, burningsteppes: 1428, elwynnforest: 1429,
	deadwindpass: 1430, duskwood: 1431, lochmodan: 1432, redridgemountains: 1433, stranglethornvale: 1434, swampofsorrows: 1435,
	westfall: 1436, wetlands: 1437, teldrassil: 1438, darkshore: 1439, ashenvale: 1440, thousandneedles: 1441, stonetalonmountains: 1442,
	desolace: 1443, feralas: 1444, dustwallowmarsh: 1445, tanaris: 1446, azshara: 1447, felwood: 1448, ungorocrater: 1449, moonglade: 1450,
	silithus: 1451, winterspring: 1452, stormwind: 1453, stormwindcity: 1453, orgrimmar: 1454, ironforge: 1455, thunderbluff: 1456,
	darnassus: 1457, undercity: 1458,
};

/** A zone's UiMap ID by its English name ("Stormwind City", "StormwindClassic", "Un'Goro Crater"). */
export function zoneId(name: string): number | null {
	return ZONE_IDS[name.toLowerCase().replace(/classic$/, '').replace(/[^a-z]/g, '')] ?? null;
}

/** Race and class names as guides spell them, by ChrRaces and ChrClasses ID. */
export const GUIDE_RACES: Record<number, string> = { 1: 'Human', 2: 'Orc', 3: 'Dwarf', 4: 'NightElf', 5: 'Undead', 6: 'Tauren', 7: 'Gnome', 8: 'Troll', 9: 'Goblin', 10: 'BloodElf' };
export const GUIDE_CLASSES: Record<number, string> = { 1: 'Warrior', 2: 'Paladin', 3: 'Hunter', 4: 'Rogue', 5: 'Priest', 7: 'Shaman', 8: 'Mage', 9: 'Warlock', 11: 'Druid' };
