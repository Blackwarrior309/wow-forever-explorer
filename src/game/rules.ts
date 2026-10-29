/**
 * The numbers of Adventure mode, modelled on vanilla WoW but simplified: no gear, so health,
 * mana and damage come from level (and class); creatures use their VMaNGOS template.
 */

export type Side = 'alliance' | 'horde';
export const MAX_LEVEL = 60;

/** Orc, Undead, Tauren, Troll (and Blood Elf, Goblin) are Horde; the rest Alliance. */
const HORDE_RACES = new Set([2, 5, 6, 8, 9, 10]);
export const sideOf = (race: number): Side => (HORDE_RACES.has(race) ? 'horde' : 'alliance');
/** A race's bit in a quest's RequiredRaces mask. */
export const raceBit = (race: number): number => 1 << (race - 1);

/** Creature template ranks. */
export const RANK = { normal: 0, elite: 1, rareElite: 2, boss: 3, rare: 4 } as const;
export const isElite = (rank: number): boolean => rank === RANK.elite || rank === RANK.rareElite || rank === RANK.boss;

/** A melee swing's damage before abilities scale it: what a level's weapon does (avg), yards of nothing. */
export function weaponDamage(level: number): number {
	return 3 + 1.9 * level + 0.045 * level * level;
}

export function playerHealth(level: number, classScale = 1): number {
	return Math.round((40 + 18 * level + 0.9 * level * level) * classScale);
}

export function playerMana(level: number): number {
	return Math.round(60 + 22 * level + 0.8 * level * level);
}

/**
 * A creature's fighting numbers: [health min, max, damage min, max, attack ms, aggro range, rank]
 * from its template (creatures.json), else made up from its level.
 */
export interface MobStats {
	health: number;
	damage: [number, number];
	attackMs: number;
	aggro: number;
	rank: number;
}
export function mobStats(template: number[] | undefined, level: number, rank = 0): MobStats {
	if (template && template[1] > 0) {
		const [hMin, hMax, dMin, dMax, attackMs, aggro, r] = template;
		return {
			health: Math.round(hMin + (hMax - hMin) * Math.random()),
			damage: [Math.max(1, dMin), Math.max(1, dMax, dMin)],
			attackMs: attackMs || 2000,
			aggro: aggro || 20,
			rank: r,
		};
	}
	const health = Math.round((42 + 13 * (level - 1) + 0.9 * (level - 1) ** 2) * (isElite(rank) ? 3 : 1));
	const hit = 2 + 1.6 * level + 0.035 * level * level;
	return { health, damage: [Math.max(1, Math.round(hit * 0.8)), Math.round(hit * 1.2)], attackMs: 2000, aggro: 20, rank };
}

/** Level at and below which a creature gives no experience (vanilla's grey level). */
export function greyLevel(level: number): number {
	if (level <= 5) return 0;
	if (level <= 39) return level - Math.floor(level / 10) - 5;
	if (level <= 59) return level - Math.floor(level / 5) - 1;
	return level - 9;
}

function zeroDifference(level: number): number {
	const steps: [number, number][] = [[8, 5], [10, 6], [12, 7], [16, 8], [20, 9], [30, 11], [40, 12], [45, 13], [50, 14], [55, 15], [60, 16]];
	for (const [below, value] of steps) if (level < below) return value;
	return 17;
}

/** Experience for a kill, as vanilla works it out (no rested bonus, no group split). */
export function killXp(player: number, mob: number, elite: boolean): number {
	if (player >= MAX_LEVEL) return 0;
	const base = mob * 5 + 45;
	let xp: number;
	if (mob >= player) xp = base * (1 + 0.05 * Math.min(mob - player, 4));
	else if (mob <= greyLevel(player)) return 0;
	else xp = base * (1 - (player - mob) / zeroDifference(player));
	return Math.round(xp * (elite ? 2 : 1));
}

/** A quest's experience, less the more levels the player has over it. */
export function questXp(xp: number, questLevel: number, player: number): number {
	if (player >= MAX_LEVEL) return 0;
	const over = player - questLevel;
	const share = over <= 5 ? 1 : over === 6 ? 0.8 : over === 7 ? 0.6 : over === 8 ? 0.4 : over === 9 ? 0.2 : 0.1;
	return Math.round(xp * share);
}

/** Chance (0-1) for an attack to land on a target of another level. */
export function hitChance(attacker: number, defender: number): number {
	return Math.min(0.95, Math.max(0.6, 0.95 - 0.02 * Math.max(0, defender - attacker) + 0.01 * Math.max(0, attacker - defender)));
}

/** Copper as "1g 2s 3c". */
export function money(copper: number): string {
	const g = Math.floor(copper / 10000), s = Math.floor((copper % 10000) / 100), c = copper % 100;
	return [g && `${g}g`, s && `${s}s`, (c || (!g && !s)) && `${c}c`].filter(Boolean).join(' ');
}

/**
 * Level and experience after gaining some: xpTable[level - 1] is what the level needs to
 * reach the next (vanilla's, from the data).
 */
export function gainXp(level: number, xp: number, gained: number, xpTable: number[]): { level: number; xp: number; levels: number } {
	let levels = 0;
	xp += gained;
	while (level < MAX_LEVEL && xp >= (xpTable[level - 1] ?? Infinity)) {
		xp -= xpTable[level - 1];
		level++;
		levels++;
	}
	if (level >= MAX_LEVEL) xp = 0;
	return { level, xp, levels };
}
