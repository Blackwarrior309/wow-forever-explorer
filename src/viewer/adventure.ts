import * as THREE from 'three';
import type { SpawnInfo } from '../explorer/spawns';
import { classById, GLOBAL_COOLDOWN, MELEE_RANGE, SWING_TIME, type Ability, type ClassInfo } from '../game/classes';
import { QuestBook, type Giver, type Marker, type QuestData, type QuestSave } from '../game/quests';
import { gainXp, hitChance, isElite, killXp, mobStats, playerHealth, playerMana, questXp, sideOf, weaponDamage, type MobStats } from '../game/rules';
import type { Character } from './character';
import { ACTIONS, type Emote } from './emotes';
import type { CombatEvent, MobState } from './multiplayer';
import type { Plate } from './nameplates';
import type { ObjectManager } from './objects';
import { PuppetWalker, type RemotePlayers } from './remotePlayers';
import type { WalkControls } from './walkControls';

/**
 * Adventure mode: fighting creatures and doing quests on foot. The player's character fights
 * with auto-attack and its class's abilities; a creature it fights is taken out of its instanced
 * crowd and drawn on its own, fully animated (attacks, death), and run by a simple AI: chase,
 * hit, give up and go home if pulled too far. Together, each mob is run by whoever pulled it
 * and the others send it their hits (see multiplayer.ts).
 */

/** Seconds a dead creature lies there, and until it's back where it stood. */
const CORPSE_TIME = 20;
const RESPAWN_TIME = 45;
/** A creature dragged further than this from home (yards) gives up and walks back. */
const LEASH = 60;
const MOB_RUN = 7;
const MOB_EVADE_SPEED = 12;
/** Seconds after the last blow before health and mana come back quickly. */
const OUT_OF_COMBAT = 5;
const DOT_TICK = 3;
const CRIT_CHANCE = 0.05;
/** How near (yards) to talk to a quest giver or use an object. */
const INTERACT_RANGE = 6;
/** Furthest a target can be picked with Tab. */
const TAB_RANGE = 40;
/** How often mobs near the player are checked for noticing it (s), and furthest that matters. */
const AGGRO_EVERY = 0.25;
const AGGRO_MAX = 45;
/** Seconds between reports of the mobs we run. */
const MOB_REPORT = 0.2;
/** Floating numbers rise for this long (s). */
const FLOAT_TIME = 1.4;

export interface AdventureWorld {
	scene: THREE.Scene;
	walker: WalkControls;
	/** The player's drawn character (null before the world loads). */
	character: () => Character | null;
	objects: ObjectManager;
	remotePlayers: RemotePlayers;
	createCharacter: () => Character;
	/** Ground or floor height under a point, near a height (NaN where there's none). */
	floorAt: (x: number, z: number, near: number) => number;
	/** The player's race (for its side and quests). */
	race: () => number;
	female: () => boolean;
}

/** How the page talks to the others in the room (see main.ts); null alone. */
export interface AdventureNet {
	me: string;
	sendEvent(event: CombatEvent): void;
	sendMobs(mobs: MobState[]): void;
}

interface Dot {
	key: string;
	perTick: number;
	ticks: number;
	next: number;
}

interface Hot {
	perTick: number;
	ticks: number;
	next: number;
}

interface Mob {
	key: string;
	info: SpawnInfo;
	level: number;
	stats: MobStats;
	hp: number;
	maxHp: number;
	/** 'me', or the ID of the player running it. */
	owner: string;
	character: Character;
	walker: PuppetWalker;
	home: THREE.Vector3;
	height: number;
	state: 'combat' | 'evade' | 'dead';
	/** Who it's fighting: 'me', a player ID, or ''. */
	target: string;
	threat: Map<string, number>;
	swing: number;
	swings: number;
	stunUntil: number;
	diedAt: number;
	plate: Plate;
	/** For mobs others run: where they last reported it. */
	reported: THREE.Vector3;
	reportedFacing: number;
}

export interface FloatText {
	at: THREE.Vector3;
	text: string;
	color: string;
	age: number;
}

/** What's kept between visits. */
interface Saved {
	cls: number;
	level: number;
	xp: number;
	money: number;
	quests: QuestSave;
}

const SAVE_KEY = 'mapExplorer.adventure';
/** SpawnInfo.rank by template rank (see spawns.ts). */
const RANK_NAMES = ['', 'Elite', 'Rare Elite', 'Boss', 'Rare'];

const random = (a: number, b: number) => a + Math.random() * (b - a);

/** A spawn's level ("5", "5-6", "??"): within its range. */
function spawnLevel(info: SpawnInfo): number {
	const n = (info.level ?? '').match(/\d+/g)?.map(Number) ?? [];
	if (!n.length) return 63;
	return Math.round(random(n[0], n[n.length - 1]));
}

const facingOf = (m: THREE.Matrix4) => Math.atan2(-m.elements[0], -m.elements[2]);
const flatDistance = (a: THREE.Vector3, b: THREE.Vector3) => Math.hypot(a.x - b.x, a.z - b.z);

