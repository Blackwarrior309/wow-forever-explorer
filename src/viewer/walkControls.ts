import * as THREE from 'three';
import { lookPerPixel } from './look';
import { isTyping } from './typing';
import { WALKABLE } from './walkable';

/** Speeds in yards per second, as in the original game. */
export const RUN_SPEED = 7;
export const WALK_SPEED = 2.5;
export const BACK_SPEED = 4.5;
export const SWIM_SPEED = 4.72;
export const SWIM_BACK_SPEED = 2.5;
/** Turning with the keys, radians per second: half a turn a second. */
const TURN_RATE = Math.PI;
/** The emulators' jump: upward speed at take-off, gravity and the fastest fall (yd/s, yd/s²). */
const JUMP_SPEED = 7.96;
const GRAVITY = 19.29;
const TERMINAL_SPEED = 60;
/** Ledges up to this high are stepped up without jumping (yards). */
const STEP_UP = 1;
/**
 * Walls are felt for at heights from the knees to the head at most this far apart (yards), and
 * at no more than this many heights, for the tallest forms.
 */
const WALL_PROBE_GAP = 0.25;
const WALL_PROBES_MAX = 16;
/** Ground up to this far below is followed down (slopes, stairs) rather than fallen to. */
const SNAP_DOWN = 1.2;
/** How quickly a slide down a too-steep slope picks up speed, as a share of gravity along it. */
const SLIDE_GRIP = 0.8;
/** The character's size at scale 1 (a human): capsule radius and height, yards. */
const RADIUS = 0.4;
const HEIGHT = 2;
/**
 * Water deeper than this share of the height is swum in, with the feet this share below the
 * surface while swimming (head and shoulders out).
 */
const SWIM_DEPTH = 0.65;
const SWIM_FLOAT = 0.75;
/**
 * Swimming starts this much deeper than SWIM_DEPTH and stops this much shallower (yards), so
 * wading along that depth over a bumpy bottom doesn't flicker between the two.
 */
const SWIM_BAND = 0.12;
/** Rising and sinking in water (Space, X), yd/s. */
const SWIM_RISE = 4;
/** Out of the water, a shore up to this far above the surface can be climbed onto. */
const SHORE_CLIMB = 0.6;

/** A press that moves the mouse further than this (pixels) is a drag, not a click. */
const DRAG_THRESHOLD = 4;
/** ms before asking again to hide the mouse when the browser refused (still showing it from the last press). */
const CAPTURE_RETRY = 100;
/** The bit in MouseEvent.buttons for each MouseEvent.button: left, middle, right, back, forward. */
const BUTTON_BITS = [1, 4, 2, 8, 16];

const MAX_PITCH = THREE.MathUtils.degToRad(87);
/** Camera distance from the head: closest, furthest and to start with (yards). */
const MIN_ZOOM = 1;
const MAX_ZOOM = 35;
const START_ZOOM = 9;
/** Each wheel notch moves the camera this many times nearer or further. */
const ZOOM_STEP = 1.2;
/** The camera stops this far in front of a wall or the ground between it and the character. */
const CAMERA_GAP = 0.6;
/** How quickly the camera eases back out once nothing's in the way (1/e of the way per 1/rate s). */
const CAMERA_EASE_OUT = 3;
/** The camera looks at this share of the height above the feet: about the top of the head. */
const EYE = 0.9;
/** How long a newly placed character waits for its ground to load before falling anyway (s). */
const SETTLE_TIMEOUT = 15;
/**
 * Falling this long means there was nothing under it after all (a gap the game's data leaves
 * open, or ground not loaded): it's put back where it last stood (s).
 */
const LOST_FALL = 8;

/** What the character stands on, the surface's normal (pointing up), and a building's TerrainType (null for the terrain). */
interface Floor {
	y: number;
	normal: THREE.Vector3;
	ground: number | null;
}

