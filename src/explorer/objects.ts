import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { CascStorage } from '../casc/storage';
import { chunks } from '../formats/chunks';
import { Blend, M2_MATERIAL_TWO_SIDED, M2_MATERIAL_UNFOGGED, M2_MATERIAL_UNLIT, parseM2, parseSkin, type M2File, type M2Skin } from '../formats/m2';
import { ANIM, attachmentPoints, externalSequences, m2Skeleton, sequenceAnimation, skelSkeleton, skinVertex, standAnimation, standPose, type AnimationClip, type AttachmentPoint, type BoneAnimation, type Skeleton } from '../formats/m2Pose';
import { parseParticleEmitters, type ParticleEmitter } from '../formats/m2Particles';
import {
	parseWmoGroup, parseWmoRoot, WMO_GROUP_INTERIOR, WMO_LIQUID_CELL, type WmoGroup, visibleWmoGroups, WMO_MATERIAL_TWO_SIDED, WMO_MATERIAL_UNFOGGED, WMO_MATERIAL_UNLIT,
} from '../formats/wmo';
import type { LiquidKind } from '../formats/mh2o';
import { TILE_SIZE } from '../formats/adt';
import type { WdtGlobalWmo } from '../formats/wdt';
import type { LiquidMesh } from './liquidMesh';
import type { SpawnInfo, SpawnMovement } from './spawns';
import { compose, fromQuaternion, multiply, rotationX, rotationY, rotationZ, scaling, translation, type Mat4 } from './mat4';

const MDDF_FILE_ID = 0x40;
const MODF_FILE_ID = 0x8;
const MODF_HAS_SCALE = 0x4;

export type ObjectKind = 'm2' | 'wmo' | 'creature' | 'object';

export interface Placement {
	/** creature and object placements carry a display ID in fdid rather than a file ID. */
	kind: ObjectKind;
	/** Unique across the continent; objects spanning tiles are listed by each tile. */
	uid: number;
	fdid: number;
	/** Model space -> continent space (x east, y up, z south). */
	matrix: Mat4;
	doodadSet: number;
	/** WMOs: the name set, which picks this placement's rows in WMOAreaTable. */
	nameSet?: number;
	/** Set for creature and game object spawns (VMaNGOS data), for the info panel. */
	spawn?: SpawnInfo;
	/** Distinguishes looks that share a display ID, e.g. held weapons (main_off_shield). */
	variant?: string;
	/** Creatures that walk: their waypoints or wander radius. */
	movement?: SpawnMovement;
}

export interface ModelMaterial {
	texture: number;
	blend: number;
	twoSided: boolean;
	unlit: boolean;
	unfogged: boolean;
	opacity: number;
	/** Steady texture scroll in texture units per second (fire, lava, waterfalls). */
	uvScroll?: [number, number];
	/** Never drawn: a building's collision-only triangles, there to be walked on and bumped into. */
	collision?: true;
	/** Buildings: the TerrainType it's made of, for what footsteps on it sound like (0 none). */
	ground?: number;
}

export interface ModelBatch {
	start: number;
	count: number;
	material: ModelMaterial;
	/** Draw order within the model (M2 priority planes and material layers). */
	order: number;
}

export interface ModelData {
	fdid: number;
	positions: Float32Array;
	normals: Float32Array;
	uvs: Float32Array;
	/** WMOs: per-vertex baked interior light (linear RGB) and how much to use it (A), or null. */
	baked: Float32Array | null;
	indices: Uint32Array;
	batches: ModelBatch[];
	/** Bounding radius in model units, for view-distance culling. */
	radius: number;
	/** Top of the model above its origin (model z), for placing name plates. */
	height: number;
	/** WMOs only: doodad sets, each a list of models placed in the WMO's local space. */
	doodadSets?: { name: string; doodads: { fdid: number; matrix: Mat4 }[] }[];
	/** Moving models: the Stand loop for GPU skinning, and each vertex's bones (4 indices, weights 0-255). */
	animation?: ModelAnimation;
	/** WMOs only: liquid surfaces in model space. */
	liquids?: LiquidMesh[];
	/** WMOs: the building's WMOAreaTable ID and its groups' bounds, for finding the room you're in. */
	areas?: WmoAreas;
	/** M2 particle emitters (fire, smoke, sparks), including those of worn gear. */
	emitters?: ParticleEmitter[];
	/** Creatures: which footsteps they make (FootstepTerrainLookup's creature column; 0 none). */
	footstep?: number;
	/** WMOs only: a serialised ray-cast acceleration structure (three-mesh-bvh, indirect), for line of sight. */
	bvh?: SerializedBvh;
	/**
	 * Solid M2s (trees, rocks, logs): the model's own collision mesh, never drawn, and its ray-cast
	 * structure, for walking into and onto them.
	 */
	collision?: { positions: Float32Array; indices: Uint32Array; bvh: SerializedBvh };
}