export class Adventure {
	enabled = false;
	cls: ClassInfo = classById(1);
	level = 1;
	xp = 0;
	money = 0;
	hp = 1;
	power = 0;
	shield = 0;
	alive = true;
	/** The target: a creature spawn's instance key. */
	target: string | null = null;
	autoAttack = false;
	cast: { ability: Ability; target: string | null; start: number; end: number } | null = null;
	quests: QuestBook | null = null;
	creatures: Record<number, number[]> = {};
	readonly floats: FloatText[] = [];
	readonly mobs = new Map<string, Mob>();
	net: AdventureNet | null = null;
	name = 'Adventurer';

	/** Things to tell the player: errors in red, the rest in yellow. */
	onMessage: (text: string, error?: boolean) => void = () => {};
	/** A quest giver or object was clicked near enough to talk to. */
	onTalk: (kind: Giver, entry: number, name: string) => void = () => {};
	/** Level, experience, money or the quest log changed. */
	onChange: () => void = () => {};

	private now = 0;
	private swingTimer = 0;
	private gcdUntil = 0;
	private readonly cooldowns = new Map<string, number>();
	private combatUntil = -Infinity;
	private buff = { damage: 0, until: 0 };
	private readonly dots: Dot[] = [];
	private readonly hots: Hot[] = [];
	private aggroTimer = 0;
	private reportTimer = 0;
	private loading: Promise<void> | null = null;
	private hadMobs = false;

	constructor(private readonly world: AdventureWorld) {
		this.load();
	}

	/** Loads the game data once (creature stats, quests); resolves when ready. */
	ready(): Promise<void> {
		this.loading ??= (async () => {
			const [creatures, quests] = await Promise.all([
				fetch(new URL('game/creatures.json', document.baseURI)).then((r) => r.json() as Promise<Record<number, number[]>>),
				fetch(new URL('game/quests.json', document.baseURI)).then((r) => r.json() as Promise<QuestData>),
			]);
			this.creatures = creatures;
			this.quests = new QuestBook(quests, this.saved?.quests);
			this.onChange();
		})();
		return this.loading;
	}

	get maxHp(): number {
		return playerHealth(this.level, this.cls.health);
	}

	get maxPower(): number {
		return this.cls.resource === 'mana' ? playerMana(this.level) : 100;
	}

	get xpNeeded(): number {
		return this.quests?.data.xp[this.level - 1] ?? 0;
	}

	/** Seconds since Adventure mode began ticking: the clock casts and cooldowns run on. */
	get time(): number {
		return this.now;
	}

	get inCombat(): boolean {
		return this.now < this.combatUntil;
	}

	/** Abilities the class has, with whether the level is high enough yet. */
	get abilities(): Ability[] {
		return this.cls.abilities;
	}

	cooldownLeft(ability: Ability): number {
		return Math.max(0, (this.cooldowns.get(ability.id) ?? 0) - this.now, this.gcdUntil - this.now);
	}

	// --- Saving ---------------------------------------------------------------------------------

	private saved: Saved | null = null;

	private load(): void {
		try {
			this.saved = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null') as Saved | null;
		} catch {
			this.saved = null;
		}
		const s = this.saved;
		if (s) {
			this.cls = classById(s.cls);
			this.level = Math.min(60, Math.max(1, Math.round(s.level) || 1));
			this.xp = Math.max(0, s.xp || 0);
			this.money = Math.max(0, s.money || 0);
		}
		this.hp = this.maxHp;
		this.power = this.cls.resource === 'rage' ? 0 : this.maxPower;
	}

	save(): void {
		const s: Saved = { cls: this.cls.id, level: this.level, xp: this.xp, money: this.money, quests: this.quests?.snapshot() ?? this.saved?.quests ?? { active: [], done: [], bag: {} } };
		this.saved = s;
		try {
			localStorage.setItem(SAVE_KEY, JSON.stringify(s));
		} catch {
			// Not kept; it still plays on for this visit.
		}
	}

	/** Changes class (starting over at level 1 with no quests) or starts a fresh character. */
	newCharacter(cls: number): void {
		this.reset();
		this.cls = classById(cls);
		this.level = 1;
		this.xp = 0;
		this.money = 0;
		this.hp = this.maxHp;
		this.power = this.cls.resource === 'rage' ? 0 : this.maxPower;
		if (this.quests) this.quests = new QuestBook(this.quests.data);
		this.saved = null;
		this.save();
		this.onChange();
	}

	/** Turns Adventure mode on or off; off, every fight ends. */
	setEnabled(on: boolean): void {
		if (on === this.enabled) return;
		this.enabled = on;
		if (!on) this.reset();
		else void this.ready();
		this.onChange();
	}

	private reset(): void {
		for (const mob of [...this.mobs.values()]) this.dropMob(mob);
		this.target = null;
		this.autoAttack = false;
		this.cast = null;
		this.dots.length = this.hots.length = 0;
		if (!this.alive) this.release();
	}

	// --- Targets ---------------------------------------------------------------------------------

	/** What the side of the player thinks of a creature. */
	private reaction(info: SpawnInfo): 'hostile' | 'neutral' | 'friendly' {
		return info.reaction?.[sideOf(this.world.race())] ?? 'neutral';
	}

	attackable(info: SpawnInfo): boolean {
		return info.type === 'npc' && this.reaction(info) !== 'friendly';
	}

