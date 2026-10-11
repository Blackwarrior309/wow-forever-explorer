import * as THREE from 'three';
import { TILE_SIZE } from '../formats/adt';
import type { LockKind } from '../explorer/clientDb';
import type { SpawnFile } from '../explorer/spawns';
import type { TintMode } from './regionOverlay';
import type { ContinentPlacement } from './terrain';
import { behindCamera } from './screen';

/** Kinds of things on the ground that can be picked out all at once. */
export type HighlightGroup = 'chest' | 'herb' | 'ore' | 'fishing' | 'stone';

export interface HighlightSettings {
	on: boolean;
	groups: HighlightGroup[];
	/** Also any object or NPC whose name contains this (any case); empty for none. */
	query: string;
	/** Tint terrain and buildings by whether their slopes can be walked on (see walkable.ts). */
	walkable: boolean;
	/** Draw the collision that has nothing drawn on it (see invisibleWalls.ts). */
	walls: boolean;
	/** What the ground is tinted by (see regionOverlay.ts); '' for nothing. */
	tint: TintMode | '';
	/** The player level creature levels are coloured for. */
	level: number;
	/** The inns and cities where resting builds up (see restedAreas.ts). */
	rested: boolean;
}

/** A spawn that can be highlighted, in continent space (before the map's offset in the world). */
interface Target {
	name: string;
	/** Lower case, for matching the query. */
	key: string;
	group: HighlightGroup | null;
	x: number;
	y: number;
	z: number;
}

interface Marker {
	target: Target;
	/** Found by name rather than by kind. */
	named: boolean;
	position: THREE.Vector3;
	distance: number;
}

const MAP_ORIGIN = 32 * TILE_SIZE;
/** gameobject_template types. */
const TYPE_CHEST = 3;
const TYPE_MEETING_STONE = 23;
const TYPE_FISHING_HOLE = 25;
/**
 * Chest-type objects that are treasure rather than quest items (crates of food, barrels of
 * milk, ...), which share the type. Lockpickable ones always count.
 */
const TREASURE = /chest|footlocker|strongbox|lockbox|coffer|trunk|locker|cache/i;
/** Yards; kinds show within this distance. Name matches show at any distance on the map. */
const RANGE = 1000;
const MAX_MARKERS = 150;
/** The nearest this many markers get their name and distance. */
const LABELLED = 12;
/** Yards above the spawn point to put the marker, so it isn't half in the ground. */
const LIFT = 1;

/**
 * Markers over chests, herbs, ore veins, fishing pools, meeting stones, or anything found by name, seen
 * through terrain and buildings from up to a kilometre away. They come from the map's whole
 * spawn file, not just the tiles loaded around the camera. The spawn data lists every place a
 * node can appear, while the server only fills some of them at a time.
 */
export class Highlights {
	private settings: HighlightSettings = { on: false, groups: [], query: '', walkable: false, walls: false, tint: '', level: 20, rested: false };
	private readonly maps = new Map<number, Target[] | 'pending' | null>();
	private readonly pool: HTMLDivElement[] = [];
	private readonly projected = new THREE.Vector3();
	private markers: Marker[] = [];
	private lastScan = 0;
	private dirty = true;
	private locks: Record<number, LockKind> | null = null;
	/** Matches on the current map in the last scan. */
	private matched = 0;

	constructor(private readonly container: HTMLElement, locks: Promise<Record<number, LockKind>>) {
		locks.then((l) => {
			this.locks = l;
			// Maps read before the locks were known have no herbs or ore yet.
			this.maps.clear();
			this.dirty = true;
		}, (e) => console.warn('Lock types unavailable; herbs and ore look like chests:', e));
	}

	/** How many matched on this map and how many are marked, for the panel. */
	get status(): string {
		if (!this.active) return '';
		if (!this.matched) return 'None on this map';
		return `${this.markers.length.toLocaleString()} marked of ${this.matched.toLocaleString()} on this map`;
	}

	set(settings: HighlightSettings): void {
		this.settings = { ...settings, query: settings.query.trim().toLowerCase() };
		this.dirty = true;
	}

	private get active(): boolean {
		const s = this.settings;
		return s.on && (s.groups.length > 0 || s.query.length > 0);
	}

	/** Rescans a few times a second (or on a settings change); re-projects every frame. */
	update(now: number, camera: THREE.PerspectiveCamera, placement: ContinentPlacement | null, width: number, height: number): void {
		if (!this.active || !placement) {
			this.matched = 0;
			this.markers.length = 0;
			this.hideFrom(0);
			return;
		}
		if (this.dirty || now - this.lastScan > 250) {
			this.lastScan = now;
			this.dirty = false;
			this.scan(camera.position, placement);
		}
		const cam = camera.position;
		for (const m of this.markers) m.distance = m.position.distanceTo(cam);
		// Names searched for are labelled first, then the nearest.
		this.markers.sort((a, b) => Number(b.named) - Number(a.named) || a.distance - b.distance);
		let shown = 0;
		for (const m of this.markers) {
			this.projected.copy(m.position).project(camera);
			if (behindCamera(this.projected, camera) || Math.abs(this.projected.x) > 1.05 || Math.abs(this.projected.y) > 1.05) continue;
			const el = this.element(shown);
			const [name, distance] = el.children as unknown as [HTMLElement, HTMLElement];
			const labelled = shown < LABELLED;
			shown++;
			const nameText = labelled ? m.target.name : '';
			if (name.textContent !== nameText) name.textContent = nameText;
			distance.textContent = labelled ? `${m.distance.toFixed(0)} yd` : '';
			el.dataset.group = m.named ? 'named' : m.target.group!;
			const x = (this.projected.x * 0.5 + 0.5) * width;
			const y = (-this.projected.y * 0.5 + 0.5) * height;
			el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
			el.style.opacity = String(1 - 0.5 * Math.min(1, m.distance / RANGE));
			el.hidden = false;
		}
		this.hideFrom(shown);
	}

