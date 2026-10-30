import type { CascStorage } from '../casc/storage';
import { readSparseStrings, type Db2 } from '../formats/db2';
import { loadTable } from './clientDb';

/**
 * Talent trees and racial abilities as the install has them (Forever's own, new ones included):
 * names, icons and descriptions in the install's language, numbers filled in. Higher talent
 * ranks the install can't decrypt are told from the first rank, its numbers times the rank.
 */

const FILES = {
	Talent: 1369062,
	SpellName: 1990283,
	SpellMisc: 1003144,
	SpellEffect: 1140088,
	SkillLine: 1240935,
	SkillLineAbility: 1266278,
	Spell: 1140089,
	Item: 841626,
} as const;
/** Item.db2's icon file ID field. */
const ITEM_ICON = 7;

/** The talent tabs of each class (ChrClasses ID): Talent.db2 tab, its SkillLine (for the name) and background. */
const TABS: Record<number, [number, number, string][]> = {
	1: [[161, 26, 'WarriorArms'], [164, 256, 'WarriorFury'], [163, 257, 'WarriorProtection']],
	2: [[382, 594, 'PaladinHoly'], [383, 267, 'PaladinProtection'], [381, 184, 'PaladinCombat']],
	3: [[361, 50, 'HunterBeastMastery'], [363, 163, 'HunterMarksmanship'], [362, 51, 'HunterSurvival']],
	4: [[182, 253, 'RogueAssassination'], [181, 38, 'RogueCombat'], [183, 39, 'RogueSubtlety']],
	5: [[201, 613, 'PriestDiscipline'], [202, 56, 'PriestHoly'], [203, 78, 'PriestShadow']],
	7: [[261, 375, 'ShamanElementalCombat'], [263, 373, 'ShamanEnhancement'], [262, 374, 'ShamanRestoration']],
	8: [[81, 237, 'MageArcane'], [41, 8, 'MageFire'], [61, 6, 'MageFrost']],
	9: [[302, 355, 'WarlockCurses'], [303, 354, 'WarlockSummoning'], [301, 593, 'WarlockDestruction']],
	11: [[283, 574, 'DruidBalance'], [281, 134, 'DruidFeralCombat'], [282, 573, 'DruidRestoration']],
};

/** The racial SkillLine of each race (ChrRaces ID). */
const RACIAL_LINES: Record<number, number> = { 1: 754, 2: 125, 3: 101, 4: 126, 5: 220, 6: 124, 7: 753, 8: 733 };

/** SpellDuration.db2 by index, seconds (-1 lasts until cancelled): the table itself reads wrongly here. */
const DURATIONS: Record<number, number> = { 1: 10, 3: 60, 4: 120, 5: 300, 6: 600, 8: 15, 9: 30, 18: 20, 21: -1, 23: 90, 25: 180, 27: 3, 28: 5, 29: 12, 31: 8, 32: 6, 35: 4, 36: 1, 39: 2, 42: 3600, 62: 75, 63: 25, 64: 40, 85: 18, 86: 21, 105: 9, 106: 24, 205: 27, 225: 16 };
const PASSIVE = 0x40;

export interface SpellText {
	spell: number;
	name: string;
	/** Icon file ID; 0 for none. */
	icon: number;
	description: string;
	passive: boolean;
}

export interface TalentInfo {
	id: number;
	/** Row from the top and column from the left, from 0. */
	tier: number;
	column: number;
	name: string;
	icon: number;
	/** What each rank does. */
	ranks: string[];
	/** A talent that must have this many points first. */
	requires: { talent: number; rank: number } | null;
}

export interface TalentTree {
	id: number;
	name: string;
	/** Interface/TalentFrame picture name, e.g. "DruidBalance". */
	background: string;
	talents: TalentInfo[];
}

interface Tables {
	names: Db2;
	misc: Db2;
	effects: Map<number, number[]>;
	miscOf: Map<number, number>;
	text: Map<number, string[]>;
}