	/** A target's spawn info, place, health and level, engaged or not; null once it's gone. */
	targetInfo(key = this.target): { info: SpawnInfo; position: THREE.Vector3; hp: number; maxHp: number; level: string; dead: boolean; height: number } | null {
		if (!key) return null;
		const mob = this.mobs.get(key);
		if (mob) return { info: mob.info, position: mob.walker.position, hp: mob.hp, maxHp: mob.maxHp, level: String(mob.level), dead: mob.state === 'dead', height: mob.height };
		const c = this.world.objects.creature(key);
		if (!c) return null;
		return { info: c.info, position: new THREE.Vector3().setFromMatrixPosition(c.matrix), hp: 1, maxHp: 1, level: c.info.level ?? '', dead: false, height: c.height };
	}

	setTarget(key: string | null): void {
		if (key !== this.target) this.autoAttack = false;
		this.target = key;
	}

	/** Fighting creatures have left the instanced crowd; keep them selectable at their drawn position. */
	pick(raycaster: THREE.Raycaster): { info: SpawnInfo; key: string; distance: number } | null {
		let best: { info: SpawnInfo; key: string; distance: number } | null = null;
		for (const mob of this.mobs.values()) {
			if (!mob.character.group.visible || mob.state === 'dead') continue;
			const center = mob.walker.position.clone().add(new THREE.Vector3(0, mob.height / 2, 0));
			const point = raycaster.ray.intersectSphere(new THREE.Sphere(center, Math.max(0.5, mob.height * 0.45)), new THREE.Vector3());
			if (!point) continue;
			const distance = point.distanceTo(raycaster.ray.origin);
			if (distance >= raycaster.near && distance <= raycaster.far && (!best || distance < best.distance)) best = { info: mob.info, key: mob.key, distance };
		}
		return best;
	}

	/** Tab: the nearest living creature that can be fought, after the one targeted now. */
	tabTarget(): void {
		const me = this.world.walker.position;
		const near = this.world.objects.creaturesNear(me, TAB_RANGE).filter((c) => this.attackable(c.info)).map((c) => ({ key: c.key, distance: c.distance }));
		for (const m of this.mobs.values()) if (m.state === 'combat') near.push({ key: m.key, distance: m.walker.position.distanceTo(me) });
		near.sort((a, b) => a.distance - b.distance);
		if (!near.length) return;
		const i = near.findIndex((n) => n.key === this.target);
		this.setTarget(near[(i + 1) % near.length].key);
	}

	/**
	 * A click on a spawn while walking in Adventure mode: targets creatures, talks to quest givers
	 * near enough, uses objects quests need. False when it's for the usual info panel instead.
	 */
	click(hit: { info: SpawnInfo; key: string }): boolean {
		if (!this.enabled || !this.world.walker.active) return false;
		const { info, key } = hit;
		const kind: Giver = info.type === 'npc' ? 'c' : 'o';
		const player = this.player;
		// shortcut: game objects aren't checked for distance; clicking one from afar works.
		const at = info.type === 'npc' ? this.targetInfo(key)?.position : null;
		const near = (p: THREE.Vector3 | null | undefined) => !p || p.distanceTo(this.world.walker.position) <= INTERACT_RANGE + 2;
		if (info.type === 'npc') {
			if (this.attackable(info)) {
				// A second click on the target attacks it.
				if (this.target === key) this.startAttack();
				else this.setTarget(key);
				return true;
			}
			this.setTarget(key);
			if (this.quests?.hasBusiness(kind, info.entry, player)) {
				if (!near(at)) this.onMessage('You are too far away', true);
				else this.onTalk(kind, info.entry, info.name);
				return true;
			}
			return false;
		}
		// Game objects: quest givers, or holding something a quest needs.
		if (!this.quests || !this.alive) return false;
		if (this.quests.hasBusiness('o', info.entry, player)) {
			this.onTalk('o', info.entry, info.name);
			return true;
		}
		if (this.quests.useful(info.entry)) {
			for (const line of this.quests.used(info.entry)) this.onMessage(line);
			this.save();
			this.onChange();
			return true;
		}
		return false;
	}

	get player(): { level: number; race: number } {
		return { level: this.level, race: this.world.race() };
	}

	/** The quest marker over a creature, for its nameplate. */
	marker(info: SpawnInfo): Marker {
		if (!this.enabled || !this.quests || info.type !== 'npc') return null;
		return this.quests.marker('c', info.entry, this.player);
	}

	// --- Fighting --------------------------------------------------------------------------------

	private reach(height: number): number {
		return MELEE_RANGE + 0.4 + height * 0.2;
	}

	startAttack(): void {
		const t = this.targetInfo();
		if (!t || t.dead || !this.attackable(t.info)) return this.onMessage('You have no target', true);
		if (!this.alive) return;
		this.autoAttack = true;
		this.engage(this.target!);
	}

	toggleAttack(): void {
		if (this.autoAttack) this.autoAttack = false;
		else this.startAttack();
	}

	/** Uses the ability in a slot (0 is Attack). */
	use(slot: number): void {
		if (!this.enabled || !this.alive) return;
		if (slot === 0) return this.toggleAttack();
		const ability = this.cls.abilities[slot - 1];
		if (!ability) return;
		const why = this.cannotUse(ability);
		if (why) return this.onMessage(why, true);
		if (ability.cast) {
			this.cast = { ability, target: this.target, start: this.now, end: this.now + ability.cast };
			this.act(ACTIONS.precast);
			this.gcdUntil = this.now + GLOBAL_COOLDOWN;
			return;
		}
		this.resolve(ability, this.target);
	}

