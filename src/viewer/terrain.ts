import * as THREE from 'three';
import { CHUNKS_PER_TILE, TILE_CELLS, TILE_SIZE } from '../formats/adt';
import { WDL_CELLS } from '../formats/wdl';
import { ALPHA_ATLAS_SIZE, type SplatGeometry } from '../explorer/splatMesh';
import type { FarTile, NearTile } from '../explorer/world';
import type { TerrainGeometry } from '../explorer/terrainMesh';
import type { AsyncStorageApi } from '../worker/protocol';
import type { ClutterManager } from './clutter';
import type { ObjectLevel, ObjectManager } from './objects';
import { TextureCache } from './textureCache';
import { createAlphaTexture, createFarMaterial, createSplatMaterial, liquidMaterial, releaseLiquidMaterial, seaMask, type FlowBinding } from './terrainMaterials';
import { FAR_BATCH_LAYERS, FarBatch, type FarEntry } from './farBatch';
import { perf } from './perf';
import { useShadows } from './shadows';
import { WALL_MATERIAL } from './invisibleWalls';
import { createTexture } from './textures';

/** Full-detail tiles load within this distance of the camera and unload beyond the drop distance. */
const NEAR_LOAD_DISTANCE = 900;
const NEAR_DROP_DISTANCE = 1400;
const MAX_NEAR_IN_FLIGHT = 3;
/** Buildings show out to this distance; scattered doodads only on full-detail tiles. */
const WMO_DISTANCE = 3000;
/** Yards above a tile's highest ground that its trees and buildings may reach, for a screenshot's view (see holdInView). */
const HELD_OBJECT_HEIGHT = 60;
const FAR_TEXTURE_SIZE = 128;
const FAR_TEXTURE_BATCH = 32;

export interface ContinentPlacement {
	name: string;
	/** Map.db2 ID (0 Eastern Kingdoms, 1 Kalimdor). */
	mapId: number;
	wdt: number;
	/** Where the continent's tile (0, 0) sits in the shared world grid, in tiles. */
	offsetX: number;
	offsetY: number;
	/** Set for every map but the continents (dungeons, raids, battlegrounds...): laid out in the sea south of them. */
	instance?: boolean;
	/** A map that couldn't be laid out with the rest, placed far off on its own. */
	apart?: boolean;
	/** A map that's one building (most dungeons), no terrain: where it lies, in world yards (x, z). */
	building?: THREE.Box2;
}

interface TileState {
	continent: ContinentPlacement;
	x: number;
	y: number;
	/** World-space north-west corner. */
	originX: number;
	originZ: number;
	hasAdt: boolean;
	maxHeight: number;
	/** Low-detail mesh (its batch and place in it) and heights; null on a WMO-only map's tiles, which only carry objects. */
	far: { batch: FarBatch; id: number } | null;
	farHeights: Float32Array | null;
	near: NearState | null;
	nearHeights: Float32Array | null;
	/** 128x128 hole flags while the tile is detailed. */
	nearHoles: Uint8Array | null;
	/** What each cell sounds like underfoot (footstep sound groups), while at full detail. */
	nearGround: Uint8Array | null;
	/** AreaTable ID per chunk while the tile is detailed. */
	areaIds: Uint32Array | null;
	/** Chunks (y * 16 + x) the sea covers, from the tile's own ocean surfaces, once read in detail. */
	seaChunks: Uint8Array | null;
	nearLoading: boolean;
	/** Its full-detail files couldn't be read: not tried again. */
	nearFailed: boolean;
	distance: number;
	objectLevel: ObjectLevel;
}

/** A loaded full-detail tile and everything that must be released when it unloads. */
interface NearState {
	object: THREE.Group;
	geometries: THREE.BufferGeometry[];
	materials: THREE.Material[];
	ownTextures: THREE.Texture[];
	/** Water materials made for this tile's flow map, released with it. */
	flowMaterials: THREE.Material[];
	sharedTextures: number[];
	/** The tile's liquid surfaces (lakes, rivers, sea). */
	liquids: THREE.Mesh[];
	/** 1 per chunk (y * 16 + x) the map marks as impassable, or null if it marks none. */
	impassable: Uint8Array | null;
	/** Those chunks' ground, drawn over while invisible walls are shown. */
	walls: THREE.Mesh | null;
}

export interface TerrainStats {
	farTiles: number;
	farTextures: number;
	nearTiles: number;
	nearLoading: number;
	layerTextures: number;
}

