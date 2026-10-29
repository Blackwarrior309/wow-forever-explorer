/**
 * The classes of Adventure mode and their abilities: a handful each, unlocked by level, with
 * numbers of our own (vanilla-like, simplified). Icons are paths in the player's own install.
 */

export type Resource = 'rage' | 'energy' | 'mana';

export interface Ability {
	id: string;
	name: string;
	/** Interface/Icons file, without extension. */
	icon: string;
	level: number;
	/** 'melee' needs the target within reach, 'ranged' within range yards, 'self' no target. */
	kind: 'melee' | 'ranged' | 'self';
	range?: number;
	/** Rage or energy points, or a share of maximum mana. */
	cost: number;
	/** Seconds. */
	cooldown?: number;
	cast?: number;
	/** Hits everything hostile fighting within this many yards of the player instead of the target. */
	aoe?: number;
	/** Direct damage, as multiples of a weapon swing at the player's level. */
	damage?: number;
	/** Damage over time: total multiple of a swing, over seconds. */
	dot?: { total: number; duration: number };
	/** Healing as a share of maximum health, at once or over seconds. */
	heal?: number;
	hot?: { total: number; duration: number };
	/** Absorbs damage up to a share of maximum health. */
	shield?: number;
	/** The target can't move or attack for seconds. */
	stun?: number;
	/** More damage dealt (share) for seconds. */
	buff?: { damage: number; duration: number };
	/** Heals the player by the damage it deals. */
	drain?: boolean;
	/** Usable only on a target below this share of health. */
	execute?: number;
}

export interface ClassInfo {
	id: number;
	name: string;
	resource: Resource;
	/** Health relative to the average class. */
	health: number;
	abilities: Ability[];
}

const melee = (a: Omit<Ability, 'kind'>): Ability => ({ kind: 'melee', ...a });
const ranged = (a: Omit<Ability, 'kind'>, range = 30): Ability => ({ kind: 'ranged', range, ...a });
const self = (a: Omit<Ability, 'kind'>): Ability => ({ kind: 'self', ...a });