/** What the walking character collides with and stands on; the viewer supplies it. */
export interface WalkWorld {
	/** Terrain height; -Infinity over holes (cave and mine entrances) and off the map. */
	terrain(x: number, z: number): number;
	/** Terrain surface ignoring holes: what counts as above or below ground. */
	surface(x: number, z: number): number;
	/** Whether the terrain there has loaded in full detail. */
	ready(x: number, z: number): boolean;
	/** Whether a building's bounds come within margin of a point (else casts can be skipped). */
	nearBuilding(at: THREE.Vector3, margin: number): boolean;
	/** Nearest building surface along a ray, within far. */
	cast(from: THREE.Vector3, direction: THREE.Vector3, far: number): { distance: number; normal: THREE.Vector3; ground: number } | null;
	/** A move across cut short so it keeps radius from building walls, sliding along them as if upright. */
	sweep(from: THREE.Vector3, move: THREE.Vector3, radius: number): THREE.Vector3;
	/** How far to move a point so no wall is within radius of it horizontally. */
	pushOut(at: THREE.Vector3, radius: number): THREE.Vector3;
	/** The liquid surface over a point, if it's under one, and whether that's the open sea. */
	liquid(at: THREE.Vector3): { surface: number; sea: boolean } | null;
}

export type WalkState = 'settling' | 'ground' | 'air' | 'swim';

/** Shortest signed difference between two angles. */
export function angleDelta(from: number, to: number): number {
	return THREE.MathUtils.euclideanModulo(to - from + Math.PI, Math.PI * 2) - Math.PI;
}

const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);

/**
 * A character on foot, moved as in World of Warcraft, with a camera orbiting behind it. W/S run
 * and backpedal, A/D turn (strafe while the right button is held), Q/E strafe, Space jumps; the
 * mouse turns the camera, and with the right button held the character too; the wheel zooms.
 * As in the game, the mouse stays shown, and is hidden only while turning: dragging with the
 * left button turns the camera, and holding the right button turns the character too.
 */
export class WalkControls {
	/** Feet, in world space. */
	readonly position = new THREE.Vector3();
	/** Which way the character faces: the same angle as the camera's yaw (0 north, turning west). */
	facing = 0;
	/** The camera's turn away from behind the character, and its pitch. */
	private orbit = 0;
	pitch = -0.25;
	private zoom = START_ZOOM;
	private zoomTarget = START_ZOOM;
	/** Where the camera is after walls and the ground pull it in. */
	private distance = START_ZOOM;
	readonly velocity = new THREE.Vector3();
	state: WalkState = 'settling';
	private settleTime = 0;
	/** Where it last stood on the ground, and facing which way, to be put back after a fall into nothing. */
	private readonly lastStand = new THREE.Vector3();
	private lastStandFacing = 0;
	private hasStood = false;
	/** Walking rather than running (the walk key toggles). */
	walkMode = false;
	/** On a slope too steep to stand on: sliding down it. */
	sliding = false;
	/** Seconds since leaving the ground, and whether that was a jump. */
	airTime = 0;
	jumped = false;
	/** The movement asked for, relative to the facing: forward (+1 / -1 back) and right (+1 / -1 left). */
	readonly intent = new THREE.Vector2();
	/** Turning with the keys: +1 left, -1 right, 0 not. */
	turning = 0;
	/** Horizontal speed over the ground at the last update. */
	speed = 0;
	/** The speed the keys ask for (running against a wall, the feet still run at it). */
	moveSpeed = 0;
	/** What it's standing on, for footsteps: a building's TerrainType, or null on the terrain. */
	ground: number | null = null;
	/** Scale of the character (its race): size and how near walls it can go. */
	scale = 1;
	private readonly keys = new Set<string>();
	private buttons = 0;
	/** Whether a mouse button went down on the view (so an uncaptured drag turns the camera). */
	private dragging = false;
	active = false;
	world: WalkWorld | null = null;