export interface SerializedBvh {
	version: number;
	roots: ArrayBuffer[];
	indirectBuffer: Uint32Array | Uint16Array | null;
}

/**
 * Builds the ray-cast structure for a model in the worker, so the main thread never stalls on it.
 * Indirect mode leaves the index buffer (and so the material ranges) untouched.
 */
function buildBvh(positions: Float32Array, indices: Uint32Array): SerializedBvh {
	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new BufferAttribute(positions, 3));
	geometry.setIndex(new BufferAttribute(indices, 1));
	const serialized = MeshBVH.serialize(new MeshBVH(geometry, { indirect: true }), { cloneBuffers: false });
	// The version must travel with the data, or deserialize "upgrades" it from the old format.
	return { version: (serialized as { version?: number }).version ?? 1, roots: serialized.roots, indirectBuffer: serialized.indirectBuffer ?? null };
}

export interface WmoAreas {
	wmoId: number;
	groups: { id: number; interior: boolean; min: [number, number, number]; max: [number, number, number] }[];
}

export interface ModelAnimation {
	/** Identifies the skeleton, so looks sharing a model share one bone texture. */
	key: string;
	bones: number;
	/** Stand, then Walk (the same as Stand when the model has no walk). */
	clips: AnimationClip[];
	/** frames x bones x 12 floats (rows of each 3x4 bone matrix). */
	data: Float32Array;
	boneIndex: Uint16Array;
	boneWeight: Uint8Array;
}

/** ADT placement rotation (degrees) to a matrix: models are z-up; the world here is y-up. */
function placementMatrix(x: number, y: number, z: number, rx: number, ry: number, rz: number, scale: number): Mat4 {
	return compose(translation(x, y, z), rotationY(ry - 90), rotationZ(-rx), rotationX(rz - 90), scaling(scale));
}

/** Placement space puts the map's centre at (32, 32) tiles. */
const MAP_CENTRE = 32 * TILE_SIZE;

/** The placement of a WMO-only map's building: an ADT-style placement, relative to the map's centre. */
export function globalWmoPlacement(wmo: WdtGlobalWmo): Placement {
	const [x, y, z] = wmo.position;
	const [rx, ry, rz] = wmo.rotation;
	return {
		kind: 'wmo',
		fdid: wmo.fdid,
		uid: 0xffffffff,
		matrix: placementMatrix(MAP_CENTRE + x, y, MAP_CENTRE + z, rx, ry, rz, wmo.scale),
		doodadSet: wmo.doodadSet,
		nameSet: wmo.nameSet,
	};
}

/** Tiles a WMO-only map's building covers (x, y), from its bounds around the map's centre. */
export function globalWmoTiles(wmo: WdtGlobalWmo): [number, number][] {
	// The bounds' axes don't line up with the tiles' one for one; a square that holds them all will do.
	const reach = Math.max(...[...wmo.min, ...wmo.max].filter((_, i) => i % 3 !== 1).map(Math.abs)) + 50;
	const first = Math.floor((MAP_CENTRE - reach) / TILE_SIZE);
	const last = Math.floor((MAP_CENTRE + reach) / TILE_SIZE);
	const tiles: [number, number][] = [];
	for (let y = first; y <= last; y++) for (let x = first; x <= last; x++) tiles.push([x, y]);
	return tiles;
}

/** Reads M2 (MDDF) and WMO (MODF) placements from a tile's _obj0.adt. */
export function parsePlacements(bytes: Uint8Array): Placement[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out: Placement[] = [];
	const f = (o: number) => view.getFloat32(o, true);
	for (const c of chunks(bytes)) {
		if (c.id === 'MDDF') {
			for (let o = c.offset; o + 36 <= c.offset + c.size; o += 36) {
				const flags = view.getUint16(o + 34, true);
				if (!(flags & MDDF_FILE_ID)) continue;
				out.push({
					kind: 'm2',
					fdid: view.getUint32(o, true),
					uid: view.getUint32(o + 4, true),
					matrix: placementMatrix(f(o + 8), f(o + 12), f(o + 16), f(o + 20), f(o + 24), f(o + 28), view.getUint16(o + 32, true) / 1024),
					doodadSet: 0,
				});
			}
		} else if (c.id === 'MODF') {
			for (let o = c.offset; o + 64 <= c.offset + c.size; o += 64) {
				const flags = view.getUint16(o + 56, true);
				if (!(flags & MODF_FILE_ID)) continue;
				const scale = flags & MODF_HAS_SCALE ? view.getUint16(o + 62, true) / 1024 : 1;
				out.push({
					kind: 'wmo',
					fdid: view.getUint32(o, true),
					uid: view.getUint32(o + 4, true),
					matrix: placementMatrix(f(o + 8), f(o + 12), f(o + 16), f(o + 20), f(o + 24), f(o + 28), scale),
					doodadSet: view.getUint16(o + 58, true),
					nameSet: view.getUint16(o + 60, true),
				});
			}
		}
	}
	return out;
}