function toBufferGeometry(g: TerrainGeometry | SplatGeometry): THREE.BufferGeometry {
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
	geometry.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
	geometry.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2));
	geometry.setAttribute('skirt', new THREE.BufferAttribute(g.skirt, 1));
	if ('colors' in g) {
		geometry.setAttribute('color', new THREE.BufferAttribute(g.colors, 3));
		geometry.setAttribute('chunkIndex', new THREE.BufferAttribute(g.chunks, 1));
	}
	geometry.setIndex(new THREE.BufferAttribute(g.indices, 1));
	geometry.computeBoundingSphere();
	geometry.computeBoundingBox();
	return geometry;
}

function liquidGeometry(positions: Float32Array, indices: Uint32Array): THREE.BufferGeometry {
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	const normals = new Float32Array(positions.length);
	for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
	geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
	geometry.setIndex(new THREE.BufferAttribute(indices, 1));
	geometry.computeBoundingSphere();
	return geometry;
}

/** Bilinear sample of an (n+1)x(n+1) outer height grid at tile-local coordinates. */
/** Yards the impassable ground's overlay sits above the ground. */
const IMPASSABLE_LIFT = 0.4;

function sampleGrid(heights: Float32Array, n: number, lx: number, lz: number): number {
	const fx = THREE.MathUtils.clamp((lx / TILE_SIZE) * n, 0, n);
	const fz = THREE.MathUtils.clamp((lz / TILE_SIZE) * n, 0, n);
	const x0 = Math.min(Math.floor(fx), n - 1);
	const z0 = Math.min(Math.floor(fz), n - 1);
	const tx = fx - x0;
	const tz = fz - z0;
	const row = n + 1;
	const h00 = heights[z0 * row + x0];
	const h10 = heights[z0 * row + x0 + 1];
	const h01 = heights[(z0 + 1) * row + x0];
	const h11 = heights[(z0 + 1) * row + x0 + 1];
	return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

/**
 * Owns every terrain tile in the world. All tiles always have a low-detail mesh from the
 * WDL; tiles near the camera swap to their full ADT mesh and texture.
 */
export class TerrainManager {
	readonly group = new THREE.Group();
	private readonly tiles = new Map<string, TileState>();
	private nearInFlight = 0;
	private farTexturesLoaded = 0;
	private farTexturesTotal = 0;
	private readonly layerTextures: TextureCache;
	/** Ground clutter is handed each detailed tile's clutter map. */
	clutter: ClutterManager | null = null;
	/** Sends a texture to the GPU, resolving once it's there; the low-detail tiles' maps wait for it before they're drawn. */
	preloadTexture: (texture: THREE.Texture) => Promise<void> = async () => {};

	constructor(
		private readonly storage: AsyncStorageApi,
		private readonly compressed: boolean,
		private readonly anisotropy: number,
		private readonly objects: ObjectManager,
		private readonly prepare: (object: THREE.Object3D) => Promise<void>,
	) {
		this.layerTextures = new TextureCache(storage, compressed, anisotropy);
	}

	private static objectKey(t: TileState): string {
		return `${t.continent.wdt}:${t.x}_${t.y}`;
	}

	private static key(gx: number, gy: number): string {
		return `${gx},${gy}`;
	}

	addContinent(continent: ContinentPlacement, farTiles: FarTile[]): void {
		// Batches of tiles in the order given (rows of the map), each with at most so many textures.
		const batches: FarTile[][] = [];
		let textured = Infinity;
		for (const t of farTiles) {
			if (t.hasAdt && textured >= FAR_BATCH_LAYERS) {
				batches.push([]);
				textured = 0;
			}
			if (!batches.length) batches.push([]);
			batches[batches.length - 1].push(t);
			if (t.hasAdt) textured++;
		}
		for (const tiles of batches) this.addFarBatch(continent, tiles);
	}

	private addFarBatch(continent: ContinentPlacement, farTiles: FarTile[]): void {
		const entries = farTiles.map((t): FarEntry => ({
			geometry: toBufferGeometry(t.geometry),
			position: new THREE.Vector3((t.x + continent.offsetX) * TILE_SIZE, 0, (t.y + continent.offsetY) * TILE_SIZE),
			// Sea-floor tiles without an ADT get a colour close to deep water so they don't show as blocks.
			color: t.hasAdt ? 0x5f6d48 : 0x14303f,
			textured: t.hasAdt,
		}));
		const batch = new FarBatch(entries, this.anisotropy, (texture) => this.preloadTexture(texture));
		batch.mesh.matrixAutoUpdate = false;
		// Shadows only reach a short way; the near tiles there cast them. Hundreds of far tiles
		// in the sun's view would each cost draws in the shadow pass.
		batch.mesh.receiveShadow = true;
		this.group.add(batch.mesh);
		farTiles.forEach((t, i) => {
			const gx = t.x + continent.offsetX;
			const gy = t.y + continent.offsetY;
			const far = { batch, id: batch.ids[i] };

			let maxHeight = -Infinity;
			for (const h of t.heights) maxHeight = Math.max(maxHeight, h);
			this.tiles.set(TerrainManager.key(gx, gy), {
				continent,
				x: t.x,
				y: t.y,
				originX: gx * TILE_SIZE,
				originZ: gy * TILE_SIZE,
				hasAdt: t.hasAdt,
				maxHeight,
				far,
				farHeights: t.heights,
				near: null,
				nearHeights: null,
				nearHoles: null,
				nearGround: null,
				areaIds: null,
				seaChunks: null,
				nearLoading: false,
				nearFailed: false,
				distance: Infinity,
				objectLevel: 'none',
			});
		});
	}

	/**
	 * Tiles without a low-detail mesh. For a map without terrain (a WMO-only dungeon) they only
	 * stream its building, objects and spawns as the camera comes near; with terrain (maps that
	 * have no WDL), they also load their full-detail terrain then, and show nothing from afar.
	 */
	addObjectTiles(continent: ContinentPlacement, coords: [number, number][], terrain = false): void {
		for (const [x, y] of coords) {
			const gx = x + continent.offsetX;
			const gy = y + continent.offsetY;
			this.tiles.set(TerrainManager.key(gx, gy), {
				continent,
				x,
				y,
				originX: gx * TILE_SIZE,
				originZ: gy * TILE_SIZE,
				hasAdt: terrain,
				maxHeight: Infinity,
				far: null,
				farHeights: null,
				near: null,
				nearHeights: null,
				nearHoles: null,
				nearGround: null,
				areaIds: null,
				seaChunks: null,
				nearLoading: false,
				nearFailed: false,
				distance: Infinity,
				objectLevel: 'none',
			});
		}
	}

	/** Where the open sea is: one flag per WDL cell over the continents, from buildSeaMask. */
	private sea: { flags: Uint8Array; width: number; height: number; originX: number; originZ: number; texture: THREE.DataTexture } | null = null;

	/**
	 * Works out where the open sea is, for the sea-level plane and the sea-floor tint: from the
	 * open water around and between the continents, across every low-detail cell that dips below
	 * sea level. Land below sea level walled off from the coast (Thousand Needles, the Shimmering
	 * Flats) stays dry, as in the game, where only the map's own ocean surfaces are sea. The other
	 * maps laid out in the sea count the same way where they have low-detail terrain; the sea
	 * covers the rest of them (see Viewer's sea hole for maps that are only a building). That's a
	 * guess, which floods dry land below sea level near a coast; tiles read in detail replace it
	 * with their own ocean surfaces (applySea).
	 */
	buildSeaMask(): void {
		const box = this.bounds();
		const cell = TILE_SIZE / WDL_CELLS;
		const width = Math.round((box.max.x - box.min.x) / cell);
		const height = Math.round((box.max.y - box.min.y) / cell);
		// Each cell's lowest corner; cells no tile covers are open water.
		const low = new Float32Array(width * height).fill(-Infinity);
		const row = WDL_CELLS + 1;
		for (const t of this.tiles.values()) {
			if (!t.farHeights) continue;
			const h = t.farHeights;
			const x0 = Math.round((t.originX - box.min.x) / cell);
			const z0 = Math.round((t.originZ - box.min.y) / cell);
			for (let j = 0; j < WDL_CELLS; j++) {
				for (let i = 0; i < WDL_CELLS; i++) {
					const k = j * row + i;
					low[(z0 + j) * width + x0 + i] = Math.min(h[k], h[k + 1], h[k + row], h[k + row + 1]);
				}
			}
		}
		const flags = new Uint8Array(width * height);
		const queue = new Int32Array(width * height);
		let head = 0;
		let tail = 0;
		const flood = (k: number) => {
			if (flags[k] || !(low[k] < 0)) return;
			flags[k] = 255;
			queue[tail++] = k;
		};
		for (let k = 0; k < low.length; k++) if (low[k] === -Infinity) flood(k);
		for (let x = 0; x < width; x++) {
			flood(x);
			flood((height - 1) * width + x);
		}
		for (let z = 0; z < height; z++) {
			flood(z * width);
			flood(z * width + width - 1);
		}
		while (head < tail) {
			const k = queue[head++];
			const x = k % width;
			if (x > 0) flood(k - 1);
			if (x < width - 1) flood(k + 1);
			if (k >= width) flood(k - width);
			if (k + width < flags.length) flood(k + width);
		}
		const texture = new THREE.DataTexture(flags, width, height, THREE.RedFormat, THREE.UnsignedByteType);
		texture.unpackAlignment = 1;
		texture.magFilter = THREE.LinearFilter;
		texture.minFilter = THREE.LinearFilter;
		this.sea = { flags, width, height, originX: box.min.x, originZ: box.min.y, texture };
		// Tiles already read in detail know better.
		for (const t of this.tiles.values()) this.applySea(t);
		texture.needsUpdate = true;
		seaMask.uSeaMask.value = texture;
		seaMask.uSeaBounds.value.set(box.min.x, box.min.y, 1 / (width * cell), 1 / (height * cell));
	}

	/**
	 * Puts a tile's own ocean surfaces into the sea mask in place of the guess, one flag per
	 * chunk (a WDL cell is a chunk). Returns whether the mask changed.
	 */
	private applySea(t: TileState): boolean {
		const s = this.sea;
		if (!s || !t.seaChunks || t.continent.apart) return false;
		const cell = TILE_SIZE / WDL_CELLS;
		const x0 = Math.round((t.originX - s.originX) / cell);
		const z0 = Math.round((t.originZ - s.originZ) / cell);
		let changed = false;
		for (let j = 0; j < WDL_CELLS; j++) {
			for (let i = 0; i < WDL_CELLS; i++) {
				const k = (z0 + j) * s.width + x0 + i;
				const flag = t.seaChunks[j * WDL_CELLS + i] ? 255 : 0;
				if (s.flags[k] !== flag) {
					s.flags[k] = flag;
					changed = true;
				}
			}
		}
		return changed;
	}

	/** Whether a world position is open sea (at sea level); anywhere past the continents is. */
	isSea(x: number, z: number): boolean {
		const s = this.sea;
		if (!s) return true;
		const cell = TILE_SIZE / WDL_CELLS;
		const cx = Math.floor((x - s.originX) / cell);
		const cz = Math.floor((z - s.originZ) / cell);
		if (cx < 0 || cz < 0 || cx >= s.width || cz >= s.height) return true;
		return s.flags[cz * s.width + cx] > 0;
	}

	/** World-space bounds of every map's tiles, in yards (except any laid out apart). */
	bounds(): THREE.Box2 {
		const box = new THREE.Box2();
		for (const t of this.tiles.values()) {
			if (t.continent.apart) continue;
			box.expandByPoint(new THREE.Vector2(t.originX, t.originZ));
			box.expandByPoint(new THREE.Vector2(t.originX + TILE_SIZE, t.originZ + TILE_SIZE));
		}
		return box;
	}

	/**
	 * Where to look to frame a continent: the centre of mass of its land tiles and the
	 * north-south span of the middle 90%, so stray islands don't pull the view off.
	 */
	focus(continent: ContinentPlacement): { center: THREE.Vector2; extent: number } {
		const land = [...this.tiles.values()].filter((t) => t.continent === continent && t.hasAdt);
		const center = new THREE.Vector2();
		for (const t of land) center.add(new THREE.Vector2(t.originX + TILE_SIZE / 2, t.originZ + TILE_SIZE / 2));
		center.divideScalar(Math.max(1, land.length));
		const zs = land.map((t) => t.originZ).sort((a, b) => a - b);
		const extent = zs.length ? zs[Math.floor(zs.length * 0.95)] - zs[Math.floor(zs.length * 0.05)] + TILE_SIZE : TILE_SIZE;
		return { center, extent };
	}

	/**
	 * Streams low-detail textures for every tile (or just one map's, when given), nearest to the
	 * given point first.
	 */
	async loadFarTextures(near: THREE.Vector3, only?: ContinentPlacement): Promise<void> {
		const pending = [...this.tiles.values()].filter((t) => t.far && t.hasAdt && (!only || t.continent === only));
		this.farTexturesTotal += pending.length;
		pending.sort((a, b) => this.planarDistance(a, near) - this.planarDistance(b, near));
		const byContinent = new Map<number, TileState[]>();
		for (let i = 0; i < pending.length; i += FAR_TEXTURE_BATCH) {
			byContinent.clear();
			for (const t of pending.slice(i, i + FAR_TEXTURE_BATCH)) {
				const list = byContinent.get(t.continent.wdt) ?? [];
				list.push(t);
				byContinent.set(t.continent.wdt, list);
			}
			await Promise.all([...byContinent].map(async ([wdt, list]) => {
				const results = await this.storage.loadTileTextures(wdt, list.map((t) => [t.x, t.y]), FAR_TEXTURE_SIZE, this.compressed);
				results.forEach((r, k) => {
					if (!r.texture) return;
					const { batch, id } = list[k].far!;
					if (batch.setTexture(id, r.texture)) this.farTexturesLoaded++;
					else console.warn(`Tile ${list[k].continent.name} ${list[k].x}_${list[k].y}: its map texture doesn't fit its batch's`);
				});
			}));
		}
	}

	private planarDistance(t: TileState, p: THREE.Vector3): number {
		const dx = Math.max(t.originX - p.x, 0, p.x - (t.originX + TILE_SIZE));
		const dz = Math.max(t.originZ - p.z, 0, p.z - (t.originZ + TILE_SIZE));
		return Math.hypot(dx, dz);
	}

	/** Tiles held at full detail for a screenshot, however far off (see holdInView). */
	private held: Set<TileState> | null = null;

	/**
	 * For a screenshot: holds the tiles in the camera's view at full detail, with all their
	 * objects, whatever their distance; the nearest `max` of them. seen, when given, leaves out
	 * tiles hidden behind the ground or buildings (from a cave, all the land overhead). Null lets
	 * them go again. Returns how many tiles are held.
	 */
	holdInView(camera: THREE.Camera | null, max = Infinity, seen?: (box: THREE.Box3) => boolean): number {
		if (!camera) {
			this.held = null;
			return 0;
		}
		const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
		const box = new THREE.Box3();
		const at = camera.getWorldPosition(new THREE.Vector3());
		const inView: TileState[] = [];
		for (const t of this.tiles.values()) {
			if (!t.hasAdt && t.far) continue;
			// Heights below the lowest sea floor and above the highest peaks, where not known.
			box.min.set(t.originX, -1000, t.originZ);
			box.max.set(t.originX + TILE_SIZE, Math.min(t.maxHeight, 5000), t.originZ + TILE_SIZE);
			if (!frustum.intersectsBox(box)) continue;
			// Raised for the trees and buildings standing on it, which can show over a ridge in front.
			box.max.y += HELD_OBJECT_HEIGHT;
			if (seen && !seen(box)) continue;
			t.distance = Math.hypot(this.planarDistance(t, at), Math.max(0, at.y - t.maxHeight));
			inView.push(t);
		}
		inView.sort((a, b) => a.distance - b.distance);
		this.held = new Set(inView.slice(0, max));
		return this.held.size;
	}

	/** Held tiles whose full detail is still to load. */
	get heldPending(): number {
		let n = 0;
		for (const t of this.held ?? []) if (t.hasAdt && !t.near && !t.nearFailed) n++;
		return n;
	}

	/** Whether every tile close enough for full detail at the last update has it (or couldn't). */
	get nearShown(): boolean {
		for (const t of this.tiles.values()) {
			if (t.hasAdt && t.distance < NEAR_LOAD_DISTANCE && !t.near && !t.nearFailed) return false;
		}
		return true;
	}

	/** Chooses which tiles need full detail, loading nearest first and dropping distant ones. */
	update(camera: THREE.Vector3): void {
		const wanted: TileState[] = [];
		const levels: TileState[] = [];
		for (const t of this.tiles.values()) {
			const objectsOnly = !t.far;
			if (!t.hasAdt && !objectsOnly) continue;
			const dy = Math.max(0, camera.y - t.maxHeight);
			t.distance = Math.hypot(this.planarDistance(t, camera), dy);
			const held = this.held?.has(t) ?? false;
			if (t.near && t.distance > NEAR_DROP_DISTANCE && !held) this.dropNear(t);
			else if (t.hasAdt && !t.near && !t.nearLoading && !t.nearFailed && (t.distance < NEAR_LOAD_DISTANCE || held)) wanted.push(t);
			// Doodads wait for the detailed terrain so they sit on the right ground.
			const detailed = t.hasAdt ? !!t.near : t.distance < NEAR_LOAD_DISTANCE || held;
			const level: ObjectLevel = detailed ? 'all' : t.distance < WMO_DISTANCE || held ? 'wmo' : 'none';
			if (level !== t.objectLevel) {
				t.objectLevel = level;
				levels.push(t);
			}
		}
		// Nearest first: their objects are read in the order asked for (see THROTTLED in client.ts).
		levels.sort((a, b) => a.distance - b.distance);
		for (const t of levels) {
			const offset = new THREE.Vector3(t.continent.offsetX * TILE_SIZE, 0, t.continent.offsetY * TILE_SIZE);
			this.objects.setTileLevel(TerrainManager.objectKey(t), t.continent.wdt, t.x, t.y, offset, t.objectLevel);
		}
		wanted.sort((a, b) => a.distance - b.distance);
		for (const t of wanted) {
			if (this.nearInFlight >= MAX_NEAR_IN_FLIGHT) break;
			void this.loadNear(t);
		}
	}

	private async loadNear(t: TileState): Promise<void> {
		t.nearLoading = true;
		this.nearInFlight++;
		const name = `${t.continent.name} ${t.x}_${t.y}`;
		const start = performance.now();
		perf.log('tile', `${name}: loading (${this.nearInFlight} in flight)`);
		try {
			const tile = await this.storage.loadNearTile(t.continent.wdt, t.x, t.y, this.compressed);
			const read = performance.now();
			const sharedTextures = tile.terrain?.textures ?? [];
			const textures = await this.layerTextures.acquire(sharedTextures);
			const textured = performance.now();
			// The camera may have moved on while this loaded.
			if (t.distance > NEAR_DROP_DISTANCE && !this.held?.has(t)) {
				this.layerTextures.release(sharedTextures);
				perf.log('tile', `${name}: left behind before it was shown`);
				return;
			}
			const near = perf.time('near.build', () => this.buildNear(tile, textures, sharedTextures, t.originX, t.originZ));
			const built = performance.now();
			await this.prepare(near.object);
			const ms = (from: number, to: number) => (to - from).toFixed(0);
			perf.log('tile', `${name}: shown after ${ms(start, performance.now())} ms (read ${ms(start, read)}, ${sharedTextures.length} textures ${ms(read, textured)}, build ${ms(textured, built)}, shaders and upload ${ms(built, performance.now())}; ${tile.liquids.length} liquids)`);
			t.near = near;
			t.near.object.position.set(t.originX, 0, t.originZ);
			t.near.object.updateMatrixWorld(true);
			this.group.add(t.near.object);
			t.nearHeights = tile.heights;
			t.nearHoles = tile.holes;
			t.nearGround = tile.ground;
			t.areaIds = tile.areaIds;
			this.syncWalls(t);
			// Kept after the tile drops back to low detail: it's what the map says, not a guess.
			t.seaChunks = tile.sea;
			this.clutter?.addTile(TerrainManager.objectKey(t), t.originX, t.originZ, tile.clutter);
			if (this.applySea(t)) this.sea!.texture.needsUpdate = true;
			if (t.far) t.far.batch.setVisible(t.far.id, false);
		} catch (e) {
			perf.log('tile', `${name}: failed: ${(e as Error).message}`);
			console.warn(`Tile ${t.continent.name} ${t.x}_${t.y}:`, e);
			t.nearFailed = true;
		} finally {
			t.nearLoading = false;
			this.nearInFlight--;
		}
	}

	/** originX, originZ: the tile's corner in the world, where it will be placed. */
	private buildNear(tile: NearTile, textures: Map<number, THREE.Texture | null>, sharedTextures: number[], originX: number, originZ: number): NearState {
		const state: NearState = { object: new THREE.Group(), geometries: [], materials: [], ownTextures: [], flowMaterials: [], sharedTextures, liquids: [], impassable: tile.impassable.includes(1) ? tile.impassable : null, walls: null };
		const add = (geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[]) => {
			const mesh = new THREE.Mesh(geometry, material);
			mesh.matrixAutoUpdate = false;
			useShadows(mesh);
			state.object.add(mesh);
			state.geometries.push(geometry);
			return mesh;
		};

		if (tile.terrain) {
			const alpha = createAlphaTexture(tile.terrain.alpha, ALPHA_ATLAS_SIZE);
			state.ownTextures.push(alpha);
			const geometry = toBufferGeometry(tile.terrain.geometry);
			const materials = tile.terrain.groups.map((g, i) => {
				geometry.addGroup(g.start, g.count, i);
				return createSplatMaterial(alpha, g.layers, textures);
			});
			state.materials.push(...materials);
			add(geometry, materials);
		} else if (tile.fallback) {
			const map = tile.fallback.texture ? createTexture(tile.fallback.texture, this.anisotropy) : null;
			if (map) state.ownTextures.push(map);
			const material = createFarMaterial(map ? 0xffffff : 0x5f6d48);
			material.map = map;
			state.materials.push(material);
			add(toBufferGeometry(tile.fallback.geometry), material);
		}

		// The tile's river flow map, for its water surfaces (see bindFlow).
		const flowData = tile.flow?.format === 'rgba' ? tile.flow.mips[0] : null;
		let flow: FlowBinding | null = null;
		if (flowData) {
			const texture = new THREE.DataTexture(flowData.data, flowData.width, flowData.height, THREE.RGBAFormat);
			texture.magFilter = texture.minFilter = THREE.LinearFilter;
			texture.needsUpdate = true;
			state.ownTextures.push(texture);
			flow = { texture, x: originX, z: originZ };
		}
		for (const liquid of tile.liquids) {
			// Shared materials (one per liquid type); drawn after the terrain so the ground shows through.
			const material = liquidMaterial(liquid.kind, liquid.type, liquid.kind === 'magma' ? null : flow);
			if (flow) state.flowMaterials.push(material);
			const mesh = add(liquidGeometry(liquid.positions, liquid.indices), material);
			mesh.renderOrder = 1;
			mesh.castShadow = false;
			mesh.userData.liquidType = liquid.type;
			state.liquids.push(mesh);
		}
		return state;
	}

	private wallsShown = false;

	/** Draws the ground the map marks as impassable in the invisible walls' colour (see invisibleWalls.ts). */
	set invisibleWalls(shown: boolean) {
		if (shown === this.wallsShown) return;
		this.wallsShown = shown;
		for (const t of this.tiles.values()) this.syncWalls(t);
	}

	/** Adds or removes a detailed tile's impassable ground, as invisible walls are shown or not. */
	private syncWalls(t: TileState): void {
		const near = t.near;
		if (!near?.impassable || !t.nearHeights || this.wallsShown === !!near.walls) return;
		if (near.walls) {
			near.object.remove(near.walls);
			near.walls.geometry.dispose();
			near.walls = null;
			return;
		}
		const cells = TILE_CELLS / CHUNKS_PER_TILE;
		const row = TILE_CELLS + 1;
		const size = TILE_SIZE / TILE_CELLS;
		const positions: number[] = [];
		const indices: number[] = [];
		near.impassable.forEach((marked, chunk) => {
			if (!marked) return;
			const x0 = (chunk % CHUNKS_PER_TILE) * cells;
			const z0 = Math.floor(chunk / CHUNKS_PER_TILE) * cells;
			const base = positions.length / 3;
			// Lifted a little: the ground's own mesh has a point in the middle of each cell, which can stand above this.
			for (let z = z0; z <= z0 + cells; z++) {
				for (let x = x0; x <= x0 + cells; x++) positions.push(x * size, t.nearHeights![z * row + x] + IMPASSABLE_LIFT, z * size);
			}
			for (let z = 0; z < cells; z++) {
				for (let x = 0; x < cells; x++) {
					const a = base + z * (cells + 1) + x;
					indices.push(a, a + cells + 1, a + 1, a + 1, a + cells + 1, a + cells + 2);
				}
			}
		});
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
		geometry.setIndex(indices);
		near.walls = new THREE.Mesh(geometry, WALL_MATERIAL);
		near.walls.matrixAutoUpdate = false;
		// After the water, so marked ground under it still shows.
		near.walls.renderOrder = 2;
		near.object.add(near.walls);
		near.walls.updateMatrixWorld(true);
	}

	private dropNear(t: TileState): void {
		if (!t.near) return;
		perf.log('tile', `${t.continent.name} ${t.x}_${t.y}: dropped`);
		const near = t.near;
		this.group.remove(near.object);
		near.walls?.geometry.dispose();
		for (const g of near.geometries) g.dispose();
		for (const m of near.materials) m.dispose();
		for (const tex of near.ownTextures) tex.dispose();
		for (const m of near.flowMaterials) releaseLiquidMaterial(m);
		this.layerTextures.release(near.sharedTextures);
		perf.record('near.drop', 0);
		this.clutter?.removeTile(TerrainManager.objectKey(t));
		t.near = null;
		t.nearHeights = null;
		t.nearHoles = null;
		t.nearGround = null;
		t.areaIds = null;
		if (t.far) t.far.batch.setVisible(t.far.id, true);
	}
	private tileAt(x: number, z: number): TileState | undefined {
		return this.tiles.get(TerrainManager.key(Math.floor(x / TILE_SIZE), Math.floor(z / TILE_SIZE)));
	}

	/** Terrain height at a world position, from the most detailed data loaded; -Infinity off the map. */
	heightAt(x: number, z: number): number {
		const t = this.tileAt(x, z);
		// A hole (cave or mine entrance) has no ground to stand on.
		if (t?.nearHoles) {
			const cx = Math.floor(((x - t.originX) / TILE_SIZE) * TILE_CELLS);
			const cz = Math.floor(((z - t.originZ) / TILE_SIZE) * TILE_CELLS);
			if (cx >= 0 && cz >= 0 && cx < TILE_CELLS && cz < TILE_CELLS && t.nearHoles[cz * TILE_CELLS + cx]) return -Infinity;
		}
		return this.surfaceAt(x, z);
	}

	/** Height of the terrain surface, ignoring holes: what counts as above or below ground. */
	surfaceAt(x: number, z: number): number {
		const t = this.tileAt(x, z);
		if (!t) return -Infinity;
		const lx = x - t.originX;
		const lz = z - t.originZ;
		if (t.nearHeights) return sampleGrid(t.nearHeights, TILE_CELLS, lx, lz);
		// A WMO-only map has no terrain at all.
		return t.farHeights ? sampleGrid(t.farHeights, WDL_CELLS, lx, lz) : -Infinity;
	}

	/** Whether the terrain at a world position has loaded in full detail (heights and holes). */
	detailedAt(x: number, z: number): boolean {
		return !!this.tileAt(x, z)?.nearHeights;
	}

	/**
	 * What the ground sounds like underfoot at a world position: its footstep sound group (1 dirt,
	 * 3 stone, 6 grass...), from the texture covering most of the cell; 0 where unknown.
	 */
	groundAt(x: number, z: number): number {
		const t = this.tileAt(x, z);
		if (!t?.nearGround) return 0;
		const cx = THREE.MathUtils.clamp(Math.floor(((x - t.originX) / TILE_SIZE) * TILE_CELLS), 0, TILE_CELLS - 1);
		const cz = THREE.MathUtils.clamp(Math.floor(((z - t.originZ) / TILE_SIZE) * TILE_CELLS), 0, TILE_CELLS - 1);
		return t.nearGround[cz * TILE_CELLS + cx];
	}

	/** Liquid surfaces of the detailed tile at a world position (for telling if a point is under water). */
	liquidsAt(x: number, z: number): THREE.Mesh[] {
		return this.tileAt(x, z)?.near?.liquids ?? [];
	}

	/** AreaTable ID at a world position, if its tile is loaded in detail. */
	areaAt(x: number, z: number): number | null {
		const t = this.tileAt(x, z);
		if (!t?.areaIds) return null;
		const cx = THREE.MathUtils.clamp(Math.floor((x - t.originX) / (TILE_SIZE / 16)), 0, 15);
		const cy = THREE.MathUtils.clamp(Math.floor((z - t.originZ) / (TILE_SIZE / 16)), 0, 15);
		return t.areaIds[cy * 16 + cx] || null;
	}

	/** Which continent and tile a world position falls in. */
	locate(x: number, z: number): { continent: ContinentPlacement; tileX: number; tileY: number } | null {
		const t = this.tileAt(x, z);
		return t ? { continent: t.continent, tileX: t.x, tileY: t.y } : null;
	}

	stats(): TerrainStats {
		let nearTiles = 0;
		for (const t of this.tiles.values()) if (t.near) nearTiles++;
		return { farTiles: this.tiles.size, farTextures: this.farTexturesLoaded, nearTiles, nearLoading: this.nearInFlight, layerTextures: this.layerTextures.size };
	}

	get farTextureProgress(): [number, number] {
		return [this.farTexturesLoaded, this.farTexturesTotal];
	}
}