	constructor(
		private readonly camera: THREE.PerspectiveCamera,
		private readonly element: HTMLElement,
	) {
		element.addEventListener('mousedown', (e) => {
			if (!this.active) return;
			this.dragging = true;
			this.dragged = 0;
			this.buttons = e.buttons;
			// Taking hold with the right button turns the character to where the camera looks, and
			// hides the mouse while it's held (as in the game), so it can turn without running out of screen.
			if (e.button === 2) {
				this.faceCamera();
				this.capture();
			}
		});
		window.addEventListener('mouseup', (e) => {
			this.buttons &= ~(BUTTON_BITS[e.button] ?? 0);
			// The mouse shows again once neither button is held.
			if (!(this.buttons & 3)) {
				this.dragging = false;
				this.release();
			}
		});
		element.addEventListener('contextmenu', (e) => {
			if (this.active) e.preventDefault();
		});
		document.addEventListener('mousemove', (e) => {
			if (!this.active) return;
			// While the mouse is hidden every mouseup is heard, and Firefox on Linux reports no buttons
			// held on its moves then, so only the presses and lets go say what's held.
			if (document.pointerLockElement !== element) this.buttons = e.buttons;
			// Only while a button is held: left turns the camera, right the character too.
			if (!(this.dragging && this.buttons & 3)) {
				// The button came up somewhere it wasn't heard: show the mouse again.
				if (this.dragging) {
					this.dragging = false;
					this.release();
				}
				return;
			}
			// The first movement after the mouse is hidden or shown is the browser moving it there, not the hand.
			if (this.skipMove) {
				this.skipMove = false;
				return;
			}
			// See FlyControls: now and then a bogus jump comes through.
			if (Math.abs(e.movementX) > window.innerWidth / 3 || Math.abs(e.movementY) > window.innerHeight / 3) return;
			this.dragged += Math.abs(e.movementX) + Math.abs(e.movementY);
			// A left press that turns into a drag hides the mouse too; a plain click leaves it be.
			if (this.wasDrag) this.capture();
			const turn = -e.movementX * lookPerPixel();
			if (this.steering) this.facing += turn;
			else this.orbit += turn;
			this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * lookPerPixel(), -MAX_PITCH, MAX_PITCH);
		});
		element.addEventListener('wheel', (e) => {
			if (!this.active) return;
			e.preventDefault();
			this.zoomTarget = THREE.MathUtils.clamp(this.zoomTarget * ZOOM_STEP ** Math.sign(e.deltaY), MIN_ZOOM, MAX_ZOOM);
		}, { passive: false });
		window.addEventListener('keydown', (e) => {
			if (!this.active || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
			this.keys.add(e.code);
			if (e.code === 'Space') e.preventDefault();
			if ((e.code === 'NumpadDivide' || e.code === 'Backslash') && !e.repeat) this.walkMode = !this.walkMode;
		});
		window.addEventListener('keyup', (e) => this.keys.delete(e.code));
		window.addEventListener('blur', () => {
			this.keys.clear();
			this.buttons = 0;
			this.dragging = false;
			this.release();
		});
		document.addEventListener('pointerlockchange', () => {
			const asked = this.requesting;
			this.requesting = false;
			this.skipMove = true;
			const locked = document.pointerLockElement === element;
			// Hidden for walking only once flying again: show it, rather than leave flying turned by it.
			if (!this.active) {
				if (asked && locked) document.exitPointerLock();
				return;
			}
			// Let go before the hiding took (a quick click): show it again.
			if (locked && !this.dragging) this.release();
			// Asked again while the last showing was still under way, which the browser refuses: ask now it's done.
			else if (!locked && this.dragging && this.wantHidden) this.capture();
		});
		document.addEventListener('pointerlockerror', () => {
			this.requesting = false;
		});
	}

	/** A request to hide the mouse is under way. */
	private requesting = false;
	/** The mouse should be hidden (a button is turning the view). */
	private wantHidden = false;
	/** Skip the next movement: the jump from hiding or showing the mouse. */
	private skipMove = false;

	/** Pixels the mouse has moved since a button went down on the view. */
	private dragged = 0;

	/** Whether the last press on the view turned the camera rather than clicked (so it shouldn't select what's under it). */
	get wasDrag(): boolean {
		return this.dragged > DRAG_THRESHOLD;
	}