/** By ChrClasses ID. */
export const CLASSES: ClassInfo[] = [
	{ id: 1, name: 'Warrior', resource: 'rage', health: 1.15, abilities: [
		melee({ id: 'heroic-strike', name: 'Heroic Strike', icon: 'ability_rogue_ambush', level: 1, cost: 15, damage: 1.5 }),
		self({ id: 'battle-shout', name: 'Battle Shout', icon: 'ability_warrior_battleshout', level: 1, cost: 10, buff: { damage: 0.15, duration: 120 } }),
		melee({ id: 'rend', name: 'Rend', icon: 'ability_gouge', level: 4, cost: 10, dot: { total: 1.8, duration: 9 } }),
		self({ id: 'thunder-clap', name: 'Thunder Clap', icon: 'spell_nature_thunderclap', level: 6, cost: 20, cooldown: 4, aoe: 8, damage: 0.9 }),
		melee({ id: 'shield-bash', name: 'Shield Bash', icon: 'ability_warrior_shieldbash', level: 12, cost: 10, cooldown: 12, damage: 0.4, stun: 3 }),
		melee({ id: 'execute', name: 'Execute', icon: 'inv_sword_48', level: 24, cost: 15, damage: 3.2, execute: 0.2 }),
	] },
	{ id: 2, name: 'Paladin', resource: 'mana', health: 1.1, abilities: [
		self({ id: 'seal', name: 'Seal of Righteousness', icon: 'ability_thunderbolt', level: 1, cost: 0.04, buff: { damage: 0.25, duration: 30 } }),
		self({ id: 'holy-light', name: 'Holy Light', icon: 'spell_holy_holybolt', level: 1, cost: 0.12, cast: 2.5, heal: 0.4 }),
		ranged({ id: 'judgement', name: 'Judgement', icon: 'spell_holy_righteousfury', level: 4, cost: 0.05, cooldown: 8, damage: 1.8 }, 10),
		self({ id: 'divine-protection', name: 'Divine Protection', icon: 'spell_holy_restoration', level: 6, cost: 0.08, cooldown: 60, shield: 0.5 }),
		ranged({ id: 'hammer', name: 'Hammer of Justice', icon: 'spell_holy_sealofmight', level: 8, cost: 0.05, cooldown: 30, stun: 5 }, 10),
		self({ id: 'consecration', name: 'Consecration', icon: 'spell_holy_innerfire', level: 20, cost: 0.12, cooldown: 8, aoe: 8, damage: 1.3 }),
	] },
	{ id: 3, name: 'Hunter', resource: 'mana', health: 1, abilities: [
		melee({ id: 'raptor-strike', name: 'Raptor Strike', icon: 'ability_meleedamage', level: 1, cost: 0.03, cooldown: 6, damage: 1.6 }),
		ranged({ id: 'serpent-sting', name: 'Serpent Sting', icon: 'ability_hunter_quickshot', level: 4, cost: 0.05, dot: { total: 2.2, duration: 15 } }),
		ranged({ id: 'arcane-shot', name: 'Arcane Shot', icon: 'ability_impalingbolt', level: 6, cost: 0.05, cooldown: 6, damage: 1.7 }),
		ranged({ id: 'concussive-shot', name: 'Concussive Shot', icon: 'spell_frost_stun', level: 8, cost: 0.05, cooldown: 12, stun: 2 }),
		ranged({ id: 'aimed-shot', name: 'Aimed Shot', icon: 'inv_spear_07', level: 20, cost: 0.08, cooldown: 6, cast: 3, damage: 3.4 }),
	] },
	{ id: 4, name: 'Rogue', resource: 'energy', health: 1, abilities: [
		melee({ id: 'sinister-strike', name: 'Sinister Strike', icon: 'spell_shadow_ritualofsacrifice', level: 1, cost: 45, damage: 1.6 }),
		melee({ id: 'eviscerate', name: 'Eviscerate', icon: 'ability_rogue_eviscerate', level: 1, cost: 35, cooldown: 5, damage: 2.3 }),
		melee({ id: 'gouge', name: 'Gouge', icon: 'ability_gouge', level: 6, cost: 45, cooldown: 10, damage: 0.3, stun: 4 }),
		self({ id: 'slice-and-dice', name: 'Slice and Dice', icon: 'ability_rogue_slicedice', level: 10, cost: 25, buff: { damage: 0.2, duration: 30 } }),
		melee({ id: 'rupture', name: 'Rupture', icon: 'ability_rogue_rupture', level: 20, cost: 25, dot: { total: 2.8, duration: 12 } }),
	] },
	{ id: 5, name: 'Priest', resource: 'mana', health: 0.85, abilities: [
		ranged({ id: 'smite', name: 'Smite', icon: 'spell_holy_holysmite', level: 1, cost: 0.06, cast: 2, damage: 2.1 }),
		self({ id: 'lesser-heal', name: 'Lesser Heal', icon: 'spell_holy_lesserheal', level: 1, cost: 0.1, cast: 2.5, heal: 0.4 }),
		ranged({ id: 'shadow-word-pain', name: 'Shadow Word: Pain', icon: 'spell_shadow_shadowwordpain', level: 4, cost: 0.06, dot: { total: 2.4, duration: 18 } }),
		self({ id: 'shield', name: 'Power Word: Shield', icon: 'spell_holy_powerwordshield', level: 6, cost: 0.1, cooldown: 15, shield: 0.35 }),
		self({ id: 'renew', name: 'Renew', icon: 'spell_holy_renew', level: 8, cost: 0.08, hot: { total: 0.45, duration: 15 } }),
		ranged({ id: 'mind-blast', name: 'Mind Blast', icon: 'spell_shadow_unholyfrenzy', level: 10, cost: 0.08, cooldown: 8, cast: 1.5, damage: 2.7 }),
	] },
	{ id: 7, name: 'Shaman', resource: 'mana', health: 1, abilities: [
		ranged({ id: 'lightning-bolt', name: 'Lightning Bolt', icon: 'spell_nature_lightning', level: 1, cost: 0.06, cast: 2, damage: 2.2 }),
		self({ id: 'healing-wave', name: 'Healing Wave', icon: 'spell_nature_magicimmunity', level: 1, cost: 0.1, cast: 2.5, heal: 0.4 }),
		ranged({ id: 'earth-shock', name: 'Earth Shock', icon: 'spell_nature_earthshock', level: 4, cost: 0.06, cooldown: 6, damage: 1.7 }, 20),
		self({ id: 'lightning-shield', name: 'Lightning Shield', icon: 'spell_nature_lightningshield', level: 8, cost: 0.08, cooldown: 30, shield: 0.25 }),
		ranged({ id: 'flame-shock', name: 'Flame Shock', icon: 'spell_fire_flameshock', level: 10, cost: 0.07, cooldown: 6, damage: 0.8, dot: { total: 1.4, duration: 12 } }, 20),
	] },
	{ id: 8, name: 'Mage', resource: 'mana', health: 0.85, abilities: [
		ranged({ id: 'fireball', name: 'Fireball', icon: 'spell_fire_flamebolt', level: 1, cost: 0.07, cast: 2, damage: 2.5 }, 35),
		ranged({ id: 'frostbolt', name: 'Frostbolt', icon: 'spell_frost_frostbolt02', level: 4, cost: 0.06, cast: 1.8, damage: 2.1 }),
		ranged({ id: 'fire-blast', name: 'Fire Blast', icon: 'spell_fire_fireball', level: 6, cost: 0.07, cooldown: 8, damage: 1.7 }, 20),
		self({ id: 'frost-nova', name: 'Frost Nova', icon: 'spell_frost_frostnova', level: 10, cost: 0.07, cooldown: 25, aoe: 10, damage: 0.3, stun: 6 }),
		self({ id: 'arcane-explosion', name: 'Arcane Explosion', icon: 'spell_nature_wispsplode', level: 14, cost: 0.1, aoe: 10, damage: 1 }),
	] },
	{ id: 9, name: 'Warlock', resource: 'mana', health: 0.9, abilities: [
		ranged({ id: 'shadow-bolt', name: 'Shadow Bolt', icon: 'spell_shadow_shadowbolt', level: 1, cost: 0.07, cast: 2.5, damage: 2.6 }),
		ranged({ id: 'immolate', name: 'Immolate', icon: 'spell_fire_immolation', level: 1, cost: 0.07, cast: 2, damage: 1, dot: { total: 1.4, duration: 15 } }),
		ranged({ id: 'corruption', name: 'Corruption', icon: 'spell_shadow_abominationexplosion', level: 4, cost: 0.06, dot: { total: 2.4, duration: 12 } }),
		ranged({ id: 'fear', name: 'Fear', icon: 'spell_shadow_possession', level: 8, cost: 0.06, cooldown: 20, cast: 1.5, stun: 6 }, 20),
		ranged({ id: 'drain-life', name: 'Drain Life', icon: 'spell_shadow_lifedrain02', level: 14, cost: 0.08, cooldown: 6, damage: 1.6, drain: true }, 20),
	] },
	{ id: 11, name: 'Druid', resource: 'mana', health: 1, abilities: [
		ranged({ id: 'wrath', name: 'Wrath', icon: 'spell_nature_abolishmagic', level: 1, cost: 0.06, cast: 1.8, damage: 2 }),
		self({ id: 'healing-touch', name: 'Healing Touch', icon: 'spell_nature_healingtouch', level: 1, cost: 0.1, cast: 2.5, heal: 0.4 }),
		ranged({ id: 'moonfire', name: 'Moonfire', icon: 'spell_nature_starfall', level: 4, cost: 0.06, damage: 0.8, dot: { total: 1.2, duration: 9 } }),
		self({ id: 'rejuvenation', name: 'Rejuvenation', icon: 'spell_nature_rejuvenation', level: 4, cost: 0.08, hot: { total: 0.45, duration: 12 } }),
		ranged({ id: 'roots', name: 'Entangling Roots', icon: 'spell_nature_stranglevines', level: 8, cost: 0.07, cooldown: 15, cast: 1.5, stun: 6 }),
	] },
];

export const classById = (id: number): ClassInfo => CLASSES.find((c) => c.id === id) ?? CLASSES[0];

/** Melee reach (yards) beyond the two bodies' radii. */
export const MELEE_RANGE = 2.5;
/** The global cooldown after an ability, seconds. */
export const GLOBAL_COOLDOWN = 1.5;
/** Seconds between a player's automatic melee swings. */
export const SWING_TIME = 2;
