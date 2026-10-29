import type { MqttClient } from 'mqtt';
import { CHARACTER_OUTFITS } from '../explorer/spawns';
import type { CharacterLook } from './character';
import { EMOTES } from './emotes';
import type { WalkState } from './walkControls';

/**
 * Exploring together: every player's browser sends where its character is, a few times a second,
 * through a public MQTT broker, and draws everyone else's from its own game files. Nothing of the
 * game is sent, only these few numbers; there is no server of our own.
 */

/** The public broker the Valheim world viewer uses too; `?mqtt=wss://…` picks another. */
const DEFAULT_BROKER = 'wss://broker.emqx.io:8084/mqtt';
/** Bumped when PlayerState changes in a way older pages would misread. */
const PROTOCOL = 'v1';
/** Most a state is sent (ms): moving, and while nothing changes, to show it's still there. */
const SEND_EVERY = 100;
const HEARTBEAT = 1000;
/** A player not heard from for this long has left (ms): closed the page without saying so. */
const PEER_TIMEOUT = 5000;
/** Longest message read, bytes: anything bigger isn't from this page. */
const MAX_MESSAGE = 2048;
export const NAME_MAX = 24;
const ROOM_MAX = 32;
const WORLD_LIMIT = 1e6;

const STATES: WalkState[] = ['settling', 'ground', 'air', 'swim'];

/** What one player sends: on foot ('walk', the character) or flying the free camera ('fly', a visitor). */
export interface PlayerState {
	name: string;
	kind: 'walk' | 'fly';
	look: CharacterLook;
	/** Feet (walking) or the camera (flying), in the viewer's world space. */
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
	/** The emote being performed (its key), if any. */
	emote: string | null;
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
function vector<N extends 2 | 3>(v: unknown, length: N, limit: number): number[] | null {
	if (!Array.isArray(v) || v.length !== length) return null;
	const out = v.map((x) => finite(x, limit));
	return out.every((x) => x !== null) ? (out as number[]) : null;
}

/**
 * A message from the broker, checked: anyone who knows the room can send anything, so only a
 * well-formed state gets through, with every value in range. Null for anything else.
 */
export function decodeState(text: string): PlayerState | null {
	if (text.length > MAX_MESSAGE) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== 'object') return null;
	const m = raw as Record<string, unknown>;
	const position = vector(m.p, 3, WORLD_LIMIT);
	const facing = finite(m.f, 100);
	const l = m.l as Record<string, unknown> | null;
	if (!position || facing === null || (m.k !== 'walk' && m.k !== 'fly') || !l || typeof l !== 'object') return null;
	const race = finite(l.race, 100), sex = finite(l.sex, 1), look = finite(l.look, 100000);
	if (race === null || sex === null || look === null || !Number.isInteger(race) || !Number.isInteger(sex) || !Number.isInteger(look) || race < 1 || sex < 0) return null;
	const outfit = typeof l.outfit === 'string' && Object.hasOwn(CHARACTER_OUTFITS, l.outfit) ? (l.outfit as CharacterLook['outfit']) : null;
	const intent = vector(m.i, 2, 1) ?? [0, 0];
	const velocity = vector(m.v, 3, 1000) ?? [0, 0, 0];
	return {
		name: playerName(typeof m.n === 'string' ? m.n : ''),
		kind: m.k,
		look: { race, sex, hd: l.hd === true, look, outfit },
		position: position as PlayerState['position'],
		facing,
		state: STATES.includes(m.s as WalkState) ? (m.s as WalkState) : 'ground',
		intent: [Math.sign(intent[0]), Math.sign(intent[1])],
		velocity: velocity as PlayerState['velocity'],
		moveSpeed: Math.max(0, finite(m.m, 100) ?? 0),
		jumped: m.j === true,
		walkMode: m.w === true,
		turning: Math.sign(finite(m.t, 1) ?? 0),
		emote: typeof m.e === 'string' && EMOTES.some((e) => e.key === m.e) ? m.e : null,
	};
}

/** A state as sent: short keys, positions to the centimetre. */
export function encodeState(s: PlayerState): string {
	const round = (v: number) => Math.round(v * 100) / 100;
	return JSON.stringify({
		n: s.name,
		k: s.kind,
		l: s.look,
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
	});
}