	/**
	 * Hides the mouse while a button turns the view, asking the browser once (asking again while
	 * a request is under way only gets refused). The plain kind, not the raw movement flying uses:
	 * switching raw input on and off with every press makes the browser stall.
	 */
	private capture(): void {
		this.wantHidden = true;
		if (document.pointerLockElement === this.element || this.requesting) return;
		this.requesting = true;
		const request = this.element.requestPointerLock() as Promise<void> | undefined;
		// Refused (an earlier showing still under way): pointerlockchange asks again once it's done,
		// or, if that came first, ask again in a moment.
		request?.catch?.(() => {
			this.requesting = false;
			setTimeout(() => {
				if (this.active && this.dragging && this.wantHidden) this.capture();
			}, CAPTURE_RETRY);
		});
	}

	private release(): void {
		this.wantHidden = false;
		if (document.pointerLockElement === this.element) document.exitPointerLock();
	}


	/** The right button is held: the mouse turns the character, and A/D strafe. */
	private get steering(): boolean {
		return (this.buttons & 2) !== 0;
	}

	private faceCamera(): void {
		this.facing += this.orbit;
		this.orbit = 0;
	}

	/** The camera's yaw: behind the character, turned by the orbit. */
	get yaw(): number {
		return this.facing + this.orbit;
	}

	/** The camera's turn from behind the character and how far back it is zoomed, for aim. */
	get aim(): { orbit: number; zoom: number } {
		return { orbit: this.orbit, zoom: this.zoomTarget };
	}

	/** Turns and zooms the camera at once, as aim gave them (after place, which resets them). */
	set aim({ orbit, zoom }: { orbit: number; zoom: number }) {
		this.orbit = orbit;
		this.zoom = this.zoomTarget = this.distance = THREE.MathUtils.clamp(zoom, MIN_ZOOM, MAX_ZOOM);
		this.updateCamera(0);
	}

	/** Capsule radius and height for the character's size. */
	get radius(): number {
		return RADIUS * this.scale;
	}

	get height(): number {
		return HEIGHT * this.scale;
	}

	/** Whether the camera is so close the character would fill the view (it's hidden then). */
	get firstPerson(): boolean {
		return this.distance < MIN_ZOOM * 0.9;
	}

	/**
	 * Puts the character's feet at a point, facing a way, with the camera behind it. It holds
	 * still until the ground there has loaded, then stands on what's under it, or with drop,
	 * falls to it.
	 */
	place(feet: THREE.Vector3, facing: number, pitch = this.pitch, drop = false): void {
		this.dropping = drop;
		this.position.copy(feet);
		this.facing = facing;
		this.orbit = 0;
		this.pitch = THREE.MathUtils.clamp(pitch, -MAX_PITCH, MAX_PITCH);
		this.velocity.set(0, 0, 0);
		this.state = 'settling';
		this.settleTime = 0;
		this.hasStood = false;
		this.sliding = false;
		this.airTime = 0;
		this.jumped = false;
		this.distance = this.zoom = this.zoomTarget;
		this.updateCamera(0);
	}

	/** Puts the character's head where the camera is, facing its way, to fall from there to the ground. */
	dropFrom(eye: THREE.Vector3, facing: number): void {
		this.place(eye.clone().setY(eye.y - this.height * EYE), facing, this.pitch, true);
	}

	/** Set by place: once its ground has loaded, the character falls to it rather than being put on it. */
	private dropping = false;

	/** Starts: takes the keys and mouse. */
	start(): void {
		this.active = true;
		this.keys.clear();
		// Walking, the mouse is shown, and hidden only while the right button is held.
		this.release();
	}

	stop(): void {
		this.active = false;
		this.keys.clear();
		this.buttons = 0;
		this.dragging = false;
		this.release();
	}

	/**
	 * The highest floor between top and bottom at x, z: the terrain, or a building's floor found
	 * by casting down. Null when there's none in that range.
	 */
	floorAt(x: number, z: number, top: number, bottom: number): Floor | null {
		const world = this.world!;
		let best: Floor | null = null;
		const t = world.terrain(x, z);
		if (t <= top && t >= bottom) best = { y: t, normal: this.terrainNormal(x, z), ground: null };
		const from = new THREE.Vector3(x, top, z);
		const reach = top - bottom;
		if (reach > 0 && world.nearBuilding(from, reach + 1)) {
			const hit = world.cast(from, DOWN, reach);
			if (hit && (!best || top - hit.distance > best.y)) {
				// Two-sided surfaces can be hit from their back: the floor's normal points up either way.
				const normal = hit.normal.clone();
				if (normal.y < 0) normal.negate();
				best = { y: top - hit.distance, normal, ground: hit.ground };
			}
		}
		return best;
	}