/** How a creature model is dressed: textures for runtime texture types, and which geosets to show. */
export interface M2Options {
	/** Texture type (1 = skin, 11-13 = creature skins, ...) -> file ID. */
	textures?: Record<number, number>;
	/** Show only geoset 0 and each group's default variant (x01), as for character models. */
	defaultGeosets?: boolean;
	/** Explicit geosets (group * 100 + variant) that replace the default for their group. */
	geosets?: number[];
	/**
	 * With defaultGeosets, a group with no variant 1 shows its lowest one instead, and group 0 its
	 * only one besides the body: creature models, which choose no geosets, and whose only hands
	 * or boots may be 403 or 504 (the Bloodsail pirates, ogre warlords).
	 */
	lowestVariant?: boolean;
	/** Pose the mesh with the first frame of its Stand animation instead of the bind pose. */
	stand?: boolean;
	/**
	 * Animate with these sequences (AnimationData IDs) rather than Stand and Walk: the walking
	 * character, whose clips carry their IDs and speeds.
	 */
	clips?: number[];
	/** Gear models to draw at the model's attachment points. */
	attachments?: GearAttachment[];
	/** Which footsteps it makes (see ModelData.footstep). */
	footstep?: number;
	/** Keep the model's collision mesh (ModelData.collision): placed doodads and game objects. */
	solid?: boolean;
}

/** A gear model (helmet, shoulder, weapon) and its texture, at an M2 attachment point. */
export interface GearAttachment {
	point: number;
	fdid: number;
	texture: number;
	/** Leave out the item's glowing (additive) surfaces, such as a torch's halo. */
	noGlow?: boolean;
}

/** A model file read, parsed and (optionally) posed once; the raw file isn't kept. */
interface PreparedM2 {
	m2: Omit<M2File, 'bytes' | 'vertices'>;
	skin: M2Skin;
	positions: Float32Array;
	normals: Float32Array;
	uvs: Float32Array;
	indices: Uint32Array;
	/** Attachment points by id. */
	attachments: Map<number, AttachmentPoint>;
	/**
	 * Set when the model's Stand loop moves: vertices then stay in bind space, with four bone
	 * indices and weights (0-255) each, for skinning on the GPU.
	 */
	animation: BoneAnimation | null;
	boneIndex: Uint16Array | null;
	boneWeight: Uint8Array | null;
	emitters: ParticleEmitter[];
}

/**
 * Prepared models by file and pose. Many NPC looks share one race model (the human model alone
 * is a 19 MB file), so each is decompressed and posed once, then dressed per look.
 */
const preparedM2 = new Map<string, Promise<PreparedM2>>();
const PREPARED_M2_LIMIT = 600;

/** file: the M2's bytes, when the caller has already read them. clips: see M2Options. */
/**
 * The .anim files of those listed sequences kept outside the model (the HD race models' emotes),
 * by sequence index. One that can't be read is left out, and its sequence with it.
 */
async function readAnimFiles(storage: CascStorage, skeleton: Skeleton, animFiles: { id: number; sub: number; fdid: number }[], clips: number[]): Promise<Map<number, Uint8Array>> {
	const out = new Map<number, Uint8Array>();
	await Promise.all(externalSequences(skeleton, clips).map(async ({ seq, id, sub }) => {
		const file = animFiles.find((a) => a.id === id && a.sub === sub);
		if (!file || storage.status(file.fdid) !== 'ok') return;
		try {
			out.set(seq, await storage.readFile(file.fdid));
		} catch (e) {
			console.warn(`Animation file ${file.fdid}:`, e);
		}
	}));
	return out;
}