	private scan(camera: THREE.Vector3, placement: ContinentPlacement): void {
		const targets = this.targets(placement.mapId);
		this.markers.length = 0;
		this.matched = 0;
		if (!targets) return;
		const { groups, query } = this.settings;
		const ox = placement.offsetX * TILE_SIZE;
		const oz = placement.offsetY * TILE_SIZE;
		const named: Marker[] = [];
		const kinds: Marker[] = [];
		for (const t of targets) {
			const byName = query.length > 0 && t.key.includes(query);
			if (!byName && !(t.group && groups.includes(t.group))) continue;
			this.matched++;
			const dx = t.x + ox - camera.x, dy = t.y - camera.y, dz = t.z + oz - camera.z;
			const d2 = dx * dx + dy * dy + dz * dz;
			if (!byName && d2 > RANGE * RANGE) continue;
			(byName ? named : kinds).push({ target: t, named: byName, position: new THREE.Vector3(t.x + ox, t.y, t.z + oz), distance: Math.sqrt(d2) });
		}
		// What was searched for by name comes first, however far; the nearest kinds fill the rest.
		const nearest = (list: Marker[], n: number) => list.sort((a, b) => a.distance - b.distance).slice(0, Math.max(0, n));
		const first = nearest(named, MAX_MARKERS);
		this.markers = first.concat(nearest(kinds, MAX_MARKERS - first.length));
	}

	/** A map's highlightable spawns, read on first use (null until read, or if it has none). */
	private targets(mapId: number): Target[] | null {
		const known = this.maps.get(mapId);
		if (known !== undefined) return known === 'pending' ? null : known;
		this.maps.set(mapId, 'pending');
		fetch(`spawns/map${mapId}.json`)
			.then((r) => (r.ok ? (r.json() as Promise<SpawnFile>) : null))
			.then((file) => {
				// The lock types arrived meanwhile and cleared the cache: the next scan reads it again.
				if (this.maps.get(mapId) !== 'pending') return;
				this.maps.set(mapId, file ? this.read(file) : null);
				this.dirty = true;
			}, (e) => {
				console.warn(`Spawns for map ${mapId}:`, e);
				this.maps.set(mapId, null);
			});
		return null;
	}

	private read(file: SpawnFile): Target[] {
		const out: Target[] = [];
		// WoW world (x north, y west, z up) -> continent space, as for the spawns themselves.
		const add = (name: string, group: HighlightGroup | null, x: number, y: number, z: number) =>
			out.push({ name, key: name.toLowerCase(), group, x: MAP_ORIGIN - y, y: z + LIFT, z: MAP_ORIGIN - x });
		const groups = new Map<number, HighlightGroup | null>();
		for (const [entry, [name, type, , , data0]] of Object.entries(file.objects.templates)) {
			groups.set(Number(entry), this.groupOf(name, type, data0));
		}
		for (const [, entry, x, y, z] of file.objects.spawns) {
			const t = file.objects.templates[entry];
			if (t) add(t[0], groups.get(entry) ?? null, x, y, z);
		}
		for (const [, entry, x, y, z] of file.creatures.spawns) {
			const t = file.creatures.templates[entry];
			if (t) add(t[0], null, x, y, z);
		}
		return out;
	}

	/** Chests' data0 is their lock, which says whether it takes Herbalism, Mining or Lockpicking. */
	private groupOf(name: string, type: number, data0: number): HighlightGroup | null {
		if (type === TYPE_FISHING_HOLE) return 'fishing';
		if (type === TYPE_MEETING_STONE) return 'stone';
		if (type !== TYPE_CHEST) return null;
		const lock = this.locks?.[data0];
		if (lock === 'herb') return 'herb';
		if (lock === 'ore') return 'ore';
		return lock === 'lockbox' || TREASURE.test(name) ? 'chest' : null;
	}

	private element(i: number): HTMLDivElement {
		let el = this.pool[i];
		if (!el) {
			el = document.createElement('div');
			el.className = 'beacon';
			const name = document.createElement('span');
			name.className = 'beacon-name';
			const distance = document.createElement('span');
			distance.className = 'beacon-distance';
			el.append(name, distance);
			// Under the name plates, which are closer and more important.
			this.container.prepend(el);
			this.pool[i] = el;
		}
		return el;
	}

	private hideFrom(i: number): void {
		for (; i < this.pool.length; i++) if (!this.pool[i].hidden) this.pool[i].hidden = true;
	}
}