export type RoomStatus = 'connecting' | 'connected' | 'offline';

/**
 * One room on the broker: `mapexplorer/v1/<realm>/<room>/p/<id>` holds each player's state, and an
 * empty message (sent on leaving, or by the broker when the page is closed) says they've gone.
 * The realm keeps game versions apart: world positions only match within one build.
 */
export class MultiplayerRoom {
	readonly id = Math.random().toString(36).slice(2, 10);
	private client: MqttClient | null = null;
	private readonly seen = new Map<string, number>();
	private lastText = '';
	private lastSent = -Infinity;
	private sweeper = 0;
	private closed = false;

	private constructor(
		private readonly base: string,
		/** A player's latest state, or null when they've left. */
		private readonly onPeer: (id: string, state: PlayerState | null) => void,
		private readonly onStatus: (status: RoomStatus, detail?: string) => void,
	) {}

	/** Joins a room for a game version (any text; made safe here). */
	static async join(realm: string, room: string, onPeer: MultiplayerRoom['onPeer'], onStatus: MultiplayerRoom['onStatus']): Promise<MultiplayerRoom> {
		const self = new MultiplayerRoom(`mapexplorer/${PROTOCOL}/${roomName(realm)}/${roomName(room)}/p/`, onPeer, onStatus);
		onStatus('connecting');
		// Loaded only when someone joins: it's most of a megabyte nobody exploring alone needs.
		const { connect } = await import('mqtt');
		const url = new URLSearchParams(location.search).get('mqtt') || DEFAULT_BROKER;
		const mine = self.base + self.id;
		const client = connect(url, {
			clientId: `mx_${self.id}`,
			clean: true,
			connectTimeout: 15000,
			reconnectPeriod: 4000,
			keepalive: 30,
			will: { topic: mine, payload: '', qos: 0, retain: false },
		});
		self.client = client;
		client.on('connect', () => {
			client.subscribe(self.base + '+', (err) => self.onStatus(err ? 'offline' : 'connected', err?.message));
			// Others learn of us at once rather than at the next heartbeat.
			self.lastSent = -Infinity;
		});
		client.on('reconnect', () => self.onStatus('connecting'));
		client.on('offline', () => self.onStatus('offline'));
		client.on('error', (e) => self.onStatus('offline', e.message));
		client.on('message', (topic, payload) => self.receive(topic, payload));
		self.sweeper = window.setInterval(() => self.sweep(), 1000);
		return self;
	}

	private receive(topic: string, payload: Uint8Array): void {
		if (this.closed || !topic.startsWith(this.base)) return;
		const id = topic.slice(this.base.length);
		if (id === this.id || !/^[a-z0-9]{1,16}$/.test(id)) return;
		const state = payload.length ? decodeState(new TextDecoder().decode(payload)) : null;
		if (!payload.length) {
			if (this.seen.delete(id)) this.onPeer(id, null);
			return;
		}
		if (!state) return;
		this.seen.set(id, performance.now());
		this.onPeer(id, state);
	}

	private sweep(): void {
		const now = performance.now();
		for (const [id, at] of this.seen) {
			if (now - at < PEER_TIMEOUT) continue;
			this.seen.delete(id);
			this.onPeer(id, null);
		}
	}

	/** Sends our state when it changed (at most every SEND_EVERY ms) or as a heartbeat; call it often. */
	send(state: PlayerState, now = performance.now()): void {
		const client = this.client;
		if (this.closed || !client?.connected) return;
		const text = encodeState(state);
		const due = text !== this.lastText ? now - this.lastSent >= SEND_EVERY : now - this.lastSent >= HEARTBEAT;
		if (!due) return;
		client.publish(this.base + this.id, text, { qos: 0 });
		this.lastText = text;
		this.lastSent = now;
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
		if (client?.connected) client.publish(this.base + this.id, '', { qos: 0 });
		client?.end(false);
		for (const id of this.seen.keys()) this.onPeer(id, null);
		this.seen.clear();
		this.onStatus('offline');
	}
}