function prepareM2(storage: CascStorage, fdid: number, stand: boolean, file?: Uint8Array, clips?: number[]): Promise<PreparedM2> {
	const key = `${fdid}:${stand ? 1 : 0}:${clips?.join('.') ?? ''}`;
	let entry = preparedM2.get(key);
	if (entry) {
		// Refresh its place in the least-recently-used order.
		preparedM2.delete(key);
		preparedM2.set(key, entry);
		return entry;
	}
	entry = (async () => {
		// The whole file is only needed here, for the vertices and the pose; it isn't cached.
		const { bytes, vertices, ...m2 } = parseM2(file ?? await storage.readFile(fdid));
		if (!m2.skinFdids[0]) throw new Error(`M2 ${fdid} has no skin`);
		const skin = parseSkin(await storage.readFile(m2.skinFdids[0]));

		const n = skin.vertexLookup.length;
		const positions = new Float32Array(n * 3);
		const normals = new Float32Array(n * 3);
		const uvs = new Float32Array(n * 2);
		const v = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
		// Bones and sequences in a .skel file of their own (the goblins), else in the model.
		const skeleton = (m2.skelFdid && storage.status(m2.skelFdid) === 'ok' && skelSkeleton(await storage.readFile(m2.skelFdid), bytes, m2.md20)) || m2Skeleton(bytes, m2.md20);
		// Stand and Walk, or the clips asked for, may be kept in .anim files.
		const external = await readAnimFiles(storage, skeleton, skeleton.animFiles ?? m2.animFiles, clips ?? [ANIM.Stand, ANIM.Walk]);
		// Moving models are skinned on the GPU from bind space; still ones are posed here once.
		// Creatures (posed standing) also get their walk, for those that roam.
		const animation = clips ? sequenceAnimation(skeleton, clips, external) : standAnimation(skeleton, stand, external);
		const bones = !animation && stand ? standPose(skeleton, external) : null;
		const boneIndex = animation ? new Uint16Array(n * 4) : null;
		const boneWeight = animation ? new Uint8Array(n * 4) : null;
		for (let i = 0; i < n; i++) {
			const o = skin.vertexLookup[i] * 48;
			if (o + 48 > vertices.length) continue;
			if (boneIndex && boneWeight) {
				for (let k = 0; k < 4; k++) {
					boneWeight[i * 4 + k] = v.getUint8(o + 12 + k);
					boneIndex[i * 4 + k] = v.getUint8(o + 16 + k);
				}
			}
			if (bones) {
				skinVertex(v, o, bones, positions, normals, i);
			} else {
				for (let k = 0; k < 3; k++) {
					positions[i * 3 + k] = v.getFloat32(o + k * 4, true);
					normals[i * 3 + k] = v.getFloat32(o + 20 + k * 4, true);
				}
			}
			uvs[i * 2] = v.getFloat32(o + 32, true);
			uvs[i * 2 + 1] = v.getFloat32(o + 36, true);
		}
		return {
			m2, skin, positions, normals, uvs, indices: Uint32Array.from(skin.indices),
			// Animated bodies still need the resting frames, for held items' particles.
			attachments: attachmentPoints(skeleton, bones ?? (animation ? standPose(skeleton, external) : null)), animation, boneIndex, boneWeight,
			emitters: parseParticleEmitters(bytes, m2.md20, m2.textures.map((t) => t.fdid), skeleton),
		};
	})();
	entry.catch(() => preparedM2.delete(key));
	preparedM2.set(key, entry);
	if (preparedM2.size > PREPARED_M2_LIMIT) preparedM2.delete(preparedM2.keys().next().value!);
	return entry;
}

/** The geoset group of glowing eyes. */
const EYE_GLOW = 17;

/** Picks the batches a look shows (geosets, resolved runtime textures), as a standalone mesh. */
function dressM2(prepared: PreparedM2, options: M2Options) {
	const { m2, skin } = prepared;
	const batches: ModelBatch[] = [];
	// Each group's lowest variant (group 0's besides the body), for creatures, which choose none.
	// Group 0 counts only when it has just the one: several are hairstyles to choose from.
	const lowest = new Map<number, number>();
	if (options.lowestVariant) {
		const hair = new Set<number>();
		for (const b of skin.batches) {
			if (!b.geoset) continue;
			const group = Math.floor(b.geoset / 100);
			if (group === 0) hair.add(b.geoset);
			lowest.set(group, Math.min(lowest.get(group) ?? 99, b.geoset % 100));
		}
		if (hair.size > 1) lowest.delete(0);
	}
	skin.batches.forEach((b, i) => {
		const material = m2.materials[b.materialIndex] ?? { flags: 0, blend: 0 };
		const texture = m2.textures[m2.textureCombos[b.textureComboIndex] ?? -1];
		const opacity = (m2.transparency[b.transparencyIndex] ?? 1) * (b.colorIndex >= 0 ? m2.colorAlpha[b.colorIndex] ?? 1 : 1);
		if (opacity <= 0.01 || b.indexCount === 0) return;
		// Group 0 holds the body (0) and hairstyles (1+); the others default to variant 1, except
		// the head (group 32), whose variant 1 is an empty stub, and eye glow (group 17), which
		// newer models (the goblins, the HD races) give a variant 1 and is only shown when chosen.
		if (options.defaultGeosets && b.geoset !== 0) {
			const group = Math.floor(b.geoset / 100);
			// A chosen geoset (hairstyle, facial hair, gear, ...) replaces its group's default; group 0
			// only matches non-zero choices, since geoset 0 is the body itself.
			const chosen = options.geosets?.find((g) => Math.floor(g / 100) === group && (group !== 0 || g !== 0));
			if (chosen !== undefined) {
				if (b.geoset !== chosen) return;
			} else if (options.lowestVariant && group !== EYE_GLOW && (lowest.get(group) ?? 0) > (group === 0 ? 0 : 1)) {
				if (b.geoset % 100 !== lowest.get(group)) return;
			} else if (group === 0 || group === EYE_GLOW || b.geoset % 100 !== (group === 32 ? 2 : 1)) {
				return;
			}
		}
		// Runtime textures we can't resolve (hair, capes, ...): hide the part rather than draw it grey.
		if (options.textures && texture && texture.type !== 0 && !options.textures[texture.type]) return;
		batches.push({
			start: b.indexStart,
			count: b.indexCount,
			order: b.priorityPlane * 256 + i,
			material: {
				texture: !texture ? 0 : texture.type === 0 ? texture.fdid : options.textures?.[texture.type] ?? 0,
				blend: material.blend,
				twoSided: !!(material.flags & M2_MATERIAL_TWO_SIDED),
				unlit: !!(material.flags & M2_MATERIAL_UNLIT),
				unfogged: !!(material.flags & M2_MATERIAL_UNFOGGED),
				opacity,
				uvScroll: m2.uvScroll[b.uvAnimationIndex] ?? undefined,
			},
		});
	});
	return batches;
}

