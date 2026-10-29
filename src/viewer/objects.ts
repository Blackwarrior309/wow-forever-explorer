import * as THREE from 'three';
import { acceleratedRaycast, MeshBVH } from 'three-mesh-bvh';
import type { ModelData, ObjectKind, Placement } from '../explorer/objects';
import type { SpawnInfo } from '../explorer/spawns';
import type { AsyncStorageApi } from '../worker/protocol';
import { createModelMaterial, createSkinnedDepthMaterial, type SkinUniforms } from './modelMaterials';
import { applyWalkable } from './walkable';
import { UNSEEN_OPACITY, WALL_MATERIAL, WMO_NEAR, bareTriangles, doodadNear, surfaceTree, type IndexRange } from './invisibleWalls';
import { Blend } from '../formats/m2';
import { Mover, type GroundAt } from './movers';
import { perf } from './perf';
import { PARTICLE_RANGE, SHOT_PARTICLE_RANGE, ParticleSystem, type EmitterSource, type LoadedEmitter } from './particles';
import { useShadows, type ShadowRole } from './shadows';
import { liquidMaterial, liquidTime } from './terrainMaterials';
import { FOOTSTEP_RANGE } from './footsteps';
import { TextureCache } from './textureCache';

/** Yards above a creature's head its name sits. */
const NAME_CLEARANCE = 0.35;

/** Where a creature's name goes: model space is z-up, so its head is at (0, 0, height), then a little above. */
export function headPosition(matrix: THREE.Matrix4, height: number, out: THREE.Vector3): THREE.Vector3 {
	out.set(0, 0, height).applyMatrix4(matrix);
	out.y += NAME_CLEARANCE;
	return out;
}

type Kind = ObjectKind;
/** What the View menu can hide: kinds of spawn, or spirit healers among the creatures. */
export type Hideable = 'creature' | 'object' | 'spiritHealer';

// Ray casts use a model's BVH when it has one (buildings); InstancedMesh casts go through this too.
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** Models per worker request; small batches let the nearest models show up sooner. */
const MODEL_BATCH = 8;
const MAX_MODEL_REQUESTS = 4;
/** Unused models stay cached this long, so flying back and forth doesn't reload them. */
const UNUSED_MODEL_TTL = 15000;
/** How often (ms) instance visibility is re-checked against the camera. */
const CULL_INTERVAL = 250;
/** Models smaller than this (radius in yards: crates, fences, people) cast shadows only in the near cascade. */
const SMALL_CASTER = 3;
/** Creatures further than this (yards) from the camera stand still. */
const MOVE_RANGE = 300;

/** The nearest and furthest the detail distance can be set, as a multiple of the usual. */
export const DETAIL_RANGE_MIN = 0.25;
export const DETAIL_RANGE_MAX = 4;

/**
 * View distance for a doodad of a given (scaled) radius, like the game's doodad LOD: small props
 * vanish within a few hundred yards, big trees stay visible much further. scale stretches or
 * shrinks it all (the detail distance setting).
 */
function viewDistance(radius: number, scale: number): number {
	return THREE.MathUtils.clamp(radius * 80, 150, 1600) * scale;
}

/** One model's geometry, drawn with a single InstancedMesh for every placed copy. */
class ModelEntry {
	state: 'queued' | 'loading' | 'ready' | 'failed' = 'queued';
	data: ModelData | null = null;
	mesh: THREE.InstancedMesh | null = null;
	geometry: THREE.BufferGeometry | null = null;
	materials: THREE.Material[] = [];
	/** For GPU-skinned models: the shadow pass's material, skinned the same way. */
	depthMaterial: THREE.Material | null = null;
	textures: number[] = [];
	/** WMO liquid surfaces, instanced with the same matrices as the model. */
	liquids: { geometry: THREE.BufferGeometry; material: THREE.Material; type: number; mesh: THREE.InstancedMesh | null }[] = [];
	readonly instances = new Map<string, THREE.Matrix4>();
	/** Keys of the instances currently in the instance buffer (those within view distance). */
	visible = new Set<string>();
	/** Set for models animated on the GPU: their shared bone texture and loop length. */
	animation: { key: string; duration: number } | null = null;
	/** Creatures that walk: the walk loop's length and when its feet come down (s), and their footstep kind. */
	walk: { duration: number; steps: number[] } | null = null;
	footstep = 0;
	/** Buildings: each material's TerrainType (in the order of materials), for footsteps on it. */
	grounds: number[] = [];
	/**
	 * Solid doodads and game objects (trees, rocks, logs): their collision mesh, never drawn (cast
	 * at one copy at a time through mesh), and the copies in the instance buffer with each one's
	 * bounding sphere in world space (x, y, z, radius), so a cast skips the copies it can't reach.
	 */
	collider: { geometry: THREE.BufferGeometry; mesh: THREE.Mesh; matrices: THREE.Matrix4[]; spheres: Float32Array } | null = null;
	/**
	 * While invisible walls are shown: the model's collision that nothing drawn covers (no geometry
	 * if it has none, or until it's worked out), instanced like the model. Worked out the first
	 * time they're shown.
	 */
	walls: { geometry: THREE.BufferGeometry | null; mesh: THREE.InstancedMesh | null } | null = null;
	/** Particle emitters (fire, smoke), with their textures. */
	emitters: LoadedEmitter[] = [];
	/** Instance key for each slot in the instance buffer, for picking. */
	drawnKeys: string[] = [];
	/** Slot in the instance buffer by instance key, for moving creatures. */
	slots = new Map<string, number>();
	radius = 0;
	dirty = false;
	unusedSince = 0;
	readonly onReady: ((entry: ModelEntry) => void)[] = [];

	constructor(readonly kind: Kind, readonly fdid: number, readonly variant?: string) {}
}

/** A placed object; objects crossing tile borders are listed by several tiles. */
interface PlacedObject {
	refs: number;
	/** How many of those tiles are at full detail; WMO doodads show only while this is > 0. */
	detailRefs: number;
	placement: Placement;
	matrix: THREE.Matrix4;
	/** Model entries and instance keys this object contributed. */
	parts: { entry: ModelEntry; key: string }[];
	/** WMO doodad instances, kept apart so they can come and go with detail. */
	doodadParts: { entry: ModelEntry; key: string }[];
	/** Creatures that walk (waypoints or wandering); moves matrix in place. */
	mover?: Mover;
}

/** A model placed by hand rather than by a tile (a boat or zeppelin), moved with placeLoose each frame. */
interface LooseObject {
	matrix: THREE.Matrix4;
	part: { entry: ModelEntry; key: string };
	/** A building's doodads (set 0), in its own space and placed. */
	doodads: { local: THREE.Matrix4; matrix: THREE.Matrix4; part: { entry: ModelEntry; key: string } }[];
}

export type ObjectLevel = 'none' | 'wmo' | 'all';

interface TileRecord {
	wdt: number;
	placements: Placement[] | null;
	level: ObjectLevel;
	/** Object keys this tile holds a reference to, and whether it counts toward their detail. */
	applied: Map<string, boolean>;
	toWorld: THREE.Matrix4;
}

export interface ObjectStats {
	models: number;
	instances: number;
	drawn: number;
	loading: number;
}

/**
 * Doodads (M2) and buildings (WMO) around the camera. Placements come per tile; each
 * distinct model is loaded once and drawn instanced. Distant tiles show only buildings,
 * without their interior doodads, to keep the number of distinct models (draw calls) down.
 */