	private cannotUse(a: Ability): string | null {
		if (!this.world.walker.active) return 'Walk on the ground first';
		if (a.level > this.level) return `Requires level ${a.level}`;
		if (this.cast) return 'Another action is in progress';
		if (this.now < this.gcdUntil || (this.cooldowns.get(a.id) ?? 0) > this.now) return 'Not ready yet';
		if (this.power < this.cost(a)) return `Not enough ${this.cls.resource}`;
		if (a.cast && this.moving) return 'You can’t do that while moving';
		if (a.kind === 'self') {
			if (a.aoe && !this.aoeTargets(a.aoe).length) return 'No enemies near';
			return null;
		}
		const t = this.targetInfo();
		if (!t) return 'You have no target';
		if (t.dead) return 'Your target is dead';
		if (!this.attackable(t.info)) return 'Invalid target';
		const distance = flatDistance(t.position, this.world.walker.position);
		if (a.kind === 'melee' && distance > this.reach(t.height)) return 'Out of range';
		if (a.kind === 'ranged' && distance > (a.range ?? 30)) return 'Out of range';
		if (a.execute && t.hp / t.maxHp > a.execute) return 'Your target must be below 20% health';
		return null;
	}

	private cost(a: Ability): number {
		return this.cls.resource === 'mana' ? Math.round(a.cost * this.maxPower) : a.cost;
	}

	private get moving(): boolean {
		const w = this.world.walker;
		return w.intent.x !== 0 || w.intent.y !== 0 || w.state !== 'ground';
	}

	/** Living hostile creatures fighting within range of the player (and those standing there, pulled by it). */
	private aoeTargets(range: number): string[] {
		const me = this.world.walker.position;
		const keys = new Set<string>();
		for (const m of this.mobs.values()) if (m.state === 'combat' && m.walker.position.distanceTo(me) <= range) keys.add(m.key);
		for (const c of this.world.objects.creaturesNear(me, range)) if (this.reaction(c.info) === 'hostile') keys.add(c.key);
		return [...keys];
	}

	/** The ability's effect, now its cast (if any) is done. */
	private resolve(a: Ability, target: string | null): void {
		this.power -= this.cost(a);
		this.gcdUntil = Math.max(this.gcdUntil, this.now + (this.cls.resource === 'energy' ? 1 : GLOBAL_COOLDOWN));
		if (a.cooldown) this.cooldowns.set(a.id, this.now + a.cooldown);
		this.act(...(a.kind === 'melee' ? ACTIONS.attack : [ACTIONS.cast]));
		const swing = weaponDamage(this.level) * (1 + (this.now < this.buff.until ? this.buff.damage : 0));
		const targets = a.aoe ? this.aoeTargets(a.aoe) : a.kind === 'self' ? [] : target ? [target] : [];
		for (const key of targets) {
			const mob = this.engage(key);
			if (!mob) continue;
			const level = mob.level;
			if (a.damage) {
				if (Math.random() > hitChance(this.level, level)) {
					this.float(mob.walker.position, mob.height, 'Miss', '#ffffff');
				} else {
					const crit = Math.random() < CRIT_CHANCE;
					const amount = Math.max(1, Math.round(swing * a.damage * random(0.9, 1.1) * (crit ? 1.5 : 1)));
					this.hitMob(mob, amount, a.stun ?? 0, crit);
					if (a.drain) this.heal(amount);
				}
			} else if (a.stun) {
				this.hitMob(mob, 0, a.stun, false);
			}
			if (a.dot) {
				const ticks = Math.max(1, Math.round(a.dot.duration / DOT_TICK));
				const existing = this.dots.findIndex((d) => d.key === key && d.perTick > 0);
				if (existing >= 0) this.dots.splice(existing, 1);
				this.dots.push({ key, perTick: Math.max(1, Math.round((swing * a.dot.total) / ticks)), ticks, next: this.now + DOT_TICK });
			}
		}
		if (a.heal) this.heal(Math.round(this.maxHp * a.heal * random(0.95, 1.05)));
		if (a.hot) {
			const ticks = Math.max(1, Math.round(a.hot.duration / DOT_TICK));
			this.hots.push({ perTick: Math.round((this.maxHp * a.hot.total) / ticks), ticks, next: this.now + DOT_TICK });
		}
		if (a.shield) this.shield = Math.max(this.shield, Math.round(this.maxHp * a.shield));
		if (a.buff) this.buff = { damage: a.buff.damage, until: this.now + a.buff.duration };
		if (a.kind === 'melee') this.autoAttack = true;
		if (targets.length) this.combatUntil = this.now + OUT_OF_COMBAT;
	}

	private heal(amount: number): void {
		const before = this.hp;
		this.hp = Math.min(this.maxHp, this.hp + amount);
		if (this.hp > before) this.float(this.world.walker.position, 2, `+${this.hp - before}`, '#40ff40');
	}

	private act(...emotes: Emote[]): void {
		this.world.character()?.act(...emotes);
	}

