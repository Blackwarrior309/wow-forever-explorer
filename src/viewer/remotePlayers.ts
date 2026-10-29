import * as THREE from 'three';
import type { SpawnInfo } from '../explorer/spawns';
import { MODEL_BASIS, type Character, type WalkerView } from './character';
import { classById } from '../game/classes';
import { ACTIONS, EMOTES, type Emote } from './emotes';
import type { PlayerState } from './multiplayer';
import type { Plate } from './nameplates';
import { angleDelta } from './walkControls';

/** How quickly a player's drawn place catches up with where they're reported (1/e per 1/rate s). */
const FOLLOW_RATE = 10;
/** Further than this from where it's drawn (yards), a player jumps there: a teleport, a flight. */
const SNAP = 30;
/** Moved on along their velocity at most this long past the last message (s), between messages. */
const PREDICT = 0.5;
/** A visitor's name hangs this far above the camera they fly (yards). */
const VISITOR_HEIGHT = 0.5;
const TURN_RATE = 12;

/** A walker driven by messages (or a mob's AI) rather than keys, for a Character to follow. */
export class PuppetWalker implements WalkerView {
	active = true;
	firstPerson = false;
	readonly position = new THREE.Vector3();
	facing = 0;
	state: WalkerView['state'] = 'ground';
	readonly intent = new THREE.Vector2();
	airTime = 0;
	readonly velocity = new THREE.Vector3();
	moveSpeed = 0;
	jumped = false;
	walkMode = false;
	turning = 0;
	scale = 1;
}

interface Player {
	walker: PuppetWalker;
	character: Character;
	state: PlayerState;
	/** Where they were reported, and how long ago (s). */
	target: THREE.Vector3;
	age: number;
	lookKey: string;
	/** The emote asked for, and whether it has been started (the model may still be loading). */
	emote: string | null;
	emoteStarted: boolean;
	plate: Plate;
	placed: boolean;
}

/** Everyone else in the room, drawn and named as they move. */
export class RemotePlayers {
	private readonly players = new Map<string, Player>();

	constructor(
		private readonly scene: THREE.Scene,
		private readonly createCharacter: () => Character,
	) {}

	/** A player's latest state, or null when they've left. */
	set(id: string, state: PlayerState | null): void {
		let p = this.players.get(id);
		if (!state) {
			if (p) p.character.dispose();
			this.players.delete(id);
			return;
		}
		if (!p) {
			const character = this.createCharacter();
			this.scene.add(character.group);
			p = {
				walker: new PuppetWalker(),
				character,
				state,
				target: new THREE.Vector3(),
				age: 0,
				lookKey: '',
				emote: null,
				emoteStarted: false,
				plate: { info: plateInfo(state), position: new THREE.Vector3(), distance: Infinity, matrix: new THREE.Matrix4(), height: 0 },
				placed: false,
			};
			this.players.set(id, p);
		}
		if (plateKey(p.state) !== plateKey(state)) p.plate.info = plateInfo(state);
		p.state = state;
		p.target.fromArray(state.position);
		p.age = 0;
		const lookKey = JSON.stringify(state.look);
		if (state.kind === 'walk' && lookKey !== p.lookKey) {
			p.lookKey = lookKey;
			// shortcut: others never carry a torch, only their own look; send the torch flag if it's missed.
			void p.character.dress(state.look, false).then(() => (p!.emoteStarted = false));
		}
		if (state.emote !== p.emote) {
			p.emote = state.emote;
			p.emoteStarted = false;
		}
		const w = p.walker;
		w.active = state.kind === 'walk';
		w.state = state.state;
		w.intent.fromArray(state.intent);
		w.velocity.fromArray(state.velocity);
		w.moveSpeed = state.moveSpeed;
		w.jumped = state.jumped;
		w.walkMode = state.walkMode;
		w.turning = state.turning;
	}

	/** Moves everyone toward where they were last reported, and plays what they're doing. */
	update(dt: number): void {
		for (const p of this.players.values()) {
			const w = p.walker;
			p.age += dt;
			const predicted = p.target.clone().addScaledVector(w.velocity, Math.min(p.age, PREDICT));
			if (!p.placed || w.position.distanceTo(predicted) > SNAP) {
				w.position.copy(predicted);
				w.facing = p.state.facing;
				p.placed = true;
			} else {
				w.position.lerp(predicted, 1 - Math.exp(-dt * FOLLOW_RATE));
				const turn = angleDelta(w.facing, p.state.facing);
				w.facing += turn * (1 - Math.exp(-dt * TURN_RATE));
			}
			w.airTime = w.state === 'air' ? w.airTime + dt : 0;
			p.character.update(dt, w);
			// Walkers named over their heads, visitors where they fly; every frame, as the plates follow.
			const head = p.state.kind === 'walk' ? p.character.head : null;
			if (head) {
				p.plate.matrix.copy(head.matrix);
				p.plate.height = head.height;
			} else {
				p.plate.matrix.makeTranslation(w.position).multiply(MODEL_BASIS);
				p.plate.height = p.state.kind === 'walk' ? 2 : VISITOR_HEIGHT;
			}
			if (!p.emoteStarted) {
				const emotes = p.emote ? performed(p.emote) : [];
				if (!emotes.length) {
					p.character.stopEmote();
					p.emoteStarted = true;
				} else if (w.active && w.state === 'ground') {
					// null while the model is still loading: tried again next frame.
					p.emoteStarted = p.character.act(...emotes) !== null;
				}
			}
		}
	}

	/** Their names, for the nameplates (kept following them in update). */
	plates(out: Plate[]): void {
		for (const p of this.players.values()) out.push(p.plate);
	}

	/** Where a player stands (feet) and their state, if they're here. */
	player(id: string): { position: THREE.Vector3; state: PlayerState } | null {
		const p = this.players.get(id);
		return p ? { position: p.walker.position, state: p.state } : null;
	}

	/** Names of those here, on foot or visiting. */
	get list(): { name: string; kind: PlayerState['kind'] }[] {
		return [...this.players.values()].map((p) => ({ name: p.state.name, kind: p.state.kind }));
	}

	clear(): void {
		for (const id of [...this.players.keys()]) this.set(id, null);
	}
}

/** What a player's nameplate says: friendly to both sides, visitors marked so, adventurers with level, class and health. */
function plateInfo(state: PlayerState): SpawnInfo {
	return { type: 'npc', guid: 0, entry: 0, name: state.name, subname: plateSub(state), reaction: { alliance: 'friendly', horde: 'friendly' } };
}
function plateSub(state: PlayerState): string | undefined {
	if (state.kind === 'fly') return 'Visitor';
	if (!state.level) return undefined;
	const health = state.hp <= 0 ? 'dead' : `${Math.round((100 * state.hp) / Math.max(1, state.maxHp))}%`;
	return `Level ${state.level} ${classById(state.cls).name} · ${health}`;
}
const plateKey = (state: PlayerState) => `${state.name}\n${plateSub(state) ?? ''}`;

/** The emote, or the fighting action (any of its stand-ins), with a key. */
function performed(key: string): Emote[] {
	const action = Object.values(ACTIONS).flat().filter((e) => e.key === key);
	if (action.length) return action;
	const emote = EMOTES.find((e) => e.key === key);
	return emote ? [emote] : [];
}
