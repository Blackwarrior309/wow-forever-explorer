import { chunks, type Chunk } from './chunks';

export const WMO_MATERIAL_UNLIT = 0x1;
export const WMO_MATERIAL_UNFOGGED = 0x2;
export const WMO_MATERIAL_TWO_SIDED = 0x4;
export const WMO_MATERIAL_CLAMP_S = 0x40;
export const WMO_MATERIAL_CLAMP_T = 0x80;

export const WMO_GROUP_HAS_VERTEX_COLORS = 0x4;
export const WMO_GROUP_EXTERIOR = 0x8;
export const WMO_GROUP_UNREACHABLE = 0x80;
export const WMO_GROUP_INTERIOR = 0x2000;
export const WMO_GROUP_ALWAYS_DRAW = 0x10000;
/** MOPY triangle flag: things collide with it. */
const MOPY_COLLISION = 0x8;

export const WMO_GROUP_ANTIPORTAL = 0x4000000;

export interface WmoMaterial {
	flags: number;
	shader: number;
	blend: number;
	texture: number;
	/** TerrainType it's made of, for footsteps (0 none). */
	ground: number;
}

export interface WmoDoodad {
	fdid: number;
	position: [number, number, number];
	/** Quaternion x, y, z, w. */
	rotation: [number, number, number, number];
	scale: number;
}

export interface WmoRoot {
	materials: WmoMaterial[];
	groupFdids: number[];
	/** Doodad sets as [start, count] ranges into doodads. */
	doodadSets: { name: string; start: number; count: number }[];
	doodads: WmoDoodad[];
	/** Set when material textures are MOTX name offsets rather than file IDs (pre-8.1 files). */
	namedTextures: boolean;
	/** MOHD ambient colour for interiors, RGB 0-255. */
	ambient: [number, number, number];
	/** MOHD flags; 0x4 means group liquid values are LiquidType IDs. */
	flags: number;
	/** WMOAreaTable's WMOID for this building. */
	wmoId: number;
}

export interface WmoBatch {
	indexStart: number;
	indexCount: number;
	material: number;
}

export interface WmoGroup {
	flags: number;
	/** WMOAreaTable's WMOGroupID for this group. */
	groupId: number;
	/** Bounding box in WMO space (z up). */
	min: [number, number, number];
	max: [number, number, number];
	/** Portals leading out of this group; the game sees into interiors only through these. */
	portalCount: number;
	positions: Float32Array;
	normals: Float32Array;
	uvs: Float32Array;
	/** RGBA 0-255 (first MOCV set), or null. */
	colors: Uint8Array | null;
	indices: Uint16Array | Uint32Array;
	batches: WmoBatch[];
	/**
	 * Triangles (indices into indices / 3) that are only there to be walked on or bumped into,
	 * never drawn (MOPY material 0xFF): ramps over steps, walls closing a cellar's hole in the ground.
	 */
	collisionOnly: number[];
	/** LiquidType ID (or legacy liquid type) of the group's liquid. */
	liquidType: number;
	liquid: WmoLiquid | null;
}

/** A group's liquid surface (MLIQ): a height grid in WMO space with per-tile flags. */
export interface WmoLiquid {
	xVerts: number;
	yVerts: number;
	xTiles: number;
	yTiles: number;
	/** Corner of the grid, WMO space (z up). */
	position: [number, number, number];
	heights: Float32Array;
	/** Per tile; a low nibble of 0xF means no liquid in that tile. */
	tiles: Uint8Array;
}

/** Size of one liquid grid cell, in yards. */
export const WMO_LIQUID_CELL = 1600 / 3 / 128;

const decoder = new TextDecoder();