	/** The terrain's slope at a point, from its heights either side (holes ignored). */
	private terrainNormal(x: number, z: number): THREE.Vector3 {
		const s = this.world!;
		const e = 0.5;
		const dx = (s.surface(x + e, z) - s.surface(x - e, z)) / (2 * e);
		const dz = (s.surface(x, z + e) - s.surface(x, z - e)) / (2 * e);
		return new THREE.Vector3(-dx, 1, -dz).normalize();
	}

	/** The way the keys (and mouse buttons) ask to move, relative to the facing; also turns with A/D. */
	private readInput(dt: number): void {
		const k = this.keys;
		const both = (this.buttons & 3) === 3;
		let forward = 0;
		let right = 0;
		let turn = 0;
		if (k.has('KeyW') || k.has('ArrowUp') || both) forward += 1;
		if (k.has('KeyS') || k.has('ArrowDown')) forward -= 1;
		if (k.has('KeyE')) right += 1;
		if (k.has('KeyQ')) right -= 1;
		const left = k.has('KeyA') || k.has('ArrowLeft');
		const rightKey = k.has('KeyD') || k.has('ArrowRight');
		// A/D turn, or strafe while the right button is held (the arrows always turn).
		if (this.steering) {
			if (k.has('KeyA')) right -= 1;
			if (k.has('KeyD')) right += 1;
			if (k.has('ArrowLeft')) turn += 1;
			if (k.has('ArrowRight')) turn -= 1;
		} else {
			if (left) turn += 1;
			if (rightKey) turn -= 1;
		}
		this.intent.set(Math.sign(forward), THREE.MathUtils.clamp(right, -1, 1));
		this.turning = Math.sign(turn);
		const turned = this.turning * TURN_RATE * dt;
		this.facing += turned;
		// The camera keeps behind the character as it turns, except while the left button holds it
		// where it's been put: then only the character turns.
		if (this.dragging && this.buttons & 1 && !this.steering) this.orbit -= turned;
	}

	/** Horizontal velocity for the keys: forward, back and sideways at their speeds, for running, walking or swimming. */
	private wantedVelocity(swimming: boolean): THREE.Vector3 {
		const { x: forward, y: right } = this.intent;
		const out = new THREE.Vector3();
		this.moveSpeed = 0;
		if (!forward && !right) return out;
		const speed = swimming
			? forward < 0 ? SWIM_BACK_SPEED : SWIM_SPEED
			: this.walkMode ? WALK_SPEED : forward < 0 ? BACK_SPEED : RUN_SPEED;
		const f = this.facing;
		out.set(-Math.sin(f) * forward + Math.cos(f) * right, 0, -Math.cos(f) * forward - Math.sin(f) * right);
		this.moveSpeed = speed;
		return out.normalize().multiplyScalar(speed);
	}

	update(dt: number): void {
		const world = this.world;
		if (!world || dt <= 0) return;
		this.readInput(dt);
		const before = this.position.clone();
		switch (this.state) {
			case 'settling':
				this.settle(dt);
				break;
			case 'ground':
				this.walk(dt);
				break;
			case 'air':
				this.fall(dt);
				break;
			case 'swim':
				this.swim(dt);
				break;
		}
		this.speed = dt > 0 ? Math.hypot(this.position.x - before.x, this.position.z - before.z) / dt : 0;
		this.updateCamera(dt);
	}

