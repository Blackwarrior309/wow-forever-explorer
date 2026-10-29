import type { MqttClient } from 'mqtt';
import { CHARACTER_OUTFITS } from '../explorer/spawns';
import type { CharacterLook } from './character';
import { ACTIONS, EMOTES } from './emotes';
import type { WalkState } from './walkControls';

/**
 * Exploring together: every player's browser sends where its character is, a few times a second,
 * through a public MQTT broker, and draws everyone else's from its own game files. Nothing of the
 * game is sent, only these few numbers; there is no server of our own.
 */

/** The public broker the Valheim world viewer uses too; `?mqtt=wss://…` picks another. */
const DEFAULT_BROKER = 'wss://broker.emqx.io:8084/mqtt';
/** Bumped when a message changes in a way older pages would misread. */
// v3: positions in their map's own frame, so players of different game versions meet.
const PROTOCOL = 'v3';
/** Most a state is sent (ms): moving, and while nothing changes, to show it's still there. */
const SEND_EVERY = 100;
const HEARTBEAT = 1000;
/** A player not heard from for this long has left (ms): closed the page without saying so. */
const PEER_TIMEOUT = 5000;
/** Longest message read, bytes: anything bigger isn't from this page. */
const MAX_MESSAGE = 2048;
const MAX_MOB_MESSAGE = 16384;
/** Most mobs one player reports at once. */
const MAX_MOBS = 40;
export const NAME_MAX = 24;
const ROOM_MAX = 32;
const WORLD_LIMIT = 1e6;
const ID = /^[a-z0-9]{1,16}$/;
/** Spawn instance keys, as objects.ts makes them. */
const KEY = /^[\w:.-]{1,40}$/;

const STATES: WalkState[] = ['settling', 'ground', 'air', 'swim'];
/** Emotes and fighting actions others are shown performing. */
const SHOWN = new Set([...EMOTES.map((e) => e.key), ...Object.values(ACTIONS).flat().map((e) => e.key)]);

/** What one player sends: on foot ('walk', the character) or flying the free camera ('fly', a visitor). */
export interface PlayerState {
	name: string;
	kind: 'walk' | 'fly';
	look: CharacterLook;
	/** The map (Map.db2 ID) the position is on; -1 off every map. */
	map: number;
	/** Feet (walking) or the camera (flying), in its map's own frame (see Viewer.toShared). */
	position: [number, number, number];
	facing: number;
	state: WalkState;
	/** Forward (+1, -1 back) and right (+1, -1 left), as WalkControls.intent. */
	intent: [number, number];
	velocity: [number, number, number];
	moveSpeed: number;
	jumped: boolean;
	walkMode: boolean;
	turning: number;
	/** The emote or fighting action being performed (its key), if any. */
	emote: string | null;
	/** In Adventure mode: health, its maximum, level and class (all 0 when not playing). */
	hp: number;
	maxHp: number;
	level: number;
	cls: number;
}

/** A room name as typed, made safe for a topic: lower case letters, digits, - and _. */
export function roomName(typed: string): string {
	return typed.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, ROOM_MAX) || 'azeroth';
}

/** A player name as typed: no control characters, trimmed, at most NAME_MAX characters. */
export function playerName(typed: string): string {
	return [...typed.replace(/[\p{C}]/gu, '').trim()].slice(0, NAME_MAX).join('') || 'Adventurer';
}