export function parseWmoRoot(bytes: Uint8Array): WmoRoot {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const find = new Map<string, Chunk>();
	for (const c of chunks(bytes)) if (!find.has(c.id)) find.set(c.id, c);
	const hasMotx = (find.get('MOTX')?.size ?? 0) > 0;

	const materials: WmoMaterial[] = [];
	const momt = find.get('MOMT');
	if (momt) {
		for (let i = 0; i < momt.size / 64; i++) {
			const o = momt.offset + i * 64;
			materials.push({ flags: view.getUint32(o, true), shader: view.getUint32(o + 4, true), blend: view.getUint32(o + 8, true), texture: view.getUint32(o + 12, true), ground: view.getUint32(o + 32, true) });
		}
	}

	const mohd = find.get('MOHD');
	const nGroups = mohd ? view.getUint32(mohd.offset + 4, true) : 0;
	// ambColor is BGRA.
	const ambient: [number, number, number] = mohd ? [bytes[mohd.offset + 30], bytes[mohd.offset + 29], bytes[mohd.offset + 28]] : [0, 0, 0];
	const rootFlags = mohd ? view.getUint16(mohd.offset + 60, true) : 0;
	const gfid = find.get('GFID');
	// GFID lists LOD0 groups first; further entries are lower-detail versions.
	const groupFdids = gfid ? Array.from({ length: Math.min(nGroups, gfid.size / 4) }, (_, i) => view.getUint32(gfid.offset + i * 4, true)) : [];

	const doodadSets: WmoRoot['doodadSets'] = [];
	const mods = find.get('MODS');
	if (mods) {
		for (let i = 0; i < mods.size / 32; i++) {
			const o = mods.offset + i * 32;
			const nameBytes = bytes.subarray(o, o + 20);
			const end = nameBytes.indexOf(0);
			doodadSets.push({ name: decoder.decode(nameBytes.subarray(0, end < 0 ? 20 : end)), start: view.getUint32(o + 20, true), count: view.getUint32(o + 24, true) });
		}
	}

	const modi = find.get('MODI');
	const ids = modi ? Array.from({ length: modi.size / 4 }, (_, i) => view.getUint32(modi.offset + i * 4, true)) : [];
	const doodads: WmoDoodad[] = [];
	const modd = find.get('MODD');
	if (modd) {
		for (let i = 0; i < modd.size / 40; i++) {
			const o = modd.offset + i * 40;
			const nameIndex = view.getUint32(o, true) & 0xffffff;
			const fl = (k: number) => view.getFloat32(o + k, true);
			doodads.push({
				fdid: ids[nameIndex] ?? 0,
				position: [fl(4), fl(8), fl(12)],
				rotation: [fl(16), fl(20), fl(24), fl(28)],
				scale: fl(32),
			});
		}
	}
	const wmoId = mohd ? view.getUint32(mohd.offset + 32, true) : 0;
	return { materials, groupFdids, doodadSets, doodads, namedTextures: hasMotx, ambient, flags: rootFlags, wmoId };
}

/**
 * Leaves out (as null) the groups the game never shows next to the rest, since the viewer draws
 * every group at once instead of looking through portals:
 * - antiportals, which only hide what's behind them;
 * - unreachable interiors without portals, which nothing can see into (Stormwind keeps an older
 *   cathedral shell and a copy of the mage tower this way);
 * - unreachable exterior facades wrapped around interiors: rough stand-ins for buildings seen from
 *   outside, which would stick out of the detailed interior (Stormwind's cathedral).
 */
export function visibleWmoGroups(groups: (WmoGroup | null)[]): (WmoGroup | null)[] {
	const interiors = groups.filter((g): g is WmoGroup => !!g && (g.flags & WMO_GROUP_INTERIOR) !== 0);
	return groups.map((g) => {
		if (!g || g.flags & WMO_GROUP_ANTIPORTAL) return null;
		if (!(g.flags & WMO_GROUP_UNREACHABLE) || g.flags & WMO_GROUP_ALWAYS_DRAW) return g;
		if (g.flags & WMO_GROUP_INTERIOR) return g.portalCount === 0 ? null : g;
		if (g.flags & WMO_GROUP_EXTERIOR && wrappedByInteriors(g, interiors)) return null;
		return g;
	});
}

/** Whether most of a group's bounding box lies inside interior groups' bounding boxes. */
function wrappedByInteriors(group: WmoGroup, interiors: WmoGroup[]): boolean {
	const volume = (min: number[], max: number[]) => Math.max(0, max[0] - min[0]) * Math.max(0, max[1] - min[1]) * Math.max(0, max[2] - min[2]);
	const own = volume(group.min, group.max);
	if (!own) return false;
	// The largest single overlap is enough: a facade wraps one interior, not a patchwork.
	let best = 0;
	for (const g of interiors) {
		const min = group.min.map((v, k) => Math.max(v, g.min[k]));
		const max = group.max.map((v, k) => Math.min(v, g.max[k]));
		best = Math.max(best, volume(min, max));
	}
	return best / own > 0.5;
}