	/** Holds still until the ground under the character has loaded, then stands on it. */
	private settle(dt: number): void {
		const p = this.position;
		this.settleTime += dt;
		const timedOut = this.settleTime > SETTLE_TIMEOUT;
		if (!this.world!.ready(p.x, p.z) && !timedOut) return;
		if (this.dropping) {
			// Already down on something (the camera was at the ground): stand; else fall to it.
			const under = this.floorAt(p.x, p.z, p.y + 1.5, p.y - 0.3);
			if (under) {
				p.y = under.y;
				this.state = 'ground';
			} else {
				this.leaveGround(false);
			}
			return;
		}
		// The floor it was put on, or the one under it; failing those, the detailed ground a little
		// above (the coarse ground it was put on can sit below it), but not the storey above.
		const floor = this.floorAt(p.x, p.z, p.y + 1.5, p.y - 50) ?? this.floorAt(p.x, p.z, p.y + 5, p.y - 50);
		if (floor) {
			p.y = floor.y;
			this.state = 'ground';
		} else if (timedOut) {
			this.leaveGround(false);
		}
	}

	/**
	 * Moves horizontally by move, stopped and slid along by building walls anywhere from the
	 * knees to the head (ledges below the knees are stepped up instead). The body is felt at
	 * heights no more than WALL_PROBE_GAP apart, so a beam, rail or sill between two of them
	 * can't be walked through, and again after a slide at one height until none changes the
	 * move, so sliding off one wall can't take it into another at a height already felt.
	 */
	private moveAcross(move: THREE.Vector3): void {
		const world = this.world!;
		const p = this.position;
		const r = this.radius;
		const length = move.length();
		if (length < 1e-6) return;
		const middle = p.clone().setY(p.y + this.height * 0.5);
		if (world.nearBuilding(middle, length + this.height + r)) {
			const low = STEP_UP + 0.1;
			const high = Math.max(low, this.height - 0.1);
			const probes = Math.min(WALL_PROBES_MAX, Math.ceil((high - low) / WALL_PROBE_GAP) + 1);
			const from = new THREE.Vector3();
			for (let round = 0; round < 3; round++) {
				let changed = false;
				for (let i = 0; i < probes; i++) {
					from.set(p.x, p.y + (probes > 1 ? low + ((high - low) * i) / (probes - 1) : low), p.z);
					const next = world.sweep(from, move, r);
					next.y = 0;
					if (next.distanceToSquared(move) > 1e-12) changed = true;
					move = next;
				}
				if (!changed) break;
			}
			p.add(move);
			// Keep off walls slid along at an angle.
			const out = world.pushOut(p.clone().setY(p.y + this.height * 0.5), r);
			p.x += out.x;
			p.z += out.z;
		} else {
			p.add(move);
		}
	}

	/**
	 * Whether a move from start ran into the side of the terrain: ground higher than top where it
	 * was standing above the ground (underground, in a cave, the terrain is overhead and doesn't count).
	 */
	private intoTerrain(start: THREE.Vector3, top: number): boolean {
		const world = this.world!;
		const p = this.position;
		return world.terrain(p.x, p.z) > top && start.y >= world.surface(start.x, start.z) - 0.5;
	}

	/** Down the slope: the horizontal part of a floor's normal, normalised. */
	private static downhill(normal: THREE.Vector3): THREE.Vector3 {
		const d = new THREE.Vector3(normal.x, 0, normal.z);
		return d.lengthSq() > 1e-8 ? d.normalize() : d;
	}