	/** Damage (and a stun) dealt to a mob by the player: applied if we run it, else sent to who does. */
	private hitMob(mob: Mob, amount: number, stun: number, crit: boolean): void {
		if (amount) this.float(mob.walker.position, mob.height, String(amount), crit ? '#ffff00' : '#ffffff');
		if (this.cls.resource === 'rage' && amount) this.power = Math.min(100, this.power + 6);
		if (mob.owner === 'me') this.damageMob(mob, amount, 'me', stun);
		else {
			// Shown at once; the owner's next report sets it right.
			mob.hp = Math.max(0, mob.hp - amount);
			this.net?.sendEvent({ t: 'hit', k: mob.key, a: amount, s: stun });
		}
	}

	/** A mob we run takes damage from someone. */
	private damageMob(mob: Mob, amount: number, from: string, stun: number): void {
		if (mob.state !== 'combat') return;
		mob.threat.set(from, (mob.threat.get(from) ?? 0) + amount + 1);
		if (stun) mob.stunUntil = Math.max(mob.stunUntil, this.now + stun);
		mob.hp = Math.max(0, mob.hp - amount);
		if (mob.hp <= 0) this.mobDied(mob);
		else if (amount && Math.random() < 0.3) mob.character.act(ACTIONS.wound);
	}

	/**
	 * Starts fighting a creature spawn (if not already): it's taken out of the crowd and drawn on
	 * its own. Returns the mob, or null for one that can't be fought.
	 */
	private engage(key: string, owner = 'me'): Mob | null {
		const existing = this.mobs.get(key);
		if (existing) return existing.state === 'dead' ? null : existing;
		const c = this.world.objects.creature(key);
		if (!c || !this.attackable(c.info)) return null;
		const level = spawnLevel(c.info);
		const stats = mobStats(this.creatures[c.info.entry], level, Math.max(0, RANK_NAMES.indexOf(c.info.rank ?? '')));
		const character = this.world.createCharacter();
		this.world.scene.add(character.group);
		const scale = new THREE.Vector3().setFromMatrixScale(c.matrix).x;
		void character.dressCreature(c.displayId, c.variant, scale);
		const walker = new PuppetWalker();
		walker.position.setFromMatrixPosition(c.matrix);
		walker.facing = facingOf(c.matrix);
		const mob: Mob = {
			key, info: c.info, level, stats, hp: stats.health, maxHp: stats.health, owner, character, walker,
			home: walker.position.clone(), height: c.height * scale, state: 'combat', target: owner === 'me' ? 'me' : '',
			threat: new Map(), swing: 0.5, swings: 0, stunUntil: 0, diedAt: 0,
			plate: { info: c.info, position: new THREE.Vector3(), distance: Infinity, matrix: new THREE.Matrix4(), height: 0 },
			reported: walker.position.clone(), reportedFacing: walker.facing,
		};
		if (owner === 'me') mob.threat.set('me', 1);
		this.world.objects.setHidden(key, true);
		this.mobs.set(key, mob);
		return mob;
	}

	/** Back into the crowd: the drawn model goes, the spawn shows again where it stood. */
	private dropMob(mob: Mob): void {
		mob.character.dispose();
		this.world.objects.setHidden(mob.key, false);
		this.mobs.delete(mob.key);
		if (this.target === mob.key && mob.state === 'dead') this.target = null;
	}

	private mobDied(mob: Mob): void {
		mob.state = 'dead';
		mob.diedAt = this.now;
		mob.hp = 0;
		mob.walker.intent.set(0, 0);
		mob.character.act(ACTIONS.death);
		if (this.target === mob.key) this.autoAttack = false;
		const by = [...mob.threat.keys()];
		if (by.includes('me')) this.rewardKill(mob.info.entry, mob.level, isElite(mob.stats.rank));
		const others = by.filter((id) => id !== 'me');
		if (others.length) this.net?.sendEvent({ t: 'kill', k: mob.key, e: mob.info.entry, l: mob.level, x: isElite(mob.stats.rank), by: others });
	}

	private rewardKill(entry: number, level: number, elite: boolean): void {
		const xp = killXp(this.level, level, elite);
		if (xp) this.gain(xp, `+${xp} XP`);
		for (const line of this.quests?.killed(entry) ?? []) this.onMessage(line);
		this.save();
		this.onChange();
	}

	/** Experience gained, and any levels it brings. */
	gain(xp: number, label?: string): void {
		if (!this.quests) return;
		const result = gainXp(this.level, this.xp, xp, this.quests.data.xp);
		if (label) this.float(this.world.walker.position, 2.4, label, '#c080ff');
		this.xp = result.xp;
		if (result.levels) {
			this.level = result.level;
			this.hp = this.maxHp;
			if (this.cls.resource === 'mana') this.power = this.maxPower;
			this.onMessage(`You have reached level ${this.level}!`);
			for (const a of this.cls.abilities) if (a.level > this.level - result.levels && a.level <= this.level) this.onMessage(`You have learned ${a.name}`);
		}
		this.save();
		this.onChange();
	}

	/** A blow to the player: the shield takes it first. */
	private damagePlayer(amount: number, from: string): void {
		if (!this.alive) return;
		this.combatUntil = this.now + OUT_OF_COMBAT;
		const absorbed = Math.min(this.shield, amount);
		this.shield -= absorbed;
		const taken = amount - absorbed;
		this.hp = Math.max(0, this.hp - taken);
		this.float(this.world.walker.position, 2, taken ? `-${taken}` : 'Absorb', '#ff4040');
		if (this.cls.resource === 'rage') this.power = Math.min(100, this.power + 3);
		if (this.hp <= 0) this.die(from);
		else if (Math.random() < 0.25 && !this.cast) this.act(ACTIONS.wound);
	}