const brokenGear = new Set<number>();

export async function loadM2(storage: CascStorage, fdid: number, options: M2Options = {}, file?: Uint8Array): Promise<ModelData> {
	const prepared = await prepareM2(storage, fdid, !!options.stand, file, options.clips);
	const animated = prepared.animation !== null;
	// rest: where the part sits in the resting pose, for its particle emitters.
	const parts: { prepared: PreparedM2; batches: ModelBatch[]; transform: Mat4 | null; rest: Mat4 | null; bone: number }[] = [
		{ prepared, batches: dressM2(prepared, options), transform: null, rest: null, bone: -1 },
	];
	// Gear (helmets, shoulders, weapons) drawn at the body's attachment points.
	for (const gear of options.attachments ?? []) {
		const point = prepared.attachments.get(gear.point);
		if (!point) continue;
		try {
			const item = await prepareM2(storage, gear.fdid, false);
			// Item textures are runtime type 2 ("object skin"); their own hard-coded ones still apply.
			// On an animated body the item rides its attachment bone from the bind-space frame.
			parts.push({ prepared: item, batches: dressM2(item, { textures: { 2: gear.texture } }).filter((b) => !gear.noGlow || b.material.blend !== Blend.Add), transform: animated ? point.bind : point.posed, rest: point.posed, bone: point.bone });
		} catch (e) {
			// Once per item: many NPCs can share a broken one.
			if (!brokenGear.has(gear.fdid)) console.warn(`Gear model ${gear.fdid}:`, e);
			brokenGear.add(gear.fdid);
		}
	}

	// Merge into one mesh. Copies throughout: the arrays are transferred to the main thread,
	// which would empty the cached ones.
	let vertexCount = 0;
	let indexCount = 0;
	for (const p of parts) {
		vertexCount += p.prepared.positions.length / 3;
		indexCount += p.prepared.indices.length;
	}
	const positions = new Float32Array(vertexCount * 3);
	const normals = new Float32Array(vertexCount * 3);
	const uvs = new Float32Array(vertexCount * 2);
	const indices = new Uint32Array(indexCount);
	const boneIndex = animated ? new Uint16Array(vertexCount * 4) : null;
	const boneWeight = animated ? new Uint8Array(vertexCount * 4) : null;
	const batches: ModelBatch[] = [];
	let vbase = 0;
	let ibase = 0;
	parts.forEach((p, n) => {
		const src = p.prepared;
		const count = src.positions.length / 3;
		const m = p.transform;
		for (let i = 0; i < count; i++) {
			const x = src.positions[i * 3], y = src.positions[i * 3 + 1], z = src.positions[i * 3 + 2];
			const a = src.normals[i * 3], b = src.normals[i * 3 + 1], c = src.normals[i * 3 + 2];
			const o = (vbase + i) * 3;
			if (m) {
				positions[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
				positions[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
				positions[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
				normals[o] = m[0] * a + m[4] * b + m[8] * c;
				normals[o + 1] = m[1] * a + m[5] * b + m[9] * c;
				normals[o + 2] = m[2] * a + m[6] * b + m[10] * c;
			} else {
				positions[o] = x; positions[o + 1] = y; positions[o + 2] = z;
				normals[o] = a; normals[o + 1] = b; normals[o + 2] = c;
			}
		}
		uvs.set(src.uvs, vbase * 2);
		if (boneIndex && boneWeight) {
			if (p.bone < 0 && src.boneIndex && src.boneWeight) {
				boneIndex.set(src.boneIndex, vbase * 4);
				boneWeight.set(src.boneWeight, vbase * 4);
			} else {
				// Gear follows its attachment bone fully.
				for (let i = 0; i < count; i++) {
					boneIndex[(vbase + i) * 4] = Math.max(0, p.bone);
					boneWeight[(vbase + i) * 4] = 255;
				}
			}
		}
		for (let i = 0; i < src.indices.length; i++) indices[ibase + i] = src.indices[i] + vbase;
		// Gear draws after the body's own batches.
		for (const batch of p.batches) batches.push({ ...batch, start: batch.start + ibase, order: batch.order + n * 1_000_000 });
		vbase += count;
		ibase += src.indices.length;
	});
	const packed = packForShadows(indices, batches);
	const anim = prepared.animation;
	// Copies: the arrays are transferred to the main thread, which would empty the cached ones.
	const hull = prepared.m2.collision;
	let collision: ModelData['collision'];
	if (options.solid && hull.indices.length) {
		const hullPositions = hull.positions.slice();
		const hullIndices = Uint32Array.from(hull.indices);
		collision = { positions: hullPositions, indices: hullIndices, bvh: buildBvh(hullPositions, hullIndices) };
	}
	// Fresh frames: the arrays are transferred to the main thread, which would empty the cached ones.
	const place = (p: (typeof parts)[number], frame: Mat4) => (p.rest ? multiply(p.rest, frame) : frame.slice());
	const emitters = parts.flatMap((p) => p.prepared.emitters.map((e) => ({
		...e,
		bone: p.bone >= 0 ? p.bone : undefined,
		frame: place(p, e.frame),
		motion: e.motion && { duration: e.motion.duration, frames: e.motion.frames.map((f) => place(p, f)) },
	})));
	return {
		fdid, positions, normals, uvs, baked: null, indices: packed.indices, batches: mergeBatches(packed.batches),
		radius: prepared.m2.bounds.radius || boundingRadius(positions), height: topOf(positions, packed.indices, packed.batches),
		// The bone data is shared by every look of this model, so it's keyed for reuse on the GPU.
		animation: anim && boneIndex && boneWeight
			? { key: `m2:${fdid}${options.clips ? ':clips' : ''}`, bones: anim.bones, clips: anim.clips, data: anim.data.slice(), boneIndex, boneWeight }

			: undefined,
		emitters: emitters.length ? emitters : undefined,
		footstep: options.footstep,
		collision,
	};
}
/** file: the root file's bytes, when the caller has already read them. */
export async function loadWmo(storage: CascStorage, fdid: number, kindOf: (type: number) => LiquidKind, file?: Uint8Array): Promise<ModelData> {
	const root = parseWmoRoot(file ?? await storage.readFile(fdid));
	const groups = visibleWmoGroups(await Promise.all(root.groupFdids.map(async (g) => {
		try {
			return parseWmoGroup(await storage.readFile(g));
		} catch {
			return null;
		}
	})));

	let vertexCount = 0;
	for (const g of groups) if (g) vertexCount += g.positions.length / 3;
	const positions = new Float32Array(vertexCount * 3);
	const normals = new Float32Array(vertexCount * 3);
	const uvs = new Float32Array(vertexCount * 2);
	const baked = new Float32Array(vertexCount * 4);
	// Interior light = baked vertex colour (x2) + the WMO's ambient, in gamma space like the client;
	// converted to linear to match the rest of the lighting.
	const ambient = root.ambient.map((c) => c / 255);
	const toLinear = (g: number) => Math.pow(Math.max(0, g), 2.2);
	// Triangles per material, so each material becomes one batch.
	const byMaterial = new Map<number, number[]>();
	const collision: number[] = [];
	let base = 0;
	for (const g of groups) {
		if (!g) continue;
		const count = g.positions.length / 3;
		positions.set(g.positions, base * 3);
		if (g.normals.length === count * 3) normals.set(g.normals, base * 3);
		if (g.uvs.length === count * 2) uvs.set(g.uvs, base * 2);
		// Alpha picks per vertex between baked interior light (1) and normal outdoor lighting (0).
		if (g.colors && g.flags & WMO_GROUP_INTERIOR) {
			for (let i = 0; i < count; i++) {
				const o = (base + i) * 4;
				// Capped at full brightness: brighter would overexpose the texture.
				for (let k = 0; k < 3; k++) baked[o + k] = toLinear(Math.min(1, (g.colors[i * 4 + k] / 255) * 2 + ambient[k]));
				baked[o + 3] = g.colors[i * 4 + 3] / 255;
			}
		}
		for (const batch of g.batches) {
			const list = byMaterial.get(batch.material) ?? [];
			for (let i = batch.indexStart; i < batch.indexStart + batch.indexCount; i++) list.push(g.indices[i] + base);
			byMaterial.set(batch.material, list);
		}
		for (const t of g.collisionOnly) {
			for (let k = 0; k < 3; k++) collision.push(g.indices[t * 3 + k] + base);
		}
		base += count;
	}
	// Laid out for the sun's shadow pass (see viewer/shadows.ts): the materials it draws as plain
	// depth first, so they're one range, then alpha-tested ones by texture, then those it skips.
	const shadowRank = (materialIndex: number): [number, number] => {
		const m = root.materials[materialIndex];
		if (!m || m.flags & WMO_MATERIAL_UNLIT || (m.blend !== Blend.Opaque && m.blend !== Blend.AlphaKey)) return [2, 0];
		return m.blend === Blend.AlphaKey && !root.namedTextures && m.texture ? [1, m.texture] : [0, 0];
	};
	const layout = [...byMaterial].sort(([a], [b]) => {
		const [ra, ta] = shadowRank(a);
		const [rb, tb] = shadowRank(b);
		return ra - rb || ta - tb;
	});
	const indices: number[] = [];
	const batches: ModelBatch[] = [];
	for (const [materialIndex, list] of layout) {
		const m = root.materials[materialIndex];
		const start = indices.length;
		for (const i of list) indices.push(i);
		batches.push({
			start,
			count: list.length,
			order: m && m.blend !== Blend.Opaque && m.blend !== Blend.AlphaKey ? 1 : 0,
			material: {
				texture: m && !root.namedTextures ? m.texture : 0,
				blend: m?.blend ?? 0,
				twoSided: !!(m && m.flags & WMO_MATERIAL_TWO_SIDED),
				unlit: !!(m && m.flags & WMO_MATERIAL_UNLIT),
				unfogged: !!(m && m.flags & WMO_MATERIAL_UNFOGGED),
				opacity: 1,
				ground: m?.ground ?? 0,
			},
		});
	}

	// Last, so the shadow pass's ranges above stay as they are; never drawn, but in the ray-cast structure.
	if (collision.length) {
		// Collision has no material: it sounds like what most of the building is made of (ramps over wooden stairs).
		const byGround = new Map<number, number>();
		for (const b of batches) if (b.material.ground) byGround.set(b.material.ground, (byGround.get(b.material.ground) ?? 0) + b.count);
		const ground = [...byGround].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
		batches.push({ start: indices.length, count: collision.length, order: 0, material: { texture: 0, blend: 0, twoSided: false, unlit: true, unfogged: false, opacity: 1, collision: true, ground } });
		for (const i of collision) indices.push(i);
	}
	const doodadSets = root.doodadSets.map((set) => ({

		name: set.name,
		doodads: root.doodads.slice(set.start, set.start + set.count).filter((d) => d.fdid).map((d) => ({
			fdid: d.fdid,
			matrix: compose(translation(...d.position), fromQuaternion(...d.rotation), scaling(d.scale)),
		})),
	}));
	const indexArray = new Uint32Array(indices);
	return {
		fdid, positions, normals, uvs, baked, indices: indexArray, bvh: indexArray.length ? buildBvh(positions, indexArray) : undefined, batches, radius: boundingRadius(positions), height: topOf(positions), doodadSets,
		liquids: buildWmoLiquids(groups, (root.flags & WMO_LIQUID_TYPE_IDS) !== 0, kindOf),
		areas: {
			wmoId: root.wmoId,
			groups: groups.flatMap((g) => (g ? [{ id: g.groupId, interior: !!(g.flags & WMO_GROUP_INTERIOR), min: g.min, max: g.max }] : [])),
		},
	};
}

/** Highest point (model z) of the drawn parts; hidden geosets (capes, other hairstyles) don't count. */
function topOf(positions: Float32Array, indices?: Uint32Array, batches?: ModelBatch[]): number {
	let top = 0;
	if (!indices || !batches) {
		for (let i = 2; i < positions.length; i += 3) top = Math.max(top, positions[i]);
		return top;
	}
	for (const b of batches) {
		for (let i = b.start; i < b.start + b.count; i++) top = Math.max(top, positions[indices[i] * 3 + 2]);
	}
	return top;
}

function boundingRadius(positions: Float32Array): number {
	let r = 0;
	for (let i = 0; i < positions.length; i += 3) r = Math.max(r, Math.hypot(positions[i], positions[i + 1], positions[i + 2]));
	return r;
}

/**
 * How the sun's shadow pass draws a batch (see viewer/shadows.ts): 0 plain depth, 1 alpha-tested
 * (by texture), 2 not at all. Follows createModelMaterial: see-through, added and unlit batches cast nothing.
 */
function shadowRank(m: ModelMaterial): number {
	if (m.unlit || m.opacity < 1 || (m.blend !== Blend.Opaque && m.blend !== Blend.AlphaKey)) return 2;
	return m.blend === Blend.AlphaKey && m.texture ? 1 : 0;
}

/**
 * Copies only the triangles the batches draw (not hidden geosets) into a new index buffer, laid
 * out for the shadow pass: plain-depth batches first, so they're one range, then alpha-tested
 * ones by texture, then those it skips. Batches sharing a range (a base and a glow layer over the
 * same triangles) keep sharing it. Draw order is the batches' own and doesn't change.
 */
function packForShadows(indices: Uint32Array, batches: ModelBatch[]): { indices: Uint32Array; batches: ModelBatch[] } {
	const ranges = new Map<string, { start: number; count: number; rank: number; texture: number }>();
	for (const b of batches) {
		const key = `${b.start}:${b.count}`;
		const rank = shadowRank(b.material);
		const r = ranges.get(key);
		if (!r) ranges.set(key, { start: b.start, count: b.count, rank, texture: rank === 1 ? b.material.texture : 0 });
		else if (rank < r.rank) {
			r.rank = rank;
			r.texture = rank === 1 ? b.material.texture : 0;
		}
	}
	const order = [...ranges.entries()].sort(([, a], [, b]) => a.rank - b.rank || a.texture - b.texture || a.start - b.start);
	const out = new Uint32Array(order.reduce((n, [, r]) => n + r.count, 0));
	const moved = new Map<string, number>();
	let next = 0;
	for (const [key, r] of order) {
		out.set(indices.subarray(r.start, r.start + r.count), next);
		moved.set(key, next);
		next += r.count;
	}
	return { indices: out, batches: batches.map((b) => ({ ...b, start: moved.get(`${b.start}:${b.count}`)! })) };
}

/**
 * Joins batches that draw with identical materials and follow each other in the index
 * buffer, so they cost one draw call instead of several.
 */
function mergeBatches(batches: ModelBatch[]): ModelBatch[] {
	const sorted = [...batches].sort((a, b) => a.order - b.order || a.start - b.start);
	const out: ModelBatch[] = [];
	for (const b of sorted) {
		const last = out[out.length - 1];
		if (last && last.start + last.count === b.start && JSON.stringify(last.material) === JSON.stringify(b.material)) last.count += b.count;
		else out.push({ ...b, material: { ...b.material } });
	}
	return out;
}

const LEGACY_LIQUIDS: LiquidKind[] = ['water', 'ocean', 'magma', 'slime'];
/** MOHD flag: the groups' liquid values are LiquidType IDs, not legacy types. */
const WMO_LIQUID_TYPE_IDS = 0x4;
/** A legacy group liquid that leaves the kind to the tile flags (not LiquidType 15, Green Lava). */
const LEGACY_LIQUID_FROM_TILES = 15;

/**
 * Liquid surfaces (MLIQ) of a WMO's groups, merged per kind, in WMO space. typeIds: the groups'
 * liquid values are LiquidType IDs; in older files (Classic's) they're legacy types.
 */
function buildWmoLiquids(groups: (WmoGroup | null)[], typeIds: boolean, kindOf: (type: number) => LiquidKind): LiquidMesh[] {
	const byKind = new Map<LiquidKind, { type: number; positions: number[]; indices: number[] }>();
	for (const g of groups) {
		const l = g?.liquid;
		if (!g || !l || l.xVerts < 2 || l.yVerts < 2) continue;
		for (let ty = 0; ty < l.yTiles; ty++) {
			for (let tx = 0; tx < l.xTiles; tx++) {
				const flags = l.tiles[ty * l.xTiles + tx];
				if ((flags & 0x0f) === 0x0f) continue;
				// The group names a LiquidType, or in older files a legacy type cycling water, ocean,
				// magma and slime from 1; without one (or with 15), the tile flags hold the legacy type.
				const fromTiles = !g.liquidType || (!typeIds && g.liquidType === LEGACY_LIQUID_FROM_TILES);
				const legacy = fromTiles ? flags & 3 : (g.liquidType - 1) & 3;
				let kind = typeIds && !fromTiles ? kindOf(g.liquidType) : LEGACY_LIQUIDS[legacy];
				// WMO "ocean" isn't at sea level; draw it as water.
				if (kind === 'ocean') kind = 'water';
				// Legacy types 0-3 are LiquidType IDs 1-4.
				const mesh = byKind.get(kind) ?? { type: typeIds && !fromTiles ? g.liquidType : legacy + 1, positions: [], indices: [] };
				byKind.set(kind, mesh);
				const base = mesh.positions.length / 3;
				for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
					const h = l.heights[(ty + dy) * l.xVerts + tx + dx];
					mesh.positions.push(l.position[0] + (tx + dx) * WMO_LIQUID_CELL, l.position[1] + (ty + dy) * WMO_LIQUID_CELL, h);
				}
				// Counter-clockwise seen from above (+z).
				mesh.indices.push(base, base + 1, base + 3, base, base + 3, base + 2);
			}
		}
	}
	return [...byKind].map(([kind, m]) => ({ kind, type: m.type, positions: new Float32Array(m.positions), indices: new Uint32Array(m.indices) }));
}
