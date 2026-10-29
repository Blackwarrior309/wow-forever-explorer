import { expect, test, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import type { SpawnInfo } from '../src/explorer/spawns';
import { racialAbility } from '../src/game/classes';
import { QuestBook, type QuestData } from '../src/game/quests';
import { Adventure, type AdventureWorld } from '../src/viewer/adventure';
import type { CombatEvent, MobState } from '../src/viewer/multiplayer';

const data = JSON.parse(readFileSync('public/game/quests.json', 'utf8')) as QuestData;
const creatures = JSON.parse(readFileSync('public/game/creatures.json', 'utf8')) as Record<number, number[]>;

/** A drawn character that only records what it was asked to play. */
class FakeCharacter {
	readonly group = new THREE.Group();
	played: string[] = [];
	head: { matrix: THREE.Matrix4; height: number } | null = { matrix: new THREE.Matrix4(), height: 2 };
	dressCreature() {
		return Promise.resolve(1);
	}
	update() {}
	act(...emotes: { key: string }[]) {
		this.played.push(emotes[0].key);
		return true;
	}
	stopEmote() {}
	dispose() {
		this.group.removeFromParent();
	}
}

/** A world with one creature spawn (a Northshire wolf by default) and the player standing next to it. */
function world(entry = 299, name = 'Young Wolf', reaction: SpawnInfo['reaction'] = { alliance: 'hostile', horde: 'hostile' }, at = new THREE.Vector3(3, 0, 0)) {
	const info: SpawnInfo = { type: 'npc', guid: 1, entry, name, level: '1', reaction };
	const hidden = new Set<string>();
	const walker = { active: true, frozen: false, position: new THREE.Vector3(), intent: new THREE.Vector2(), state: 'ground' };
	const player = new FakeCharacter();
	const remote = new Map<string, { position: THREE.Vector3; state: { kind: 'walk'; hp: number; level: number } }>();
	const w = {
		scene: new THREE.Scene(),
		walker,
		character: () => player,
		objects: {
			creature: (key: string) => (key === 'k1' ? { info, matrix: new THREE.Matrix4().makeTranslation(at), displayId: 1, height: 1 } : null),
			creaturesNear: (p: THREE.Vector3, range: number) => (!hidden.has('k1') && at.distanceTo(p) <= range ? [{ key: 'k1', info, position: at.clone(), distance: at.distanceTo(p) }] : []),
			setHidden: (key: string, h: boolean) => (h ? hidden.add(key) : hidden.delete(key)),
		},
		remotePlayers: { player: (id: string) => remote.get(id) ?? null },
		createCharacter: () => new FakeCharacter(),
		floorAt: () => 0,
		race: () => 1,
		female: () => false,
	} as unknown as AdventureWorld;
	const adventure = new Adventure(w);
	adventure.creatures = creatures;
	adventure.quests = new QuestBook(data);
	adventure.enabled = true;
	return { adventure, walker, hidden, player, remote, at };
}

/** Runs the game for some seconds in small steps. */
const run = (a: Adventure, seconds: number) => {
	for (let t = 0; t < seconds; t += 0.05) a.update(0.05);
};

test('a fighting creature remains pickable after leaving the instanced crowd', () => {
	const { adventure: a, hidden } = world();
	run(a, 0.3);
	expect(hidden.has('k1')).toBe(true);
	const mob = a.mobs.get('k1')!;
	const origin = mob.walker.position.clone().add(new THREE.Vector3(-5, 0.5, 0));
	const ray = new THREE.Raycaster(origin, new THREE.Vector3(1, 0, 0), 0, 10);
	expect(a.pick(ray)?.key).toBe('k1');
	ray.far = 1;
	expect(a.pick(ray)).toBeNull();
	ray.far = 10;
	mob.state = 'dead';
	expect(a.pick(ray)).toBeNull();
});

test('class trainers check class, level, money and distance and teach abilities only once', () => {
	const { adventure: a, walker } = world(911, 'Warrior trainer', { alliance: 'friendly', horde: 'hostile' });
	a.trainers = JSON.parse(readFileSync('public/game/trainers.json', 'utf8'));
	expect(a.trainers[911]).toBe(1);
	let opened = '';
	a.onTrainer = (key) => { opened = key; };
	a.click({ key: 'k1', info: a.targetInfo('k1')!.info });
	expect(opened).toBe('k1');
	const rend = a.abilities.find((ability) => ability.id === 'rend')!;
	expect(a.knows(rend)).toBe(false);
	expect(a.trainingProblem('k1', rend)).toBe('Requires level 4');
	a.level = 4;
	expect(a.trainingProblem('k1', rend)).toBe('Not enough money');
	a.money = 100;
	walker.position.set(30, 0, 0);
	a.train('k1', rend.id);
	expect(a.knows(rend)).toBe(false);
	expect(a.money).toBe(100);
	walker.position.set(0, 0, 0);
	a.train('k1', rend.id);
	expect(a.knows(rend)).toBe(true);
	expect(a.money).toBe(60);
	a.train('k1', rend.id);
	expect(a.money).toBe(60);
	a.trainers[911] = 8;
	expect(a.trainerProblem('k1')).toContain('does not teach');
});

test('creating and switching characters preserves progress and clears temporary combat state', () => {
	const { adventure: a } = world();
	const original = a.characterId;
	a.name = 'First Warrior'; a.level = 4; a.xp = 123; a.money = 75;
	a.quests!.accept(783, a.player);
	a.newCharacter(8, 'Second Mage');
	const mage = a.characterId;
	expect(mage).not.toBe(original);
	expect(a.cls.id).toBe(8);
	expect(a.level).toBe(1);
	expect(a.money).toBe(0);
	expect(a.quests!.log).toEqual([]);
	a.shield = 99;
	expect(a.selectCharacter(original)).toBe(true);
	expect(a.name).toBe('First Warrior');
	expect(a.level).toBe(4);
	expect(a.xp).toBe(123);
	expect(a.money).toBe(75);
	expect(a.quests!.log).toContain(783);
	expect(a.shield).toBe(0);
	expect(a.selectCharacter(mage)).toBe(true);
	expect(a.name).toBe('Second Mage');
	expect(a.quests!.log).toEqual([]);
});

test('a hostile wolf notices the player, fights, dies and gives experience', () => {
	const { adventure: a, hidden, player, walker } = world();
	run(a, 0.3);
	// Noticed: taken out of the crowd and drawn on its own.
	expect(a.mobs.has('k1')).toBe(true);
	expect(hidden.has('k1')).toBe(true);
	a.setTarget('k1');
	a.startAttack();
	run(a, 40);
	expect(a.mobs.get('k1')?.state).toBe('dead');
	expect(player.played).toContain('attack');
	expect(a.xp).toBeGreaterThan(0);
	// The corpse goes and the wolf comes back where it stood (the player walked off, or it would come at once).
	walker.position.set(500, 0, 0);
	run(a, 60);
	expect(a.mobs.has('k1')).toBe(false);
	expect(hidden.has('k1')).toBe(false);
});

test('abilities cost rage, wait for their cooldown and can kill', () => {
	const { adventure: a } = world();
	a.setTarget('k1');
	a.use(1); // Heroic Strike: no rage yet
	expect(a.power).toBe(0);
	a.power = 100;
	a.use(1);
	// 15 paid, 6 back if it hit.
	const after = a.power;
	expect([85, 91]).toContain(after);
	a.use(1); // global cooldown
	expect(a.power).toBe(after);
	expect(a.cooldownLeft(a.abilities[0])).toBeGreaterThan(0);
	run(a, 1.6);
	a.power = 50;
	a.use(1);
	expect([35, 41]).toContain(a.power);
});

test('a player can die and get up again; mobs give up and go home', () => {
	const { adventure: a, walker } = world(299, 'Young Wolf');
	a.hp = 1;
	run(a, 10);
	expect(a.alive).toBe(false);
	expect(walker.frozen).toBe(true);
	run(a, 10);
	// Nobody to fight: the wolf walked home and rejoined the crowd.
	expect(a.mobs.size).toBe(0);
	a.release();
	expect(a.alive).toBe(true);
	expect(a.hp).toBe(Math.round(a.maxHp / 2));
	expect(walker.frozen).toBe(false);
});

test('friendly creatures are talked to, not fought', () => {
	// Deputy Willem gives A Threat Within (783), the first Northshire quest.
	const { adventure: a } = world(823, 'Deputy Willem', { alliance: 'friendly', horde: 'hostile' });
	const talked: number[] = [];
	a.onTalk = (_, entry) => talked.push(entry);
	run(a, 1);
	expect(a.mobs.size).toBe(0);
	expect(a.click({ info: a.targetInfo('k1')!.info, key: 'k1' })).toBe(true);
	expect(talked).toEqual([823]);
	a.use(0);
	expect(a.autoAttack).toBe(false);
});

test('killing counts toward a kill quest', () => {
	// Kobold Camp Cleanup (7): Kobold Vermin (6).
	const id = 7;
	expect(data.quests[id].kill[0][0]).toBe(6);
	const { adventure: a } = world(6, 'Kobold Vermin');
	a.quests = new QuestBook(data, { active: [{ id, kills: [0], uses: [] }] });
	a.setTarget('k1');
	a.startAttack();
	run(a, 60);
	expect(a.quests.objectives(id)[0].text).toMatch(/1\//);
});

test('together: a mob someone else runs takes our hits by message, and their kill credits us', () => {
	const { adventure: a } = world();
	const sent: CombatEvent[] = [];
	a.net = { me: 'bbb', sendEvent: (e) => sent.push(e), sendMobs: () => {} };
	const report: MobState = { k: 'k1', e: 299, l: 1, hp: 50, max: 50, m: -1, p: [3, 0, 0], f: 0, s: 0, t: 'aaa', w: 0 };
	a.receiveMobs('aaa', [report]);
	expect(a.mobs.get('k1')?.owner).toBe('aaa');
	a.setTarget('k1');
	a.startAttack();
	const random = spyOn(Math, 'random').mockReturnValue(0.5);
	try { run(a, 0.2); } finally { random.mockRestore(); }
	// Our swings go to the owner rather than being applied here.
	expect(sent.some((e) => e.t === 'hit' && e.k === 'k1')).toBe(true);
	const before = a.xp;
	a.receiveEvent('aaa', { t: 'kill', k: 'k1', e: 299, l: 1, x: false, by: ['bbb'] });
	expect(a.xp).toBeGreaterThan(before);
	// And a blow the owner says hit us.
	const hp = a.hp;
	a.receiveEvent('aaa', { t: 'dmg', to: 'bbb', a: 5, n: 'Young Wolf' });
	expect(a.hp).toBe(hp - 5);
	// The owner left: its mob goes back to the crowd.
	a.peerLeft('aaa');
	expect(a.mobs.size).toBe(0);
});

test('together: a mob we run takes others hits and reports its state', () => {
	const { adventure: a, remote } = world();
	const reports: MobState[][] = [];
	a.net = { me: 'aaa', sendEvent: () => {}, sendMobs: (m) => reports.push(m) };
	remote.set('ccc', { position: new THREE.Vector3(2, 0, 0), state: { kind: 'walk', hp: 100, level: 1 } });
	run(a, 0.5);
	const mob = a.mobs.get('k1')!;
	expect(mob.owner).toBe('me');
	a.receiveEvent('ccc', { t: 'hit', k: 'k1', a: 10, s: 0 });
	expect(mob.hp).toBe(mob.maxHp - 10);
	run(a, 0.3);
	expect(reports.at(-1)?.[0]).toMatchObject({ k: 'k1', hp: mob.hp });
});

test('buffs show on the player with the time they have left, and run out', () => {
	const { adventure: a } = world();
	a.power = 100;
	a.use(2); // Battle Shout
	const [shout] = a.auras('player');
	expect(shout.ability.name).toBe('Battle Shout');
	expect(shout.debuff).toBe(false);
	expect(shout.left).toBeCloseTo(120, 0);
	a.hp = 1e6; // Survives the wolf meanwhile.
	run(a, 121);
	expect(a.auras('player')).toEqual([]);
	expect(a.auras('nobody')).toEqual([]);
});

test('talents: a point a level from 10, rows open by points in the tree, prerequisites first', () => {
	const { adventure: a } = world();
	const talent = (id: number, tier: number, ranks: number, requires: { talent: number; rank: number } | null = null) => ({ id, tier, column: 0, name: `T${id}`, icon: 0, ranks: Array(ranks).fill(''), requires });
	a.talentTrees = [{ id: 1, name: 'Arms', background: 'WarriorArms', talents: [talent(1, 0, 5), talent(2, 1, 3), talent(3, 2, 1, { talent: 2, rank: 3 })] }];
	expect(a.talentProblem(1)).toBe('Talents become available at level 10');
	a.level = 20;
	const health = a.maxHp;
	expect(a.talentProblem(2)).toBe('Requires 5 points in Arms');
	for (let i = 0; i < 5; i++) a.learnTalent(1);
	expect(a.talentProblem(1)).toBe('Already at the highest rank');
	expect(a.talentProblem(2)).toBeNull();
	a.learnTalent(2);
	a.learnTalent(2);
	expect(a.talentProblem(3)).toBe('Requires 10 points in Arms');
	expect(a.talentsSpent).toBe(7);
	expect(a.talentPointsLeft).toBe(4);
	expect(a.maxHp).toBeGreaterThan(health);
	a.resetTalents();
	expect(a.talentPointsLeft).toBe(11);
});

test('racial abilities from the game data are known at once and used from their slot', () => {
	const { adventure: a } = world();
	a.racials = [racialAbility({ spell: 20572, name: 'Blood Fury', icon: 135726, description: 'More damage.' })];
	const blood = a.abilities.at(-1)!;
	expect(blood).toMatchObject({ racial: true, buff: { damage: 0.15, duration: 15 } });
	expect(a.knows(blood)).toBe(true);
	a.use(a.abilities.length);
	expect(a.auras('player').map((x) => x.ability.name)).toContain('Blood Fury');
	expect(a.cooldownLeft(blood)).toBeGreaterThan(60);
});