	private die(killer: string): void {
		this.alive = false;
		this.autoAttack = false;
		this.cast = null;
		this.world.walker.frozen = true;
		this.act(ACTIONS.death);
		this.onMessage(killer ? `You were killed by ${killer}` : 'You died', true);
		this.onChange();
	}

	/** Back on your feet where you fell, with half your health. */
	release(): void {
		if (this.alive) return;
		this.alive = true;
		this.hp = Math.round(this.maxHp / 2);
		this.world.walker.frozen = false;
		this.world.character()?.stopEmote();
		this.onChange();
	}

	// --- Every frame -----------------------------------------------------------------------------

	update(dt: number): void {
		this.now += dt;
		for (const f of this.floats) f.age += dt;
		while (this.floats.length && this.floats[0].age > FLOAT_TIME) this.floats.shift();
		if (!this.enabled) return;
		const walking = this.world.walker.active;
		if (!walking && this.mobs.size) {
			for (const m of this.mobs.values()) if (m.owner === 'me' && m.state === 'combat') m.threat.delete('me');
		}
		this.regenerate(dt);
		this.updateCast();
		this.updateSwing(dt);
		this.tickDots();
		this.aggroTimer -= dt;
		if (this.aggroTimer <= 0 && walking && this.alive) {
			this.aggroTimer = AGGRO_EVERY;
			this.checkAggro();
		}
		for (const mob of [...this.mobs.values()]) {
			if (mob.owner === 'me') this.runMob(mob, dt);
			else this.followMob(mob, dt);
			mob.character.update(dt, mob.walker);
			const head = mob.character.head;
			if (head) {
				mob.plate.matrix.copy(head.matrix);
				mob.plate.height = head.height;
			}
		}
		this.report(dt);
	}