const cache = new WeakMap<CascStorage, Promise<Tables>>();

function tables(storage: CascStorage): Promise<Tables> {
	let t = cache.get(storage);
	if (!t) {
		t = (async () => {
			const [names, misc, effect, spell] = await Promise.all([
				loadTable(storage, FILES.SpellName),
				loadTable(storage, FILES.SpellMisc),
				loadTable(storage, FILES.SpellEffect),
				storage.readFileWithStatus(FILES.Spell, true),
			]);
			const miscOf = new Map<number, number>();
			for (const id of misc.ids()) {
				const spellId = misc.getParent(id);
				if (spellId && !miscOf.has(spellId)) miscOf.set(spellId, id);
			}
			const effects = new Map<number, number[]>();
			for (const id of effect.ids()) {
				const spellId = effect.getParent(id);
				if (!spellId) continue;
				const list = effects.get(spellId) ?? [];
				list[effect.getInt(id, 2) ?? 0] = effect.getFloat(id, 22) ?? 0;
				effects.set(spellId, list);
			}
			return { names, misc, effects, miscOf, text: readSparseStrings(spell.data) };
		})();
		cache.set(storage, t);
	}
	return t;
}

const number = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ''));

function duration(t: Tables, spell: number): string | null {
	const misc = t.miscOf.get(spell);
	const seconds = misc === undefined ? undefined : DURATIONS[t.misc.getInt(misc, 3) ?? 0];
	if (seconds === undefined || seconds < 0) return null;
	return seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} sec`;
}

/**
 * A spell's description with its numbers filled in: $s1 and the like from its effects (or a
 * fallback spell's times scale, where its own can't be read), durations, and grammar picks;
 * what can't be worked out shows as "…".
 */
export function describe(text: string, value: (spell: number, effect: number) => number | null, time: (spell: number) => string | null, self: number): string {
	return text
		.replace(/\r\n/g, '\n')
		// Text for a rune or season this game doesn't have, or else the usual: the usual.
		.replace(/\$\?[^[]*\[([^\]]*)\]\[([^\]]*)\]/g, '$2')
		.replace(/\$\?[^[]*\[([^\]]*)\]/g, '')
		.replace(/\$l([^:;]*):([^;]*);/g, '$2')
		.replace(/\$[gG]([^:;]*):([^;]*);/g, '$1')
		.replace(/\$\{[^}]*\}\.?\d*/g, '…')
		.replace(/\$\/(\d+);(\d*)[sSmMoO]([1-3])/g, (_, by: string, spell: string, e: string) => {
			const v = value(spell ? Number(spell) : self, Number(e) - 1);
			return v === null ? '…' : number(Math.abs(v) / Number(by));
		})
		.replace(/\$(\d*)[sSmMoOwW]([1-3])/g, (_, spell: string, e: string) => {
			const v = value(spell ? Number(spell) : self, Number(e) - 1);
			return v === null ? '…' : number(Math.abs(v));
		})
		.replace(/\$(\d*)[dD]/g, (_, spell: string) => time(spell ? Number(spell) : self) ?? '…')
		.replace(/\$\d*[a-zA-Z]\d?/g, '…');
}

function spellText(t: Tables, spell: number, fallback?: { spell: number; scale: number }): SpellText {
	const own = (s: number, e: number) => t.effects.get(s)?.[e] ?? null;
	const value = (s: number, e: number) => own(s, e) ?? (fallback && s === spell ? (own(fallback.spell, e) ?? NaN) * fallback.scale : null);
	const safe = (s: number, e: number) => {
		const v = value(s, e);
		return v === null || Number.isNaN(v) ? null : v;
	};
	const raw = t.text.get(spell)?.[1] || (fallback ? t.text.get(fallback.spell)?.[1] : '') || '';
	const misc = t.miscOf.get(spell) ?? (fallback && t.miscOf.get(fallback.spell));
	const name = t.names.getString(spell, 0) ?? (fallback ? t.names.getString(fallback.spell, 0) : null) ?? `Spell ${spell}`;
	return {
		spell,
		name,
		icon: misc === undefined ? 0 : (t.misc.getInt(misc, 10) ?? 0),
		description: describe(raw, safe, (s) => duration(t, s) ?? (fallback && s === spell ? duration(t, fallback.spell) : null), spell).trim(),
		passive: misc !== undefined && ((t.misc.getInt(misc, 0) ?? 0) & PASSIVE) !== 0,
	};
}

/** A class's three talent trees, left to right. */
export async function loadTalents(storage: CascStorage, classId: number): Promise<TalentTree[]> {
	const [t, talent, skill] = await Promise.all([tables(storage), loadTable(storage, FILES.Talent), loadTable(storage, FILES.SkillLine)]);
	const trees = (TABS[classId] ?? []).map(([tab, line, background]) => ({ id: tab, name: skill.getString(line, 0) ?? background, background, talents: [] as TalentInfo[] }));
	for (const id of talent.ids()) {
		const tree = trees.find((tr) => tr.id === talent.getInt(id, 4));
		if (!tree) continue;
		const spells = Array.from({ length: 9 }, (_, i) => talent.getInt(id, 11, i) ?? 0).filter(Boolean);
		if (!spells.length || !t.names.getString(spells[0], 0)) continue;
		const first = spellText(t, spells[0]);
		const prereq = talent.getInt(id, 12, 0) ?? 0;
		tree.talents.push({
			id,
			tier: talent.getInt(id, 1) ?? 0,
			column: talent.getInt(id, 3) ?? 0,
			name: first.name,
			icon: first.icon,
			ranks: spells.map((spell, i) => (i ? spellText(t, spell, { spell: spells[0], scale: i + 1 }).description : first.description)),
			requires: prereq ? { talent: prereq, rank: (talent.getInt(id, 13, 0) ?? 0) + 1 } : null,
		});
	}
	for (const tree of trees) {
		tree.talents.sort((a, b) => a.tier - b.tier || a.column - b.column);
		// A prerequisite asks for no more than its talent has.
		for (const tl of tree.talents) {
			const need = tl.requires && tree.talents.find((o) => o.id === tl.requires!.talent);
			if (tl.requires) tl.requires = need ? { talent: need.id, rank: Math.min(tl.requires.rank, need.ranks.length) } : null;
		}
	}
	return trees;
}

/** A race's racial abilities, for one class (some are only for some classes). */
export async function loadRacials(storage: CascStorage, race: number, classId: number): Promise<SpellText[]> {
	const line = RACIAL_LINES[race];
	if (!line) return [];
	const [t, abilities] = await Promise.all([tables(storage), loadTable(storage, FILES.SkillLineAbility)]);
	const out: SpellText[] = [];
	for (const id of abilities.ids()) {
		if (abilities.getInt(id, 3) !== line) continue;
		const classes = abilities.getInt(id, 6) ?? 0;
		if (classes && classes !== 0xffffffff && !(classes & (1 << (classId - 1)))) continue;
		const spell = abilities.getInt(id, 4) ?? 0;
		if (!spell || out.some((s) => s.spell === spell)) continue;
		const text = spellText(t, spell);
		// The same ability under another spell for another class or a hidden helper: one of each name.
		if (out.some((s) => s.name === text.name || (!text.description && s.icon === text.icon))) continue;
		out.push(text);
	}
	return out;
}

/** Items' icon file IDs (0 for an item the install hasn't). */
export async function loadItemIcons(storage: CascStorage, ids: number[]): Promise<number[]> {
	const items = await loadTable(storage, FILES.Item);
	return ids.map((id) => items.getInt(id, ITEM_ICON) ?? 0);
}