export class ObjectManager {
	readonly group = new THREE.Group();
	private readonly models = new Map<string, ModelEntry>();
	private readonly objects = new Map<string, PlacedObject>();
	private readonly tiles = new Map<string, TileRecord>();
	private readonly loose = new Map<string, LooseObject>();
	/** Models with a loose object moved since the last update, whose instance buffers need uploading. */
	private readonly moved = new Set<ModelEntry>();
	private readonly queue: ModelEntry[] = [];
	private requests = 0;
	private readonly textures: TextureCache;
	readonly particles = new ParticleSystem();

	/**
	 * prepare compiles an object's shaders off the critical path (renderer.compileAsync), so a
	 * model's first frame doesn't stall on shader compilation; shadowPass for depth materials.
	 */
	constructor(
		private readonly storage: AsyncStorageApi,
		compressed: boolean,
		anisotropy: number,
		private readonly prepare: (object: THREE.Object3D, shadowPass?: boolean) => Promise<void>,
	) {
		this.textures = new TextureCache(storage, compressed, anisotropy);
		this.group.add(this.particles.group);
		this.particles.warmUp(prepare);
	}

	/**
	 * Sets how much of a tile's objects to show: 'wmo' shows bare buildings for the distance,
	 * 'all' adds scattered doodads and the buildings' own doodads. offset moves continent
	 * space into the shared world.
	 */
	setTileLevel(tileKey: string, wdt: number, x: number, y: number, offset: THREE.Vector3, level: ObjectLevel): void {
		let tile = this.tiles.get(tileKey);
		if (!tile) {
			if (level === 'none') return;
			tile = { wdt, placements: null, level, applied: new Map(), toWorld: new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z) };
			this.tiles.set(tileKey, tile);
			const record = tile;
			this.storage.loadTileObjects(wdt, x, y).then((placements) => {
				record.placements = placements;
				this.apply(tileKey, record);
			}, (e) => {
				console.warn(`Objects for ${tileKey}:`, e);
				record.placements = [];
			});
			return;
		}
		tile.level = level;
		this.apply(tileKey, tile);
	}

	private apply(tileKey: string, tile: TileRecord): void {
		if (this.tiles.get(tileKey) !== tile) return;
		const detail = tile.level === 'all';
		const wanted = new Map<string, Placement>();
		if (tile.placements && tile.level !== 'none') {
			for (const p of tile.placements) {
				if (detail || p.kind === 'wmo') wanted.set(`${tile.wdt}:${p.kind}:${p.uid}`, p);
			}
		}
		for (const [key, p] of wanted) {
			const had = tile.applied.get(key);
			if (had === undefined) this.acquire(key, p, tile.toWorld);
			if (had !== detail) {
				if (had !== undefined || detail) this.changeDetail(key, detail ? 1 : had ? -1 : 0);
				tile.applied.set(key, detail);
			}
		}
		for (const [key, hadDetail] of tile.applied) {
			if (wanted.has(key)) continue;
			tile.applied.delete(key);
			if (hadDetail) this.changeDetail(key, -1);
			this.release(key);
		}
		if (tile.level === 'none' && tile.placements) this.tiles.delete(tileKey);
	}

	private acquire(key: string, p: Placement, toWorld: THREE.Matrix4): void {
		const existing = this.objects.get(key);
		if (existing) {
			existing.refs++;
			return;
		}
		const object: PlacedObject = {
			refs: 1,
			detailRefs: 0,
			placement: p,
			matrix: toWorld.clone().multiply(new THREE.Matrix4().fromArray(p.matrix)),
			parts: [],
			doodadParts: [],
		};
		if (p.movement) object.mover = new Mover(p.movement, object.matrix, new THREE.Vector3().setFromMatrixPosition(toWorld));
		this.objects.set(key, object);
		object.parts.push(this.addInstance(p.kind, p.fdid, key, object.matrix, p.variant));
	}

	private release(key: string): void {
		const object = this.objects.get(key);
		if (!object || --object.refs > 0) return;
		this.objects.delete(key);
		for (const part of [...object.parts, ...object.doodadParts]) this.removeInstance(part);
	}

	private changeDetail(key: string, delta: number): void {
		const object = this.objects.get(key);
		if (!object || delta === 0) return;
		object.detailRefs += delta;
		if (object.placement.kind !== 'wmo') return;
		if (object.detailRefs > 0 && object.doodadParts.length === 0) {
			this.whenReady('wmo', object.placement.fdid, (entry) => this.addWmoDoodads(key, object, entry));
		} else if (object.detailRefs <= 0) {
			for (const part of object.doodadParts) this.removeInstance(part);
			object.doodadParts = [];
		}
	}

	private addWmoDoodads(key: string, object: PlacedObject, entry: ModelEntry): void {
		// The WMO may have been removed, or lost detail, before it finished loading.
		if (this.objects.get(key) !== object || object.detailRefs <= 0 || object.doodadParts.length || !entry.data?.doodadSets) return;
		const sets = entry.data.doodadSets;
		// Set 0 is always shown; the placement can add one more.
		const chosen = new Set([0, object.placement.doodadSet]);
		let i = 0;
		for (const s of chosen) {
			for (const d of sets[s]?.doodads ?? []) {
				const matrix = object.matrix.clone().multiply(new THREE.Matrix4().fromArray(d.matrix));
				object.doodadParts.push(this.addInstance('m2', d.fdid, `${key}:${i++}`, matrix));
			}
		}
	}

	/**
	 * Places a model that no tile holds (a boat or zeppelin), or moves it there if it's placed
	 * already. Buildings bring their doodads along. Shown at any distance until removeLoose.
	 */
	placeLoose(key: string, kind: Kind, fdid: number, matrix: THREE.Matrix4): void {
		const object = this.loose.get(key);
		if (!object) {
			const own = matrix.clone();
			const placed: LooseObject = { matrix: own, part: this.addInstance(kind, fdid, key, own), doodads: [] };
			this.loose.set(key, placed);
			if (kind === 'wmo') {
				this.whenReady('wmo', fdid, (entry) => {
					if (this.loose.get(key) !== placed) return;
					(entry.data?.doodadSets?.[0]?.doodads ?? []).forEach((d, i) => {
						const local = new THREE.Matrix4().fromArray(d.matrix);
						const placedMatrix = placed.matrix.clone().multiply(local);
						placed.doodads.push({ local, matrix: placedMatrix, part: this.addInstance('m2', d.fdid, `${key}:${i}`, placedMatrix) });
					});
				});
			}
			return;
		}
		object.matrix.copy(matrix);
		this.moveInstance(object.part);
		for (const d of object.doodads) {
			d.matrix.multiplyMatrices(object.matrix, d.local);
			this.moveInstance(d.part);
		}
	}

	removeLoose(key: string): void {
		const object = this.loose.get(key);
		if (!object) return;
		this.loose.delete(key);
		for (const part of [object.part, ...object.doodads.map((d) => d.part)]) this.removeInstance(part);
	}

	/** Writes an instance's changed matrix into its slot in the instance buffer, if it's drawn. */
	private moveInstance(part: { entry: ModelEntry; key: string }): void {
		const { entry, key } = part;
		const matrix = entry.instances.get(key);
		const slot = entry.slots.get(key);
		if (!matrix) return;
		// The inverse kept for finding rooms no longer fits.
		this.inverses.delete(matrix);
		if (!entry.mesh || slot === undefined) return;
		entry.mesh.setMatrixAt(slot, matrix);
		for (const l of entry.liquids) l.mesh?.setMatrixAt(slot, matrix);
		entry.walls?.mesh?.setMatrixAt(slot, matrix);
		this.moved.add(entry);
	}

	private addInstance(kind: Kind, fdid: number, key: string, matrix: THREE.Matrix4, variant?: string): { entry: ModelEntry; key: string } {
		const entry = this.entry(kind, fdid, variant);
		entry.instances.set(key, matrix);
		entry.dirty = true;
		return { entry, key };
	}

	private removeInstance(part: { entry: ModelEntry; key: string }): void {
		part.entry.instances.delete(part.key);
		part.entry.dirty = true;
	}
	private entry(kind: Kind, fdid: number, variant?: string): ModelEntry {
		const id = `${kind}:${fdid}:${variant ?? ''}`;
		let entry = this.models.get(id);
		if (!entry) {
			entry = new ModelEntry(kind, fdid, variant);
			this.models.set(id, entry);
			this.queue.push(entry);
		}
		return entry;
	}

	private whenReady(kind: Kind, fdid: number, fn: (entry: ModelEntry) => void): void {
		const entry = this.entry(kind, fdid);
		if (entry.state === 'ready') fn(entry);
		else entry.onReady.push(fn);
	}

	private lastCull = 0;
	private readonly camera = new THREE.Vector3();

	private lastUpdate = 0;
	private readonly emitterSources: EmitterSource[] = [];
	/** Emitters of models drawn elsewhere (the walking character's torch), set each frame before update. */
	extraEmitters: EmitterSource[] = [];

	/** Call once per frame: starts model loads, culls by view distance and applies instance changes. */
	update(now: number, camera: THREE.Vector3): void {
		this.camera.copy(camera);
		const dt = this.lastUpdate ? (now - this.lastUpdate) / 1000 : 0;
		this.lastUpdate = now;
		const cull = now - this.lastCull > CULL_INTERVAL;
		if (cull) this.lastCull = now;
		if (this.requests < MAX_MODEL_REQUESTS && this.queue.length) this.prioritize();
		while (this.requests < MAX_MODEL_REQUESTS && this.queue.length) {
			const batch = this.queue.splice(0, MODEL_BATCH).filter((e) => e.state === 'queued');
			if (batch.length) void this.load(batch);
		}
		for (const [id, entry] of this.models) {
			if (entry.state === 'ready' && (entry.dirty || (cull && this.visibilityChanged(entry)))) this.flush(entry);
			if (entry.instances.size === 0 && entry.state !== 'loading' && entry.state !== 'queued') {
				entry.unusedSince ||= now;
				if (now - entry.unusedSince > UNUSED_MODEL_TTL) {
					this.dispose(entry);
					this.models.delete(id);
				}
			} else {
				entry.unusedSince = 0;
			}
		}
		for (const entry of this.moved) {
			for (const mesh of [entry.mesh, entry.walls?.mesh, ...entry.liquids.map((l) => l.mesh)]) {
				if (!mesh) continue;
				mesh.instanceMatrix.needsUpdate = true;
				mesh.computeBoundingSphere();
			}
		}
		this.moved.clear();
		perf.time('movers', () => this.moveCreatures(dt, cull));
		perf.time('particles', () => this.particles.update(dt, this.nearbyEmitters()));
		// Not a time: the live particle count, averaged the same way.
		perf.record('particles.alive', this.particles.count);
	}

	/** Ground height for walking creatures; the viewer supplies the terrain's. */
	groundAt: GroundAt = () => NaN;

	/** Called when a walking creature near the camera puts a foot down: where, and its footstep kind. */
	onStep: ((at: THREE.Vector3, footstep: number) => void) | null = null;
	/** Each walking creature's point in its walk loop at the last frame, for spotting a footfall in between. */
	private readonly stepTimes = new Map<string, number>();
	private readonly stepAt = new THREE.Vector3();

	/** Walks the creatures near the camera and writes their new places into the instance buffers. */
	private moveCreatures(dt: number, cull: boolean): void {
		if (dt <= 0) return;
		for (const entry of this.models.values()) {
			const mesh = entry.mesh;
			if (entry.kind !== 'creature' || !mesh || !entry.visible.size) continue;
			const anim = entry.geometry?.getAttribute('instanceAnim') as THREE.InstancedBufferAttribute | undefined;
			let moved = false;
			for (const key of entry.visible) {
				const mover = this.objects.get(key)?.mover;
				const slot = entry.slots.get(key);
				if (!mover || slot === undefined) continue;
				const m = entry.instances.get(key)!;
				const e = m.elements;
				if ((e[12] - this.camera.x) ** 2 + (e[13] - this.camera.y) ** 2 + (e[14] - this.camera.z) ** 2 > MOVE_RANGE ** 2) continue;
				if (mover.update(dt, this.groundAt)) {
					mesh.setMatrixAt(slot, m);
					moved = true;
				}
				const walking = mover.walking ? 1 : 0;
				if (anim && anim.getX(slot) !== walking) {
					anim.setX(slot, walking);
					anim.needsUpdate = true;
				}
				if (walking) this.footfalls(entry, key, slot, e);
				else this.stepTimes.delete(key);
			}
			if (moved) {
				mesh.instanceMatrix.needsUpdate = true;
				// Walkers can leave the bounds the mesh was culled by.
				if (cull) mesh.computeBoundingSphere();
			}
		}
	}

	/**
	 * Reports a footfall of a walking creature near the camera: where its walk loop is now (as the
	 * GPU plays it: the shared clock plus the copy's own phase), and whether a footstep fell since
	 * the last frame.
	 */
	private footfalls(entry: ModelEntry, key: string, slot: number, e: ArrayLike<number>): void {
		const walk = entry.walk;
		if (!walk || !entry.footstep || !this.onStep) return;
		if ((e[12] - this.camera.x) ** 2 + (e[13] - this.camera.y) ** 2 + (e[14] - this.camera.z) ** 2 > FOOTSTEP_RANGE ** 2) {
			this.stepTimes.delete(key);
			return;
		}
		const phase = (entry.geometry?.getAttribute('instancePhase') as THREE.InstancedBufferAttribute | undefined)?.getX(slot) ?? 0;
		const now = THREE.MathUtils.euclideanModulo(liquidTime.value + phase, walk.duration);
		const before = this.stepTimes.get(key);
		this.stepTimes.set(key, now);
		if (before === undefined) return;
		// Round the end of the loop, the steps after before and those up to now both count.
		const fell = walk.steps.some((t) => (before <= now ? t > before && t <= now : t > before || t <= now));
		if (fell) this.onStep(this.stepAt.set(e[12], e[13], e[14]), entry.footstep);
	}

	/** Placed copies of models with particle emitters, near enough for their particles to show. */
	private nearbyEmitters(): EmitterSource[] {
		const out = this.emitterSources;
		out.length = 0;
		const range = this.showAll ? SHOT_PARTICLE_RANGE : PARTICLE_RANGE;
		for (const [id, entry] of this.models) {
			if (!entry.emitters.length || entry.state !== 'ready') continue;
			for (const key of entry.visible) {
				const m = entry.instances.get(key);
				if (!m) continue;
				const e = m.elements;
				if ((e[12] - this.camera.x) ** 2 + (e[13] - this.camera.y) ** 2 + (e[14] - this.camera.z) ** 2 > range ** 2) continue;
				out.push({ key: `${id}|${key}`, matrix: m, emitters: entry.emitters });
			}
		}
		out.push(...this.extraEmitters);
		return out;
	}

	/** Orders the load queue by each model's nearest placed copy, so the area around you fills in first. */
	private prioritize(): void {
		const distance = new Map<ModelEntry, number>();
		for (const entry of this.queue) {
			let best = Infinity;
			for (const m of entry.instances.values()) {
				const e = m.elements;
				best = Math.min(best, (e[12] - this.camera.x) ** 2 + (e[13] - this.camera.y) ** 2 + (e[14] - this.camera.z) ** 2);
			}
			distance.set(entry, best);
		}
		this.queue.sort((a, b) => distance.get(a)! - distance.get(b)!);
	}

	private async load(batch: ModelEntry[]): Promise<void> {
		this.requests++;
		for (const e of batch) e.state = 'loading';
		try {
			const start = performance.now();
			const results = await this.storage.loadModels(batch.map((e) => ({ fdid: e.fdid, kind: e.kind, variant: e.variant })));
			perf.log('model', `read ${batch.length} models in ${(performance.now() - start).toFixed(0)} ms (${this.queue.length} queued)`);
			await Promise.all(batch.map((entry, i) => this.build(entry, results[i])));
		} catch (e) {
			perf.log('model', `batch of ${batch.length} failed: ${(e as Error).message}`);
			console.warn('Model batch failed:', e);
			for (const entry of batch) entry.state = 'failed';
		} finally {
			this.requests--;
		}
	}

	private async build(entry: ModelEntry, data: ModelData | null): Promise<void> {
		// Some models are only their particles (instance portals: a hidden quad and the swirl).
		if (!data || (data.batches.length === 0 && !data.emitters?.length)) {
			perf.log('model', `${entry.kind} ${entry.fdid}: nothing to draw`);
			entry.state = 'failed';
			return;
		}
		const start = performance.now();
		entry.textures = [...new Set([...data.batches.map((b) => b.material.texture), ...(data.emitters ?? []).map((e) => e.texture)].filter((t) => t))];
		const textures = await this.textures.acquire(entry.textures);
		entry.emitters = (data.emitters ?? []).flatMap((def) => {
			const texture = textures.get(def.texture);
			return texture ? [{ def, texture }] : [];
		});

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
		geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
		geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
		if (data.baked) geometry.setAttribute('baked', new THREE.BufferAttribute(data.baked, 4));
		let skin: SkinUniforms | null = null;
		if (data.animation) {
			const a = data.animation;
			geometry.setAttribute('boneIndex', new THREE.BufferAttribute(a.boneIndex, 4));
			geometry.setAttribute('boneWeight', new THREE.BufferAttribute(a.boneWeight, 4, true));
			const frames = a.clips.reduce((n, c) => Math.max(n, c.row + c.frames), 0);
			skin = {
				uBoneTex: { value: this.acquireBones(a.key, a.data, a.bones, frames) },
				uClips: { value: a.clips.map((c) => new THREE.Vector3(c.row, c.frames, c.duration)) },
			};
			entry.animation = { key: a.key, duration: a.clips[0].duration };
			const walk = a.clips[1];
			if (walk?.steps?.length) entry.walk = { duration: walk.duration, steps: walk.steps };
			entry.depthMaterial = createSkinnedDepthMaterial(skin);
		}
		geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
		const batches = [...data.batches].sort((a, b) => a.order - b.order);
		entry.grounds = batches.map((b) => b.material.ground ?? 0);
		entry.footstep = data.footstep ?? 0;
		entry.materials = batches.map((b, i) => {
			geometry.addGroup(b.start, b.count, i);
			const material = createModelMaterial(b.material, textures.get(b.material.texture) ?? null, !!data.baked, skin);
			// Walkable slopes show on buildings, whose drawn triangles are what's walked on (a doodad's collision mesh isn't drawn).
			if (entry.kind === 'wmo') applyWalkable(material);
			return material;
		});
		geometry.computeBoundingSphere();
		if (data.bvh) {
			geometry.boundsTree = MeshBVH.deserialize({ ...data.bvh, index: data.indices } as Parameters<typeof MeshBVH.deserialize>[0], geometry, { setIndex: false });
		}
		if (data.collision) {
			const hull = new THREE.BufferGeometry();
			hull.setAttribute('position', new THREE.BufferAttribute(data.collision.positions, 3));
			hull.setIndex(new THREE.BufferAttribute(data.collision.indices, 1));
			hull.boundsTree = MeshBVH.deserialize({ ...data.collision.bvh, index: data.collision.indices } as Parameters<typeof MeshBVH.deserialize>[0], hull, { setIndex: false });
			hull.computeBoundingSphere();
			const mesh = new THREE.Mesh(hull, ObjectManager.COLLIDER_MATERIAL);
			mesh.matrixAutoUpdate = false;
			entry.collider = { geometry: hull, mesh, matrices: [], spheres: new Float32Array(0) };
		}
		entry.liquids = (data.liquids ?? []).map((l) => ({ geometry: liquidGeometry(l.positions, l.indices), material: liquidMaterial(l.kind, l.type), type: l.type, mesh: null }));
		const built = performance.now();
		// Warm the instanced shader variants, which are what the model and its liquids will be drawn with.
		const model = new THREE.InstancedMesh(geometry, entry.materials, 1);
		// And its shadow's (see shadowStandIns); a skinned model's depth material is warmed below.
		model.castShadow = true;
		if (entry.depthMaterial) model.customDepthMaterial = entry.depthMaterial;
		const warm = new THREE.Group().add(model, ...entry.liquids.map((l) => new THREE.InstancedMesh(l.geometry, l.material, 1)));
		const warming = [this.prepare(warm)];
		if (entry.depthMaterial) {
			// The shadow pass draws the depth material with each batch's texture and alpha test,
			// flipped to the faces away from the sun (WebGLShadowMap's getDepthMaterial). Each in a
			// material of its own: prepare compiles in turn, later, so one changed between calls
			// would only ever be compiled as it was left.
			const variants = new Set<string>();
			for (const m of entry.materials) {
				const map = (m as THREE.MeshLambertMaterial).map ?? null;
				const side = m.side === THREE.DoubleSide ? THREE.DoubleSide : m.side === THREE.BackSide ? THREE.FrontSide : THREE.BackSide;
				const variant = `${!!map} ${m.alphaTest > 0} ${side}`;
				if (variants.has(variant)) continue;
				variants.add(variant);
				const depth = createSkinnedDepthMaterial(skin!);
				depth.map = map;
				depth.alphaTest = m.alphaTest;
				depth.side = side;
				warming.push(this.prepare(new THREE.InstancedMesh(geometry, depth, 1), true));
			}
		}
		await Promise.all(warming);
		perf.log('model', `${entry.kind} ${entry.fdid}: ready after ${(performance.now() - start).toFixed(0)} ms (textures and build ${(built - start).toFixed(0)}, shaders and upload ${(performance.now() - built).toFixed(0)}; ${entry.materials.length} materials, ${(data.indices.length / 3).toFixed(0)} triangles${skin ? ', animated' : ''}${entry.liquids.length ? `, ${entry.liquids.length} liquids` : ''})`);
		entry.geometry = geometry;
		entry.radius = data.radius;
		entry.data = { ...data, positions: new Float32Array(0), normals: new Float32Array(0), uvs: new Float32Array(0), baked: null, indices: new Uint32Array(0), liquids: [], animation: undefined };
		entry.state = 'ready';
		entry.dirty = true;
		for (const fn of entry.onReady.splice(0)) fn(entry);
	}

	private showAll = false;

	/**
	 * For a screenshot: every placed copy shows, however far off (tiles still limit what's placed),
	 * and particles run further out.
	 */
	set unlimited(on: boolean) {
		if (on === this.showAll) return;
		this.showAll = on;
		for (const entry of this.models.values()) entry.dirty = true;
	}

	private detailScale = 1;

	/**
	 * How far doodads, creatures and objects show, as a multiple of the usual distance for their
	 * size. They're only placed on the detailed tiles around the camera, so that bounds it too.
	 */
	get detailRange(): number {
		return this.detailScale;
	}

	set detailRange(scale: number) {
		scale = THREE.MathUtils.clamp(scale, DETAIL_RANGE_MIN, DETAIL_RANGE_MAX);
		if (scale === this.detailScale) return;
		this.detailScale = scale;
		for (const entry of this.models.values()) entry.dirty = true;
	}

	private readonly hiddenKinds = new Set<Hideable>();

	/** Shows or hides every creature (NPCs and monsters), game object (chests, herbs, doors...) or spirit healer. */
	setKindShown(kind: Hideable, shown: boolean): void {
		if (shown !== this.hiddenKinds.has(kind)) return;
		if (shown) this.hiddenKinds.delete(kind);
		else this.hiddenKinds.add(kind);
		const modelKind = kind === 'spiritHealer' ? 'creature' : kind;
		for (const entry of this.models.values()) if (entry.kind === modelKind) entry.dirty = true;
	}

	kindShown(kind: Hideable): boolean {
		return !this.hiddenKinds.has(kind);
	}

	/** The buildings' meshes among the group's children (not their liquids), which hide what's behind them. */
	buildingMeshes(): Set<THREE.Object3D> {
		const meshes = new Set<THREE.Object3D>();
		for (const entry of this.models.values()) if (entry.kind === 'wmo' && entry.mesh) meshes.add(entry.mesh);
		return meshes;
	}

	/** Models and tiles' placements still to load. */
	get pending(): number {
		let n = this.queue.length + this.requests;
		for (const tile of this.tiles.values()) if (!tile.placements && tile.level !== 'none') n++;
		return n;
	}

	private isVisible(entry: ModelEntry, key: string, m: THREE.Matrix4): boolean {
		if (this.hidden.has(key)) return false;
		if ((entry.kind === 'creature' || entry.kind === 'object') && this.hiddenKinds.has(entry.kind)) return false;
		if (entry.kind === 'creature' && this.hiddenKinds.has('spiritHealer') && this.objects.get(key)?.placement.spawn?.spiritHealer) return false;
		// Buildings are already limited by tile distance.
		if (entry.kind === 'wmo' || this.showAll) return true;
		const e = m.elements;
		const scale = Math.hypot(e[0], e[1], e[2]);
		const dx = e[12] - this.camera.x, dy = e[13] - this.camera.y, dz = e[14] - this.camera.z;
		return dx * dx + dy * dy + dz * dz < viewDistance(entry.radius * scale, this.detailScale) ** 2;
	}

	private visibilityChanged(entry: ModelEntry): boolean {
		let count = 0;
		for (const [key, m] of entry.instances) {
			if (this.isVisible(entry, key, m) !== entry.visible.has(key)) return true;
			count++;
		}
		return count === 0 && entry.visible.size > 0;
	}

	/** Rewrites a model's instance buffer with its placed copies that are within view distance. */
	private flush(entry: ModelEntry): void {
		entry.dirty = false;
		if (!entry.geometry) return;
		entry.visible = new Set();
		for (const [key, m] of entry.instances) if (this.isVisible(entry, key, m)) entry.visible.add(key);
		entry.drawnKeys = [...entry.visible];
		entry.slots = new Map(entry.drawnKeys.map((key, i) => [key, i]));
		const matrices = entry.drawnKeys.map((key) => entry.instances.get(key)!);
		// People and creatures are small however big their model's bounds.
		const role: ShadowRole = entry.kind === 'wmo' || (entry.kind !== 'creature' && entry.radius >= SMALL_CASTER) ? 'cast' : 'near';
		entry.mesh = this.syncMesh(entry.mesh, entry.geometry, entry.materials, matrices, entry.kind === 'wmo' ? -1 : 0, role);
		if (entry.depthMaterial) entry.mesh.customDepthMaterial = entry.depthMaterial;
		if (entry.animation) this.writePhases(entry.mesh, entry.geometry, entry.drawnKeys, entry.animation.duration);
		if (entry.collider) ObjectManager.placeCollider(entry.collider, matrices);
		if (this.wallsShown) {
			if (!entry.walls) {
				entry.walls = { geometry: null, mesh: null };
				void this.findWalls(entry, entry.walls);
			}
			// After the liquids, so a wall under water still shows.
			if (entry.walls.geometry) entry.walls.mesh = this.syncMesh(entry.walls.mesh, entry.walls.geometry, WALL_MATERIAL, matrices, 2, 'receive');
		} else if (entry.walls?.mesh) {
			this.group.remove(entry.walls.mesh);
			entry.walls.mesh.dispose();
			entry.walls.mesh = null;
		}
		for (const liquid of entry.liquids) {
			// Liquids draw after the building so it shows through the surface.
			liquid.mesh = this.syncMesh(liquid.mesh, liquid.geometry, liquid.material, matrices, 1, 'receive');
			liquid.mesh.userData.liquidType = liquid.type;
		}
	}

	private wallsShown = false;

	/**
	 * Draws the collision that has nothing drawn on it, invisible walls, as see-through violet
	 * surfaces (see invisibleWalls.ts). Off, nothing of it is kept in the scene.
	 */
	set invisibleWalls(shown: boolean) {
		if (shown === this.wallsShown) return;
		this.wallsShown = shown;
		for (const entry of this.models.values()) entry.dirty = true;
	}

	/** How opaque each texture gets (see WorldLoader.textureOpacity), asked for once. */
	private readonly opacities = new Map<number, Promise<number>>();

	/**
	 * The runs of a model's triangles that are drawn with a texture nothing shows of: an
	 * invisible wall made as an ordinary surface. Only see-through blends can be.
	 */
	private async unseenRuns(entry: ModelEntry): Promise<IndexRange[]> {
		const batches = (entry.data?.batches ?? []).filter((b) => !b.material.collision);
		const keyed = (b: (typeof batches)[number]) => (b.material.blend === Blend.AlphaKey || b.material.blend === Blend.Alpha) && b.material.texture > 0;
		const asked = [...new Set(batches.filter(keyed).map((b) => b.material.texture))].filter((fdid) => !this.opacities.has(fdid));
		if (asked.length) {
			const answer = this.storage.textureOpacity(asked);
			asked.forEach((fdid, i) => this.opacities.set(fdid, answer.then((levels) => levels[i], () => 255)));
		}
		const unseen = await Promise.all(batches.map(async (b) => keyed(b) && (await this.opacities.get(b.material.texture)!) < UNSEEN_OPACITY));
		// A run drawn twice (a base and a layer over it) is unseen only if every layer is.
		const seen = new Set(batches.filter((_, i) => !unseen[i]).map((b) => `${b.start}:${b.count}`));
		const runs = new Map<string, IndexRange>();
		batches.forEach((b, i) => {
			if (unseen[i] && !seen.has(`${b.start}:${b.count}`)) runs.set(`${b.start}:${b.count}`, { start: b.start, count: b.count });
		});
		return [...runs.values()];
	}

	/** Works out a model's invisible walls and has them drawn; walls: the entry's record of them, to fill in. */
	private async findWalls(entry: ModelEntry, walls: NonNullable<ModelEntry['walls']>): Promise<void> {
		let geometry: THREE.BufferGeometry | null = null;
		try {
			geometry = this.wallGeometry(entry, await this.unseenRuns(entry));
		} catch (e) {
			console.warn(`Invisible walls of ${entry.kind} ${entry.fdid}:`, e);
		}
		// The model may have been unloaded meanwhile.
		if (entry.walls !== walls || !entry.geometry) {
			geometry?.dispose();
			return;
		}
		walls.geometry = geometry;
		if (geometry) entry.dirty = true;
	}

	/**
	 * A model's collision triangles that nothing drawn covers, to draw over it; null if there are
	 * none. unseen: the runs of its triangles drawn with a texture nothing shows of.
	 */
	private wallGeometry(entry: ModelEntry, unseen: IndexRange[]): THREE.BufferGeometry | null {
		const drawn = entry.geometry;
		if (!drawn?.index) return null;
		const drawnPositions = drawn.getAttribute('position') as THREE.BufferAttribute;
		let positions = drawnPositions;
		let bare: Uint32Array | null;
		if (entry.collider) {
			// A doodad or game object: its collision mesh, against the triangles it's drawn with that can be seen.
			const hull = entry.collider.geometry;
			positions = hull.getAttribute('position') as THREE.BufferAttribute;
			const index = drawn.index.array;
			const visible: number[] = [];
			const batches = (entry.data?.batches ?? []).filter((b) => !unseen.some((r) => r.start === b.start && r.count === b.count));
			for (const key of new Set(batches.map((b) => `${b.start}:${b.count}`))) {
				const [start, count] = key.split(':').map(Number);
				for (let i = start; i < start + count; i++) visible.push(index[i]);
			}
			const surface = visible.length ? surfaceTree(drawnPositions, new THREE.BufferAttribute(Uint32Array.from(visible), 1)) : null;
			bare = bareTriangles(positions, hull.index!.array, [{ start: 0, count: hull.index!.count }], surface, [], doodadNear(entry.radius));
		} else {
			// A building: its collision-only triangles and those drawn unseen, against the rest.
			const hidden = [...(entry.data?.batches ?? []).filter((b) => b.material.collision).map((b) => ({ start: b.start, count: b.count })), ...unseen];
			if (!hidden.length || !drawn.boundsTree) return null;
			bare = bareTriangles(positions, drawn.index.array, hidden, drawn.boundsTree as MeshBVH, hidden, WMO_NEAR);
		}
		if (!bare) return null;
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', positions);
		geometry.setIndex(new THREE.BufferAttribute(bare, 1));
		geometry.computeBoundingSphere();
		return geometry;
	}

	private static readonly COLLIDER_MATERIAL = new THREE.MeshBasicMaterial();

	/** Gives a collision mesh the model's copies in the instance buffer, and their bounding spheres. */
	private static placeCollider(collider: NonNullable<ModelEntry['collider']>, matrices: THREE.Matrix4[]): void {
		const sphere = collider.geometry.boundingSphere!;
		const center = new THREE.Vector3();
		collider.matrices = matrices;
		collider.spheres = new Float32Array(matrices.length * 4);
		matrices.forEach((m, i) => {
			center.copy(sphere.center).applyMatrix4(m);
			collider.spheres.set([center.x, center.y, center.z, sphere.radius * m.getMaxScaleOnAxis()], i * 4);
		});
	}

	/** Creates or grows an InstancedMesh as needed and writes the instance matrices into it. */
	private syncMesh(
		mesh: THREE.InstancedMesh | null,
		geometry: THREE.BufferGeometry,
		material: THREE.Material | THREE.Material[],
		matrices: THREE.Matrix4[],
		renderOrder: number,
		shadow: ShadowRole,
	): THREE.InstancedMesh {
		const count = matrices.length;
		if (!mesh || mesh.instanceMatrix.count < count) {
			if (mesh) {
				this.group.remove(mesh);
				mesh.dispose();
			}
			const capacity = Math.max(4, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
			mesh = new THREE.InstancedMesh(geometry, material, capacity);
			mesh.matrixAutoUpdate = false;
			mesh.renderOrder = renderOrder;
			useShadows(mesh, shadow);
			this.group.add(mesh);
		}
		matrices.forEach((m, i) => mesh!.setMatrixAt(i, m));
		mesh.count = count;
		mesh.instanceMatrix.needsUpdate = true;
		mesh.visible = count > 0;
		if (count > 0) mesh.computeBoundingSphere();
		return mesh;
	}
	/**
	 * Each copy's point in its animation loop, stable per placement (hashed from its key), so
	 * a crowd of the same NPC doesn't move in lockstep.
	 */
	private writePhases(mesh: THREE.InstancedMesh, geometry: THREE.BufferGeometry, keys: string[], duration: number): void {
		const capacity = mesh.instanceMatrix.count;
		let attribute = geometry.getAttribute('instancePhase') as THREE.InstancedBufferAttribute | undefined;
		if (!attribute || attribute.count !== capacity) {
			attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
			geometry.setAttribute('instancePhase', attribute);
		}
		let anim = geometry.getAttribute('instanceAnim') as THREE.InstancedBufferAttribute | undefined;
		if (!anim || anim.count !== capacity) {
			anim = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
			geometry.setAttribute('instanceAnim', anim);
		}
		keys.forEach((key, i) => {
			let h = 2166136261;
			for (let c = 0; c < key.length; c++) h = Math.imul(h ^ key.charCodeAt(c), 16777619);
			attribute!.setX(i, ((h >>> 0) / 4294967296) * duration);
			// Standing or walking (see moveCreatures).
			anim!.setX(i, this.objects.get(key)?.mover?.walking ? 1 : 0);
		});
		attribute.needsUpdate = true;
		anim.needsUpdate = true;
	}

	/** Bone textures by skeleton, shared by every look (display, gear) that uses the model. */
	private readonly boneTextures = new Map<string, { texture: THREE.DataTexture; refs: number }>();

	private acquireBones(key: string, data: Float32Array, bones: number, frames: number): THREE.DataTexture {
		let entry = this.boneTextures.get(key);
		if (!entry) {
			// Three RGBA texels per bone (the rows of its 3x4 matrix), one texel row per frame.
			const texture = new THREE.DataTexture(data, bones * 3, frames, THREE.RGBAFormat, THREE.FloatType);
			texture.magFilter = texture.minFilter = THREE.NearestFilter;
			texture.needsUpdate = true;
			entry = { texture, refs: 0 };
			this.boneTextures.set(key, entry);
		}
		entry.refs++;
		return entry.texture;
	}

	private releaseBones(key: string): void {
		const entry = this.boneTextures.get(key);
		if (!entry || --entry.refs > 0) return;
		entry.texture.dispose();
		this.boneTextures.delete(key);
	}

	private dispose(entry: ModelEntry): void {
		if (entry.walls?.mesh) {
			this.group.remove(entry.walls.mesh);
			entry.walls.mesh.dispose();
		}
		entry.walls?.geometry?.dispose();
		entry.walls = null;
		if (entry.mesh) {
			this.group.remove(entry.mesh);
			entry.mesh.dispose();
		}
		entry.geometry?.dispose();
		entry.collider?.geometry.dispose();
		for (const m of entry.materials) m.dispose();
		entry.depthMaterial?.dispose();
		for (const l of entry.liquids) {
			if (l.mesh) {
				this.group.remove(l.mesh);
				l.mesh.dispose();
			}
			// Liquid materials are shared; only the geometry belongs to this model.
			l.geometry.dispose();
		}
		this.textures.release(entry.textures);
		if (entry.animation) this.releaseBones(entry.animation.key);
	}

	/** Buildings' liquid surfaces in view (canals, pools, cave water), for telling if a point is under water. */
	liquidMeshes(out: THREE.Object3D[] = []): THREE.Object3D[] {
		for (const entry of this.models.values()) {
			for (const l of entry.liquids) if (l.mesh?.visible) out.push(l.mesh);
		}
		return out;
	}

	/**
	 * NPCs within range of the camera, with the world position just above their heads, and
	 * the live placement it comes from (walkers' change every frame; see headPosition).
	 */
	nameplates(camera: THREE.Vector3, range: number, out: { info: SpawnInfo; position: THREE.Vector3; distance: number; matrix: THREE.Matrix4; height: number }[] = []) {
		out.length = 0;
		for (const entry of this.models.values()) {
			if (entry.kind !== 'creature' || entry.state !== 'ready' || !entry.data) continue;
			const top = entry.data.height;
			for (const key of entry.visible) {
				const m = entry.instances.get(key);
				const info = m && this.objects.get(key)?.placement.spawn;
				if (!m || !info) continue;
				const e = m.elements;
				const dx = e[12] - camera.x, dy = e[13] - camera.y, dz = e[14] - camera.z;
				if (dx * dx + dy * dy + dz * dz > range * range) continue;
				const position = headPosition(m, top, new THREE.Vector3());
				out.push({ info, position, distance: position.distanceTo(camera), matrix: m, height: top });
			}
		}
		return out;
	}

	/** Whether a building or a solid doodad (tree, rock) blocks the straight line between two points. */
	blocksSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
		const direction = to.clone().sub(from);
		const distance = direction.length();
		if (distance < 1e-3) return false;
		// Stop just short of the target so its own surroundings (a doorway, the floor) don't count.
		return this.castBuildings(from, direction.divideScalar(distance), distance - 0.5) !== null;
	}

	private readonly sweepRay = new THREE.Raycaster();
	private readonly hitNormal = new THREE.Vector3();

	/**
	 * Nearest building surface along a ray (within far), with its world-space normal and the
	 * TerrainType it's made of (0 unknown): floors under the walking character, walls behind its camera.
	 * Solid doodads (trees, rocks) count too, unless doodads is false.
	 */
	castBuildings(from: THREE.Vector3, direction: THREE.Vector3, far: number, doodads = true): { distance: number; normal: THREE.Vector3; ground: number } | null {
		this.sweepRay.set(from, direction);
		this.sweepRay.far = far;
		this.sweepRay.firstHitOnly = true;
		let best: { distance: number; normal: THREE.Vector3; ground: number } | null = null;
		for (const entry of this.models.values()) {
			const collider = entry.collider;
			if (collider) {
				if (!doodads) continue;
				const s = collider.spheres;
				for (let i = 0; i < collider.matrices.length; i++) {
					// Skip copies whose bounds the ray doesn't come within reach of.
					const cx = s[i * 4] - from.x, cy = s[i * 4 + 1] - from.y, cz = s[i * 4 + 2] - from.z;
					const t = THREE.MathUtils.clamp(cx * direction.x + cy * direction.y + cz * direction.z, 0, far);
					const ex = cx - direction.x * t, ey = cy - direction.y * t, ez = cz - direction.z * t;
					if (ex * ex + ey * ey + ez * ez > s[i * 4 + 3] ** 2) continue;
					collider.mesh.matrixWorld.copy(collider.matrices[i]);
					const hit = this.sweepRay.intersectObject(collider.mesh, false)[0];
					if (!hit?.face || (best && hit.distance >= best.distance)) continue;
					// A collision mesh has no materials: unknown ground.
					this.hitNormal.copy(hit.face.normal).transformDirection(collider.matrices[i]);
					best = { distance: hit.distance, normal: this.hitNormal.clone(), ground: 0 };
				}
				continue;
			}
			if (!entry.mesh?.visible || !entry.geometry?.boundsTree) continue;
			const hit = this.sweepRay.intersectObject(entry.mesh, false)[0];
			if (!hit?.face || (best && hit.distance >= best.distance)) continue;
			// The face normal is in model space; carry it through the instance's placement.
			const instance = new THREE.Matrix4();
			if (hit.instanceId !== undefined) entry.mesh.getMatrixAt(hit.instanceId, instance);
			this.hitNormal.copy(hit.face.normal).transformDirection(instance);
			best = { distance: hit.distance, normal: this.hitNormal.clone(), ground: entry.grounds[hit.face.materialIndex] ?? 0 };
		}
		return best;
	}

	/**
	 * Limits a camera move so it can't pass through buildings (caves, mines, walls): slides along
	 * a surface it would cross, keeping `radius` away from it. Returns the allowed move.
	 * horizontal: slides along surfaces as if they were upright (the walking character, which
	 * only moves across), so a sloping one can't leave part of the move still going into it.
	 */
	sweep(from: THREE.Vector3, move: THREE.Vector3, radius: number, horizontal = false): THREE.Vector3 {
		let allowed = move.clone();
		for (let pass = 0; pass < 3; pass++) {
			const length = allowed.length();
			if (length < 1e-5) break;
			const direction = allowed.clone().divideScalar(length);
			const hit = this.castBuildings(from, direction, length + radius);
			if (!hit) break;
			if (horizontal) {
				hit.normal.y = 0;
				if (hit.normal.lengthSq() < 1e-8) break;
				hit.normal.normalize();
			}
			// Facing away from the move (we're behind it): not a wall for this move.
			const into = allowed.dot(hit.normal);
			if (into >= 0) break;
			if (pass < 2) {
				// Slide: drop the part of the move that goes into the surface, then check again.
				allowed.addScaledVector(hit.normal, -into);
			} else {
				// Still blocked (a corner): stop short of the surface.
				allowed = direction.multiplyScalar(Math.min(Math.max(0, hit.distance - radius), length));
			}
		}
		return allowed;
	}

	/** Whether any building's (or solid doodad's) bounds come within `margin` of a point: collision is only needed then. */
	nearBuilding(at: THREE.Vector3, margin: number, doodads = true): boolean {
		for (const entry of this.models.values()) {
			const collider = entry.collider;
			if (collider) {
				if (!doodads) continue;
				const s = collider.spheres;
				for (let i = 0; i < s.length; i += 4) {
					const reach = s[i + 3] + margin;
					if ((s[i] - at.x) ** 2 + (s[i + 1] - at.y) ** 2 + (s[i + 2] - at.z) ** 2 < reach * reach) return true;
				}
				continue;
			}
			const sphere = entry.geometry?.boundingSphere;
			if (!entry.mesh?.visible || !entry.geometry?.boundsTree || !sphere) continue;
			for (const key of entry.visible) {
				const m = entry.instances.get(key)!;
				const e = m.elements;
				const scale = Math.hypot(e[0], e[1], e[2]);
				const cx = e[0] * sphere.center.x + e[4] * sphere.center.y + e[8] * sphere.center.z + e[12];
				const cy = e[1] * sphere.center.x + e[5] * sphere.center.y + e[9] * sphere.center.z + e[13];
				const cz = e[2] * sphere.center.x + e[6] * sphere.center.y + e[10] * sphere.center.z + e[14];
				const reach = sphere.radius * scale + margin;
				if ((cx - at.x) ** 2 + (cy - at.y) ** 2 + (cz - at.z) ** 2 < reach * reach) return true;
			}
		}
		return false;
	}

	private readonly inverses = new WeakMap<THREE.Matrix4, THREE.Matrix4>();

	/**
	 * The indoor room (WMO interior group) around a point, for its WMOAreaTable name and music.
	 * Rooms are matched by bounding box; where several hold the point, the smallest wins.
	 */
	roomAt(at: THREE.Vector3): { wmoId: number; nameSet: number; groupId: number } | null {
		let best: { wmoId: number; nameSet: number; groupId: number } | null = null;
		let bestVolume = Infinity;
		const local = new THREE.Vector3();
		for (const entry of this.models.values()) {
			const areas = entry.data?.areas;
			const sphere = entry.geometry?.boundingSphere;
			if (entry.kind !== 'wmo' || !areas || !sphere) continue;
			for (const key of entry.visible) {
				const m = entry.instances.get(key)!;
				const e = m.elements;
				const scale = Math.hypot(e[0], e[1], e[2]);
				local.copy(sphere.center).applyMatrix4(m);
				if (local.distanceToSquared(at) > (sphere.radius * scale) ** 2) continue;
				let inverse = this.inverses.get(m);
				if (!inverse) {
					inverse = m.clone().invert();
					this.inverses.set(m, inverse);
				}
				local.copy(at).applyMatrix4(inverse);
				for (const g of areas.groups) {
					if (!g.interior) continue;
					if (local.x < g.min[0] || local.y < g.min[1] || local.z < g.min[2] || local.x > g.max[0] || local.y > g.max[1] || local.z > g.max[2]) continue;
					const volume = (g.max[0] - g.min[0]) * (g.max[1] - g.min[1]) * (g.max[2] - g.min[2]);
					if (volume >= bestVolume) continue;
					bestVolume = volume;
					best = { wmoId: areas.wmoId, nameSet: this.objects.get(key)?.placement.nameSet ?? 0, groupId: g.id };
				}
			}
		}
		return best;
	}

	private static readonly AXES = [
		new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 1, 0),
		new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
		new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
	];

	/**
	 * How far to move a point so no building surface is within `radius` of it along the six axes
	 * (floors, ceilings, walls). Keeps the camera's view from clipping into a surface it slid along.
	 * horizontal: walls only (the walking character, whose floor is found separately).
	 */
	pushOut(at: THREE.Vector3, radius: number, horizontal = false): THREE.Vector3 {
		const offset = new THREE.Vector3();
		for (const axis of horizontal ? ObjectManager.AXES.slice(2) : ObjectManager.AXES) {
			const hit = this.castBuildings(at, axis, radius);
			if (hit && axis.dot(hit.normal) < 0) offset.addScaledVector(axis, -(radius - hit.distance));
		}
		return offset;
	}

	/** Creature spawns drawn by someone else for now (a mob being fought, see adventure.ts). */
	private readonly hidden = new Set<string>();

	/** Leaves a creature spawn out of its instance buffer (no picking, name or walking) while hidden. */
	setHidden(key: string, hidden: boolean): void {
		if (hidden === this.hidden.has(key)) return;
		if (hidden) this.hidden.add(key);
		else this.hidden.delete(key);
		for (const part of this.objects.get(key)?.parts ?? []) part.entry.dirty = true;
	}

	/** A creature spawn by instance key: what it is, where it stands now (moved by its walker) and its look; null once unloaded. */
	creature(key: string): { info: SpawnInfo; matrix: THREE.Matrix4; displayId: number; variant?: string; height: number } | null {
		const object = this.objects.get(key);
		const part = object?.parts.find((p) => p.entry.kind === 'creature');
		const info = object?.placement.spawn;
		const matrix = part && part.entry.instances.get(part.key);
		if (!part || !info || !matrix) return null;
		return { info, matrix: matrix.clone(), displayId: part.entry.fdid, variant: part.entry.variant, height: part.entry.data?.height ?? 2 };
	}

	/** Creature spawns drawn within range of a point, nearest first. */
	creaturesNear(at: THREE.Vector3, range: number): { key: string; info: SpawnInfo; position: THREE.Vector3; distance: number }[] {
		const out: { key: string; info: SpawnInfo; position: THREE.Vector3; distance: number }[] = [];
		for (const entry of this.models.values()) {
			if (entry.kind !== 'creature') continue;
			for (const key of entry.visible) {
				const m = entry.instances.get(key);
				const info = m && this.objects.get(key)?.placement.spawn;
				if (!m || !info) continue;
				const position = new THREE.Vector3().setFromMatrixPosition(m);
				const distance = position.distanceTo(at);
				if (distance <= range) out.push({ key, info, position, distance });
			}
		}
		return out.sort((a, b) => a.distance - b.distance);
	}

	/** The creature or game object spawn nearest along a ray, if any, with its instance key. */
	pick(raycaster: THREE.Raycaster): { info: SpawnInfo; key: string; distance: number } | null {
		let best: { info: SpawnInfo; key: string; distance: number } | null = null;
		for (const entry of this.models.values()) {
			if (!entry.mesh?.visible || (entry.kind !== 'creature' && entry.kind !== 'object')) continue;
			for (const hit of raycaster.intersectObject(entry.mesh, false)) {
				if (hit.instanceId === undefined) continue;
				const key = entry.drawnKeys[hit.instanceId];
				const info = this.objects.get(key)?.placement.spawn;
				if (info && (!best || hit.distance < best.distance)) best = { info, key, distance: hit.distance };
				break; // hits are sorted; the first is this model's nearest
			}
		}
		return best;
	}

	stats(): ObjectStats {
		let instances = 0;
		let drawn = 0;
		let models = 0;
		for (const e of this.models.values()) {
			if (e.state === 'ready') models++;
			instances += e.instances.size;
			drawn += e.visible.size;
		}
		return { models, instances, drawn, loading: this.queue.length + this.requests * MODEL_BATCH };
	}
}

function liquidGeometry(positions: Float32Array, indices: Uint32Array): THREE.BufferGeometry {
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	// Model space is z-up.
	const normals = new Float32Array(positions.length);
	for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
	geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
	geometry.setIndex(new THREE.BufferAttribute(indices, 1));
	geometry.computeBoundingSphere();
	return geometry;
}