	private regenerate(dt: number): void {
		if (!this.alive) return;
		const resting = !this.inCombat;
		if (resting) this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.04 * dt);
		const r = this.cls.resource;
		if (r === 'energy') this.power = Math.min(100, this.power + 10 * dt);
		else if (r === 'rage') this.power = resting ? Math.max(0, this.power - 2 * dt) : this.power;
		else this.power = Math.min(this.maxPower, this.power + this.maxPower * (resting ? 0.03 : 0.005) * dt);
		for (let i = this.hots.length - 1; i >= 0; i--) {
			const h = this.hots[i];
			if (this.now < h.next) continue;
			this.heal(h.perTick);
			h.next += DOT_TICK;
			if (--h.ticks <= 0) this.hots.splice(i, 1);
		}
	}

	private updateCast(): void {
		const c = this.cast;
		if (!c) return;
		if (this.moving || !this.alive) {
			this.cast = null;
			this.world.character()?.stopEmote();
			this.onMessage('Interrupted', true);
			return;
		}
		if (this.now < c.end) return;
		this.cast = null;
		this.world.character()?.stopEmote();
		const t = c.ability.kind === 'self' ? null : this.targetInfo(c.target);
		if (c.ability.kind !== 'self' && (!t || t.dead)) return this.onMessage('Your target is dead', true);
		if (t && flatDistance(t.position, this.world.walker.position) > (c.ability.range ?? 30) + 2) return this.onMessage('Out of range', true);
		this.resolve(c.ability, c.target);
	}

	private updateSwing(dt: number): void {
		this.swingTimer = Math.max(0, this.swingTimer - dt);
		if (!this.autoAttack || !this.alive || this.cast) return;
		const t = this.targetInfo();
		if (!t || t.dead) {
			this.autoAttack = false;
			return;
		}
		if (flatDistance(t.position, this.world.walker.position) > this.reach(t.height) || this.swingTimer > 0) return;
		this.swingTimer = SWING_TIME;
		const mob = this.engage(this.target!);
		if (!mob) return;
		this.combatUntil = this.now + OUT_OF_COMBAT;
		this.act(...ACTIONS.attack);
		if (Math.random() > hitChance(this.level, mob.level)) return this.float(mob.walker.position, mob.height, 'Miss', '#ffffff');
		const crit = Math.random() < CRIT_CHANCE;
		const amount = Math.max(1, Math.round(weaponDamage(this.level) * (1 + (this.now < this.buff.until ? this.buff.damage : 0)) * random(0.85, 1.15) * (crit ? 2 : 1)));
		this.hitMob(mob, amount, 0, crit);
	}

	private tickDots(): void {
		for (let i = this.dots.length - 1; i >= 0; i--) {
			const d = this.dots[i];
			const mob = this.mobs.get(d.key);
			if (!mob || mob.state !== 'combat') {
				this.dots.splice(i, 1);
				continue;
			}
			if (this.now < d.next) continue;
			d.next += DOT_TICK;
			this.hitMob(mob, d.perTick, 0, false);
			if (--d.ticks <= 0) this.dots.splice(i, 1);
		}
	}

	/** Hostile creatures near enough notice the player and come for it. */
	private checkAggro(): void {
		const me = this.world.walker.position;
		for (const c of this.world.objects.creaturesNear(me, AGGRO_MAX)) {
			if (this.reaction(c.info) !== 'hostile' || this.mobs.has(c.key)) continue;
			const level = spawnLevel(c.info);
			const base = this.creatures[c.info.entry]?.[5] || 20;
			const range = Math.min(AGGRO_MAX, Math.max(5, base + (level - this.level)));
			if (c.distance <= range && Math.abs(c.position.y - me.y) < 10) this.engage(c.key);
		}
	}

	/** A mob we run: picks who to fight, chases, swings, gives up, dies and comes back. */
	private runMob(mob: Mob, dt: number): void {
		const w = mob.walker;
		if (mob.state === 'dead') {
			if (this.now - mob.diedAt > CORPSE_TIME) mob.character.group.visible = false;
			if (this.now - mob.diedAt > RESPAWN_TIME) this.dropMob(mob);
			return;
		}
		if (mob.state === 'evade') {
			if (this.moveToward(mob, mob.home, MOB_EVADE_SPEED, dt, 0.5)) this.dropMob(mob);
			return;
		}
		const target = this.pickTarget(mob);
		if (!target || flatDistance(w.position, mob.home) > LEASH) return this.evade(mob);
		mob.target = target.id;
		mob.swing = Math.max(0, mob.swing - dt);
		if (this.now < mob.stunUntil) {
			w.intent.set(0, 0);
			w.moveSpeed = 0;
			return;
		}
		const reach = MELEE_RANGE + 0.4 + mob.height * 0.2;
		if (flatDistance(w.position, target.position) > reach) {
			this.moveToward(mob, target.position, MOB_RUN, dt, reach * 0.8);
			return;
		}
		w.intent.set(0, 0);
		w.moveSpeed = 0;
		w.velocity.set(0, 0, 0);
		w.facing = Math.atan2(-(target.position.x - w.position.x), -(target.position.z - w.position.z));
		if (mob.swing > 0) return;
		mob.swing = mob.stats.attackMs / 1000;
		mob.swings++;
		mob.character.act(...ACTIONS.attack);
		const victimLevel = target.id === 'me' ? this.level : (this.world.remotePlayers.player(target.id)?.state.level ?? this.level);
		if (Math.random() > hitChance(mob.level, victimLevel)) {
			if (target.id === 'me') this.float(this.world.walker.position, 2, 'Miss', '#ff8080');
			return;
		}
		const amount = Math.round(random(mob.stats.damage[0], mob.stats.damage[1]));
		if (target.id === 'me') this.damagePlayer(amount, mob.info.name);
		else this.net?.sendEvent({ t: 'dmg', to: target.id, a: amount, n: mob.info.name });
	}

	/** Whom a mob fights: the most threatening player still standing and near. */
	private pickTarget(mob: Mob): { id: string; position: THREE.Vector3 } | null {
		let best: { id: string; position: THREE.Vector3 } | null = null;
		let most = -1;
		for (const [id, threat] of mob.threat) {
			const at = this.playerAt(id);
			if (!at || threat <= most || at.distanceTo(mob.walker.position) > LEASH * 1.5) continue;
			best = { id, position: at };
			most = threat;
		}
		return best;
	}

	/** Where a living, walking player is, by ID ('me' for us); null for anyone else. */
	private playerAt(id: string): THREE.Vector3 | null {
		if (id === 'me') return this.alive && this.world.walker.active ? this.world.walker.position : null;
		const p = this.world.remotePlayers.player(id);
		return p && p.state.kind === 'walk' && p.state.hp > 0 ? p.position : null;
	}

	private evade(mob: Mob): void {
		mob.state = 'evade';
		mob.target = '';
		mob.threat.clear();
		mob.hp = mob.maxHp;
		if (this.target === mob.key) this.autoAttack = false;
		this.dots.splice(0, this.dots.length, ...this.dots.filter((d) => d.key !== mob.key));
	}

	/** Runs a mob toward a point over the ground; true once within stop yards of it. */
	private moveToward(mob: Mob, to: THREE.Vector3, speed: number, dt: number, stop: number): boolean {
		const w = mob.walker;
		const dx = to.x - w.position.x, dz = to.z - w.position.z;
		const distance = Math.hypot(dx, dz);
		if (distance <= stop) {
			w.intent.set(0, 0);
			w.moveSpeed = 0;
			w.velocity.set(0, 0, 0);
			return true;
		}
		const step = Math.min(distance - stop, speed * dt);
		w.facing = Math.atan2(-dx, -dz);
		w.position.x += (dx / distance) * step;
		w.position.z += (dz / distance) * step;
		const floor = this.world.floorAt(w.position.x, w.position.z, w.position.y);
		w.position.y = Number.isFinite(floor) ? floor : THREE.MathUtils.lerp(w.position.y, to.y, Math.min(1, step / distance));
		w.intent.set(1, 0);
		w.moveSpeed = speed;
		w.velocity.set((dx / distance) * speed, 0, (dz / distance) * speed);
		return false;
	}

	/** A mob someone else runs: drawn where they last said, eased. */
	private followMob(mob: Mob, dt: number): void {
		const w = mob.walker;
		if (mob.state === 'dead') {
			w.intent.set(0, 0);
			return;
		}
		const gap = flatDistance(w.position, mob.reported);
		w.position.lerp(mob.reported, 1 - Math.exp(-dt * 10));
		w.facing += THREE.MathUtils.euclideanModulo(mob.reportedFacing - w.facing + Math.PI, Math.PI * 2) - Math.PI;
		w.intent.set(gap > 0.3 ? 1 : 0, 0);
		w.moveSpeed = gap > 0.3 ? MOB_RUN : 0;
	}

	// --- Together --------------------------------------------------------------------------------

	/** Tells the room about the mobs we run, a few times a second (and once more when there are none left). */
	private report(dt: number): void {
		if (!this.net) return;
		this.reportTimer -= dt;
		if (this.reportTimer > 0) return;
		this.reportTimer = MOB_REPORT;
		const mine = [...this.mobs.values()].filter((m) => m.owner === 'me');
		if (!mine.length && !this.hadMobs) return;
		this.hadMobs = mine.length > 0;
		const round = (v: number) => Math.round(v * 100) / 100;
		this.net.sendMobs(mine.map((m) => ({
			k: m.key, e: m.info.entry, l: m.level, hp: Math.round(m.hp), max: m.maxHp,
			p: [round(m.walker.position.x), round(m.walker.position.y), round(m.walker.position.z)], f: round(m.walker.facing),
			s: m.state === 'combat' ? 0 : m.state === 'evade' ? 1 : 2, t: m.target === 'me' ? this.net!.me : m.target, w: m.swings,
		})));
	}

	/** Mobs another player runs, as they report them. */
	receiveMobs(from: string, states: MobState[]): void {
		if (!this.enabled) return;
		const seen = new Set<string>();
		for (const s of states) {
			seen.add(s.k);
			let mob = this.mobs.get(s.k);
			if (mob?.owner === 'me') {
				// Both pulled it: the lower ID runs it.
				if (this.net && this.net.me < from) continue;
				mob.owner = from;
			}
			mob ??= this.engage(s.k, from) ?? undefined;
			if (!mob) continue;
			mob.owner = from;
			mob.level = s.l;
			mob.maxHp = s.max;
			mob.hp = s.hp;
			mob.reported.fromArray(s.p);
			mob.reportedFacing = s.f;
			mob.target = s.t === this.net?.me ? 'me' : s.t;
			if (s.w > mob.swings) mob.character.act(...ACTIONS.attack);
			mob.swings = s.w;
			if (s.s === 2 && mob.state !== 'dead') {
				mob.state = 'dead';
				mob.diedAt = this.now;
				mob.character.act(ACTIONS.death);
				if (this.target === mob.key) this.autoAttack = false;
			} else if (s.s !== 2) mob.state = s.s === 1 ? 'evade' : 'combat';
		}
		// Gone from their list: back home or respawned.
		for (const mob of [...this.mobs.values()]) {
			if (mob.owner === from && !seen.has(mob.key) && (mob.state !== 'dead' || this.now - mob.diedAt > CORPSE_TIME)) this.dropMob(mob);
		}
	}

	receiveEvent(from: string, e: CombatEvent): void {
		if (!this.enabled) return;
		if (e.t === 'hit') {
			const mob = this.mobs.get(e.k);
			if (mob?.owner === 'me') this.damageMob(mob, e.a, from, e.s);
		} else if (e.t === 'dmg') {
			if (e.to === this.net?.me) this.damagePlayer(e.a, e.n);
		} else if (e.t === 'kill') {
			if (this.net && e.by.includes(this.net.me)) this.rewardKill(e.e, e.l, e.x);
		}
	}

	/** A player left: mobs they ran go home; their threat is forgotten. */
	peerLeft(id: string): void {
		for (const mob of [...this.mobs.values()]) {
			mob.threat.delete(id);
			if (mob.owner === id) this.dropMob(mob);
		}
	}

	/** Nameplates for the mobs being fought (alive), with their health. */
	plates(out: Plate[]): void {
		for (const mob of this.mobs.values()) {
			if (mob.state === 'dead' || !mob.character.head) continue;
			const sub = `${mob.level}${isElite(mob.stats.rank) ? '+' : ''} · ${Math.round((100 * mob.hp) / mob.maxHp)}%`;
			if (mob.plate.info.subname !== sub) mob.plate.info = { ...mob.info, subname: sub };
			out.push(mob.plate);
		}
	}

	// --- Quests ----------------------------------------------------------------------------------

	accept(id: number): void {
		const why = this.quests?.accept(id, this.player);
		if (why) return this.onMessage(why, true);
		this.onMessage(`Quest accepted: ${this.quests?.quest(id)?.t}`);
		this.save();
		this.onChange();
	}

	abandon(id: number): void {
		this.quests?.abandon(id);
		this.save();
		this.onChange();
	}

	turnIn(id: number, choice?: number): void {
		const q = this.quests?.quest(id);
		const reward = this.quests?.turnIn(id, choice);
		if (!q || !reward) return this.onMessage('That quest isn’t complete', true);
		this.onMessage(`${q.t} completed.`);
		const xp = questXp(reward.xp, q.lv, this.level);
		if (reward.money) {
			this.money += reward.money;
		}
		for (const item of reward.items) this.onMessage(`You receive: ${item}`);
		if (xp) this.gain(xp, `+${xp} XP`);
		this.save();
		this.onChange();
	}

	/** A floating number over something (a mob, or the player), shown for a moment. */
	private float(at: THREE.Vector3, height: number, text: string, color: string): void {
		this.floats.push({ at: at.clone().setY(at.y + height + 0.4), text, color, age: 0 });
		if (this.floats.length > 40) this.floats.shift();
	}
}