export function parseWmoGroup(bytes: Uint8Array): WmoGroup {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let mogp: Chunk | null = null;
	for (const c of chunks(bytes)) if (c.id === 'MOGP') mogp = c;
	if (!mogp) throw new Error('WMO group has no MOGP chunk');
	const flags = view.getUint32(mogp.offset + 8, true);

	const f = (at: number) => view.getFloat32(mogp!.offset + at, true);
	const group: WmoGroup = {
		flags,
		groupId: view.getUint32(mogp.offset + 56, true),
		min: [f(12), f(16), f(20)],
		max: [f(24), f(28), f(32)],
		portalCount: view.getUint16(mogp.offset + 38, true),
		positions: new Float32Array(0),
		normals: new Float32Array(0),
		uvs: new Float32Array(0),
		colors: null,
		indices: new Uint16Array(0),
		batches: [],
		collisionOnly: [],
		liquidType: view.getUint32(mogp.offset + 52, true),
		liquid: null,
	};
	const floats = (c: Chunk) => {
		const out = new Float32Array(c.size / 4);
		for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(c.offset + i * 4, true);
		return out;
	};
	for (const c of chunks(bytes, mogp.offset + 68, mogp.offset + mogp.size)) {
		switch (c.id) {
			case 'MOVT':
				group.positions = floats(c);
				break;
			case 'MONR':
				group.normals = floats(c);
				break;
			case 'MOTV':
				if (group.uvs.length === 0) group.uvs = floats(c);
				break;
			case 'MOCV':
				if (!group.colors) {
					// BGRA -> RGBA
					const colors = new Uint8Array(c.size);
					for (let i = 0; i < c.size; i += 4) {
						colors[i] = bytes[c.offset + i + 2];
						colors[i + 1] = bytes[c.offset + i + 1];
						colors[i + 2] = bytes[c.offset + i];
						colors[i + 3] = bytes[c.offset + i + 3];
					}
					group.colors = colors;
				}
				break;
			case 'MOPY':
				// Two bytes per triangle: flags, then material (0xFF: collision only).
				for (let i = 0; i < c.size / 2; i++) {
					if (bytes[c.offset + i * 2 + 1] === 0xff && bytes[c.offset + i * 2] & MOPY_COLLISION) group.collisionOnly.push(i);
				}
				break;
			case 'MPY2':
				// Newer files: two 16-bit values per triangle, flags then material (0xFFFF: collision only).
				for (let i = 0; i < c.size / 4; i++) {
					if (view.getUint16(c.offset + i * 4 + 2, true) === 0xffff && view.getUint16(c.offset + i * 4, true) & MOPY_COLLISION) group.collisionOnly.push(i);
				}
				break;
			case 'MOVI': {

				const out = new Uint16Array(c.size / 2);
				for (let i = 0; i < out.length; i++) out[i] = view.getUint16(c.offset + i * 2, true);
				group.indices = out;
				break;
			}
			case 'MOVX': {
				const out = new Uint32Array(c.size / 4);
				for (let i = 0; i < out.length; i++) out[i] = view.getUint32(c.offset + i * 4, true);
				group.indices = out;
				break;
			}
			case 'MLIQ': {
				const xVerts = view.getUint32(c.offset, true);
				const yVerts = view.getUint32(c.offset + 4, true);
				const xTiles = view.getUint32(c.offset + 8, true);
				const yTiles = view.getUint32(c.offset + 12, true);
				const position: [number, number, number] = [view.getFloat32(c.offset + 16, true), view.getFloat32(c.offset + 20, true), view.getFloat32(c.offset + 24, true)];
				// 30-byte header, then 8-byte vertices whose height is the float at +4, then tile flags.
				const heights = new Float32Array(xVerts * yVerts);
				for (let i = 0; i < heights.length; i++) heights[i] = view.getFloat32(c.offset + 30 + i * 8 + 4, true);
				const tilesStart = c.offset + 30 + heights.length * 8;
				group.liquid = { xVerts, yVerts, xTiles, yTiles, position, heights, tiles: bytes.slice(tilesStart, tilesStart + xTiles * yTiles) };
				break;
			}
			case 'MOBA':
				for (let i = 0; i < c.size / 24; i++) {
					const o = c.offset + i * 24;
					const batchFlags = bytes[o + 22];
					// Flag 2: the material index is a u16 stored in the bounding box area.
					const material = batchFlags & 2 ? view.getUint16(o + 10, true) : bytes[o + 23];
					group.batches.push({ indexStart: view.getUint32(o + 12, true), indexCount: view.getUint16(o + 16, true), material });
				}
				break;
		}
	}
	return group;
}