	/** On the ground: runs, steps up and down, slides off steep slopes, jumps, walks off edges and into water. */
	private walk(dt: number): void {
		const p = this.position;
		const want = this.wantedVelocity(false);
		const here = this.floorAt(p.x, p.z, p.y + 0.1, p.y - 0.5);
		this.sliding = !!here && here.normal.y < WALKABLE;
		if (this.sliding) {
			// Too steep to stand on: slide down it, faster and faster, and the keys can't take you up it.
			const down = WalkControls.downhill(here!.normal);
			const sin = Math.sqrt(1 - here!.normal.y ** 2);
			const along = this.velocity.dot(down);
			this.velocity.copy(down).multiplyScalar(Math.max(0, along) + GRAVITY * sin * SLIDE_GRIP * dt);
			const up = want.dot(down);
			if (up < 0) want.addScaledVector(down, -up);
			want.add(this.velocity);
		} else {
			this.velocity.copy(want);
		}
		if (this.keys.has('Space') && !this.sliding) {
			this.velocity.copy(want);
			this.velocity.y = JUMP_SPEED;
			this.leaveGround(true);
			this.fall(dt);
			return;
		}

		const start = p.clone();
		this.moveAcross(want.clone().multiplyScalar(dt));
		if (this.intoTerrain(start, start.y + STEP_UP)) p.copy(start);
		let floor = this.floorAt(p.x, p.z, start.y + STEP_UP, start.y - SNAP_DOWN);
		// Walking up into ground too steep to stand on: only the part of the move along or down the slope goes.
		if (floor && floor.normal.y < WALKABLE && floor.y > start.y + 0.05) {
			const down = WalkControls.downhill(floor.normal);
			const move = p.clone().sub(start).setY(0);
			const into = move.dot(down);
			if (into < 0) move.addScaledVector(down, -into);
			p.copy(start);
			this.moveAcross(move);
			floor = this.floorAt(p.x, p.z, start.y + STEP_UP, start.y - SNAP_DOWN);
			if (floor && floor.normal.y < WALKABLE && floor.y > start.y + 0.05) {
				p.copy(start);
				floor = here;
			}
		}
		if (!floor) {
			// Walked off an edge (or into a hole): fall, carrying on the way it was going.
			this.velocity.set((p.x - start.x) / dt, 0, (p.z - start.z) / dt);
			this.leaveGround(false);
			return;
		}
		p.y = floor.y;
		this.ground = floor.ground;
		if (!this.sliding) {
			this.lastStand.copy(p);
			this.lastStandFacing = this.facing;
			this.hasStood = true;
		}
		const water = this.world!.liquid(p);
		if (water && water.surface - p.y > SWIM_DEPTH * this.height + SWIM_BAND) this.startSwimming();
	}

	private leaveGround(jumped: boolean): void {
		this.state = 'air';
		this.airTime = 0;
		this.jumped = jumped;
		this.sliding = false;
	}

	/** In the air: keeps the speed it left the ground with, falls, and lands (or splashes down). */
	private fall(dt: number): void {
		const p = this.position;
		this.airTime += dt;
		if (this.airTime > LOST_FALL && this.hasStood) {
			this.place(this.lastStand, this.lastStandFacing);
			return;
		}
		const v = this.velocity;

		v.y = Math.max(v.y - GRAVITY * dt, -TERMINAL_SPEED);
		const start = p.clone();
		this.moveAcross(new THREE.Vector3(v.x * dt, 0, v.z * dt));
		if (this.intoTerrain(start, start.y + STEP_UP * 0.5)) p.copy(start);
		// A wall in the way takes that speed away.
		if (dt > 0) {
			v.x = (p.x - start.x) / dt;
			v.z = (p.z - start.z) / dt;
		}
		let y = p.y + v.y * dt;
		if (v.y > 0) {
			// The head hits a ceiling.
			const head = p.clone().setY(p.y + this.height);
			if (this.world!.nearBuilding(head, v.y * dt + 1)) {
				const hit = this.world!.cast(head, UP, v.y * dt + 0.05);
				if (hit) {
					y = p.y + Math.max(0, hit.distance - 0.05);
					v.y = 0;
				}
			}
		}
		const top = Math.max(p.y, y) + (v.y <= 0 ? STEP_UP * 0.5 : 0.1);
		const floor = this.floorAt(p.x, p.z, top, Math.min(p.y, y) - 0.01);
		if (floor && (v.y <= 0 || floor.y >= y)) {
			y = Math.max(y, floor.y);
			if (v.y <= 0) {
				p.y = y;
				this.state = 'ground';
				this.velocity.y = 0;
				return;
			}
		}
		p.y = y;
		// Still rising (jumped out of the water), it doesn't fall back in until it comes down.
		if (v.y > 0) return;
		const water = this.world!.liquid(p);
		if (water && water.surface - p.y > SWIM_DEPTH * this.height + SWIM_BAND) this.startSwimming();
	}

	private startSwimming(): void {
		this.state = 'swim';
		this.velocity.y = 0;
		this.sliding = false;
	}