const finite = (v: unknown, limit: number): number | null => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit ? v : null);
const whole = (v: unknown, min: number, max: number): number | null => {
	const n = finite(v, Math.max(Math.abs(min), Math.abs(max)));
	return n !== null && Number.isInteger(n) && n >= min && n <= max ? n : null;
};
function vector<N extends 2 | 3>(v: unknown, length: N, limit: number): number[] | null {
	if (!Array.isArray(v) || v.length !== length) return null;
	const out = v.map((x) => finite(x, limit));
	return out.every((x) => x !== null) ? (out as number[]) : null;
}
function parse(text: string, max = MAX_MESSAGE): Record<string, unknown> | null {
	if (text.length > max) return null;
	try {
		const raw: unknown = JSON.parse(text);
		return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * A message from the broker, checked: anyone who knows the room can send anything, so only a
 * well-formed state gets through, with every value in range. Null for anything else.
 */
export function decodeState(text: string): PlayerState | null {
	const m = parse(text);
	if (!m) return null;
	const position = vector(m.p, 3, WORLD_LIMIT);
	const facing = finite(m.f, 100);
	const l = m.l as Record<string, unknown> | null;
	if (!position || facing === null || (m.k !== 'walk' && m.k !== 'fly') || !l || typeof l !== 'object') return null;
	const race = finite(l.race, 100), sex = finite(l.sex, 1), look = finite(l.look, 100000);
	if (race === null || sex === null || look === null || !Number.isInteger(race) || !Number.isInteger(sex) || !Number.isInteger(look) || race < 1 || sex < 0) return null;
	const outfit = typeof l.outfit === 'string' && Object.hasOwn(CHARACTER_OUTFITS, l.outfit) ? (l.outfit as CharacterLook['outfit']) : null;
	const intent = vector(m.i, 2, 1) ?? [0, 0];
	const velocity = vector(m.v, 3, 1000) ?? [0, 0, 0];
	const maxHp = whole(m.H, 0, 1e6) ?? 0;
	return {
		name: playerName(typeof m.n === 'string' ? m.n : ''),
		kind: m.k,
		look: { race, sex, hd: l.hd === true, look, outfit },
		map: whole(m.M, -1, 1e6) ?? -1,
		position: position as PlayerState['position'],
		facing,
		state: STATES.includes(m.s as WalkState) ? (m.s as WalkState) : 'ground',
		intent: [Math.sign(intent[0]), Math.sign(intent[1])],
		velocity: velocity as PlayerState['velocity'],
		moveSpeed: Math.max(0, finite(m.m, 100) ?? 0),
		jumped: m.j === true,
		walkMode: m.w === true,
		turning: Math.sign(finite(m.t, 1) ?? 0),
		emote: typeof m.e === 'string' && SHOWN.has(m.e) ? m.e : null,
		hp: Math.min(maxHp, whole(m.h, 0, 1e6) ?? 0),
		maxHp,
		level: whole(m.lv, 0, 100) ?? 0,
		cls: whole(m.c, 0, 20) ?? 0,
	};
}

/** A state as sent: short keys, positions to the centimetre. */
export function encodeState(s: PlayerState): string {
	const round = (v: number) => Math.round(v * 100) / 100;
	return JSON.stringify({
		n: s.name,
		k: s.kind,
		l: s.look,
		M: s.map,
		p: s.position.map(round),
		f: round(s.facing),
		s: s.state,
		i: s.intent,
		v: s.velocity.map(round),
		m: round(s.moveSpeed),
		j: s.jumped,
		w: s.walkMode,
		t: s.turning,
		e: s.emote,
		h: Math.round(s.hp),
		H: Math.round(s.maxHp),
		lv: s.level,
		c: s.cls,
	});
}

/**
 * What fighting together sends between players. Every mob being fought is run by one player, its
 * owner (whoever pulled it); the others send it their hits and stuns, and it sends its blows to
 * the player it hits and, when it dies, the kill to everyone who hit it.
 */
export type CombatEvent =
	/** Damage (and a stun, seconds) for a mob, to its owner. */
	| { t: 'hit'; k: string; a: number; s: number }
	/** A mob's blow, to the player it hit. */
	| { t: 'dmg'; to: string; a: number; n: string }
	/** A mob died: its creature entry, level and eliteness, and who gets credit. */
	| { t: 'kill'; k: string; e: number; l: number; x: boolean; by: string[] };

export function decodeEvent(text: string): CombatEvent | null {
	const m = parse(text);
	if (!m) return null;
	if (m.t === 'hit' && typeof m.k === 'string' && KEY.test(m.k)) {
		const a = whole(m.a, 0, 1e6), s = finite(m.s, 30) ?? 0;
		return a === null ? null : { t: 'hit', k: m.k, a, s: Math.max(0, s) };
	}
	if (m.t === 'dmg' && typeof m.to === 'string' && ID.test(m.to)) {
		const a = whole(m.a, 0, 1e6);
		return a === null ? null : { t: 'dmg', to: m.to, a, n: typeof m.n === 'string' ? m.n.slice(0, 60) : '' };
	}
	if (m.t === 'kill' && typeof m.k === 'string' && KEY.test(m.k) && Array.isArray(m.by)) {
		const e = whole(m.e, 0, 1e7), l = whole(m.l, 0, 100);
		const by = m.by.filter((id): id is string => typeof id === 'string' && ID.test(id)).slice(0, 40);
		return e === null || l === null ? null : { t: 'kill', k: m.k, e, l, x: m.x === true, by };
	}
	return null;
}

/** A mob as its owner reports it, a few times a second. */
export interface MobState {
	/** Spawn instance key, creature entry and level. */
	k: string;
	e: number;
	l: number;
	hp: number;
	max: number;
	/** Where it is: on a map (Map.db2 ID, -1 none), in that map's own frame. */
	m: number;
	p: [number, number, number];
	f: number;
	/** 0 fighting, 1 going home, 2 dead. */
	s: 0 | 1 | 2;
	/** Who it's fighting (a player ID, '' none). */
	t: string;
	/** Swings so far, so others play each one. */
	w: number;
}

export function decodeMobs(text: string): MobState[] | null {
	const m = parse(text, MAX_MOB_MESSAGE);
	if (!m || !Array.isArray(m.mobs)) return null;
	const out: MobState[] = [];
	for (const raw of m.mobs.slice(0, MAX_MOBS)) {
		if (!raw || typeof raw !== 'object') continue;
		const r = raw as Record<string, unknown>;
		const p = vector(r.p, 3, WORLD_LIMIT);
		const e = whole(r.e, 0, 1e7), l = whole(r.l, 0, 100), hp = whole(r.hp, 0, 1e7), max = whole(r.max, 1, 1e7);
		const f = finite(r.f, 100), s = whole(r.s, 0, 2), w = whole(r.w, 0, 1e9);
		if (typeof r.k !== 'string' || !KEY.test(r.k) || !p || e === null || l === null || hp === null || max === null || f === null || s === null || w === null) continue;
		out.push({ k: r.k, e, l, hp: Math.min(hp, max), max, m: whole(r.m, -1, 1e6) ?? -1, p: p as MobState['p'], f, s: s as MobState['s'], t: typeof r.t === 'string' && (r.t === '' || ID.test(r.t)) ? r.t : '', w });
	}
	return out;
}

export type RoomStatus = 'connecting' | 'connected' | 'offline';

export interface RoomHandlers {
	/** A player's latest state, or null when they've left. */
	peer: (id: string, state: PlayerState | null) => void;
	status: (status: RoomStatus, detail?: string) => void;
	event: (from: string, event: CombatEvent) => void;
	/** The mobs a player runs (all of them; an empty list when they run none). */
	mobs: (from: string, mobs: MobState[]) => void;
}

/**
 * One room on the broker under `mapexplorer/v2/<realm>/<room>/`: `p/<id>` holds each player's
 * state, and an empty message there (sent on leaving, or by the broker when the page is closed)
 * says they've gone; `e/<id>` carries combat events from a player and `m/<id>` the mobs it runs.
 * Positions are in their map's own frame, the same in every game version, so the realm can be
 * shared by all of them; another version's player shows where they are, on a map both have.
 */
export class MultiplayerRoom {
	readonly id = Math.random().toString(36).slice(2, 10);
	private client: MqttClient | null = null;
	private readonly seen = new Map<string, number>();
	private lastText = '';
	private lastSent = -Infinity;
	private sweeper = 0;
	private closed = false;

	private constructor(private readonly base: string, private readonly on: RoomHandlers) {}

	/** Joins a room for a game version (any text; made safe here). */
	static async join(realm: string, room: string, on: RoomHandlers): Promise<MultiplayerRoom> {
		const self = new MultiplayerRoom(`mapexplorer/${PROTOCOL}/${roomName(realm)}/${roomName(room)}/`, on);
		on.status('connecting');
		// Loaded only when someone joins: it's most of a megabyte nobody exploring alone needs.
		const mqtt = await import('mqtt');
		// The build gets the ES module (named exports); the dev server's pre-bundle of the UMD file has them only on default.
		const connect = mqtt.connect ?? mqtt.default.connect;
		const url = new URLSearchParams(location.search).get('mqtt') || DEFAULT_BROKER;
		const client = connect(url, {
			clientId: `mx_${self.id}`,
			clean: true,
			connectTimeout: 15000,
			reconnectPeriod: 4000,
			keepalive: 30,
			will: { topic: `${self.base}p/${self.id}`, payload: '', qos: 0, retain: false },
		});
		self.client = client;
		client.on('connect', () => {
			client.subscribe(['p/+', 'e/+', 'm/+'].map((t) => self.base + t), (err) => self.on.status(err ? 'offline' : 'connected', err?.message));
			// Others learn of us at once rather than at the next heartbeat.
			self.lastSent = -Infinity;
		});
		client.on('reconnect', () => self.on.status('connecting'));
		client.on('offline', () => self.on.status('offline'));
		client.on('error', (e) => self.on.status('offline', e.message));
		client.on('message', (topic, payload) => self.receive(topic, payload));
		self.sweeper = window.setInterval(() => self.sweep(), 1000);
		return self;
	}

	private receive(topic: string, payload: Uint8Array): void {
		if (this.closed || !topic.startsWith(this.base)) return;
		const [channel, id] = topic.slice(this.base.length).split('/');
		if (!id || id === this.id || !ID.test(id)) return;
		const text = new TextDecoder().decode(payload);
		if (channel === 'p') {
			if (!payload.length) {
				if (this.seen.delete(id)) this.on.peer(id, null);
				return;
			}
			const state = decodeState(text);
			if (!state) return;
			this.seen.set(id, performance.now());
			this.on.peer(id, state);
		} else if (channel === 'e' && this.seen.has(id)) {
			const event = decodeEvent(text);
			if (event) this.on.event(id, event);
		} else if (channel === 'm' && this.seen.has(id)) {
			const mobs = decodeMobs(text);
			if (mobs) this.on.mobs(id, mobs);
		}
	}

	private sweep(): void {
		const now = performance.now();
		for (const [id, at] of this.seen) {
			if (now - at < PEER_TIMEOUT) continue;
			this.seen.delete(id);
			this.on.peer(id, null);
		}
	}

	/** Sends our state when it changed (at most every SEND_EVERY ms) or as a heartbeat; call it often. */
	send(state: PlayerState, now = performance.now()): void {
		const client = this.client;
		if (this.closed || !client?.connected) return;
		const text = encodeState(state);
		const due = text !== this.lastText ? now - this.lastSent >= SEND_EVERY : now - this.lastSent >= HEARTBEAT;
		if (!due) return;
		client.publish(`${this.base}p/${this.id}`, text, { qos: 0 });
		this.lastText = text;
		this.lastSent = now;
	}

	sendEvent(event: CombatEvent): void {
		if (!this.closed && this.client?.connected) this.client.publish(`${this.base}e/${this.id}`, JSON.stringify(event), { qos: 0 });
	}

	sendMobs(mobs: MobState[]): void {
		if (!this.closed && this.client?.connected) this.client.publish(`${this.base}m/${this.id}`, JSON.stringify({ mobs: mobs.slice(0, MAX_MOBS) }), { qos: 0 });
	}

	/** How many others are here now. */
	get count(): number {
		return this.seen.size;
	}

	/** Says goodbye and disconnects; everyone here is reported as gone. */
	leave(): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.sweeper);
		const client = this.client;
		if (client?.connected) client.publish(`${this.base}p/${this.id}`, '', { qos: 0 });
		client?.end(false);
		for (const id of this.seen.keys()) this.on.peer(id, null);
		this.seen.clear();
		this.on.status('offline');
	}
}