	/**
	 * Swimming: at the surface unless sinking (X) or diving (forward while steering with the
	 * camera looking down); Space rises, and at the surface jumps up out of the water (to fall
	 * back in, or onto a ledge). A shallow enough bottom, or a low shore, stands you up.
	 */
	private swim(dt: number): void {
		const p = this.position;
		const water = this.world!.liquid(p);
		const floating = water ? water.surface - SWIM_FLOAT * this.height : -Infinity;
		const want = this.wantedVelocity(true);
		if (this.keys.has('Space') && water && p.y >= floating - 0.05) {
			this.velocity.set(want.x, JUMP_SPEED, want.z);
			this.leaveGround(true);
			this.fall(dt);
			return;
		}
		let rise = 0;
		if (this.keys.has('Space')) rise += SWIM_RISE;
		if (this.keys.has('KeyX')) rise -= SWIM_RISE;
		// Steering, forward follows the camera up and down, as in the game, once under the surface.
		if (this.steering && this.intent.x > 0) {
			const dive = Math.sin(this.pitch) * want.length();
			if (dive < 0 || p.y < floating - 0.05) {
				want.multiplyScalar(Math.cos(this.pitch));
				rise += dive;
			}
		}
		const start = p.clone();
		this.moveAcross(want.clone().multiplyScalar(dt));
		const climb = Math.max(start.y, floating) + SWIM_FLOAT * this.height + SHORE_CLIMB;
		if (this.intoTerrain(start, climb)) p.copy(start);
		this.velocity.set(want.x, rise, want.z);
		let y = Math.min(p.y + rise * dt, floating);
		// The bottom, a bank or a shore: stand on it if the water there is shallow enough.
		const floor = this.floorAt(p.x, p.z, climb, y - 0.01);
		if (floor && floor.y >= y) {
			y = floor.y;
			const depth = water ? water.surface - floor.y : 0;
			// Shallow enough (see SWIM_BAND), and ground that can be stood on, not a steep bank it would slide back off.
			if (depth < SWIM_DEPTH * this.height - SWIM_BAND && floor.normal.y >= WALKABLE) {
				p.y = y;
				this.state = 'ground';
				this.velocity.set(0, 0, 0);
				return;
			}
		}
		// How fast it really goes up or down (held at the surface or on the bottom, not at all), for the animation.
		this.velocity.y = dt > 0 ? (y - p.y) / dt : 0;
		p.y = y;
		if (!water) this.leaveGround(false);
	}

	/** The camera behind and above the character's head, pulled in front of anything in between. */
	private updateCamera(dt: number): void {
		const world = this.world;
		const ease = 1 - Math.exp(-dt * 12);
		this.zoom += (this.zoomTarget - this.zoom) * (dt > 0 ? ease : 1);
		const target = this.position.clone().setY(this.position.y + this.height * EYE);
		const yaw = this.yaw;
		const back = new THREE.Vector3(Math.sin(yaw) * Math.cos(this.pitch), -Math.sin(this.pitch), Math.cos(yaw) * Math.cos(this.pitch));
		let reach = this.zoom;
		if (world) {
			if (world.nearBuilding(target, reach + 1)) {
				const hit = world.cast(target, back, reach + CAMERA_GAP);
				if (hit) reach = Math.min(reach, hit.distance - CAMERA_GAP);
			}
			// The ground, unless the character is underground (in a cave), where it's overhead.
			if (target.y >= world.surface(target.x, target.z)) {
				const step = 0.5;
				for (let d = step; d <= reach + CAMERA_GAP; d += step) {
					const x = target.x + back.x * d;
					const y = target.y + back.y * d;
					const z = target.z + back.z * d;
					if (y < world.terrain(x, z) + 0.3) {
						reach = Math.min(reach, d - CAMERA_GAP);
						break;
					}
				}
			}
		}
		reach = Math.max(0.1, reach);
		// In at once, so nothing hides the character; back out gently.
		if (reach < this.distance || dt <= 0) this.distance = reach;
		else this.distance += (reach - this.distance) * (1 - Math.exp(-dt * CAMERA_EASE_OUT));
		this.camera.position.copy(target).addScaledVector(back, this.distance);
		this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, yaw, 0, 'YXZ'));
	}
}
