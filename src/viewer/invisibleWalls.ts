import * as THREE from 'three';
import { MeshBVH, type ExtendedTriangle } from 'three-mesh-bvh';

/**
 * How far (yards, in the model's own space) a building's collision may sit from anything drawn
 * and still count as that surface's own: ramps laid over steps, flat panes over railings.
 */
export const WMO_NEAR = 0.75;

/**
 * The same for a doodad of a given radius, whose collision mesh is a rough shape around what's
 * drawn (a box around a trunk, a few faces around a rock), rougher the bigger it is.
 */
export function doodadNear(radius: number): number {
	return THREE.MathUtils.clamp(radius * 0.1, 0.5, 1.5);
}

/** What invisible walls are drawn with: see-through violet, unlike any of the walkable slope colours. */
export const WALL_MATERIAL = new THREE.MeshBasicMaterial({
	color: 0xb44dff,
	transparent: true,
	opacity: 0.45,
	depthWrite: false,
	side: THREE.DoubleSide,
	fog: false,
	// In front of a drawn surface it lies right on.
	polygonOffset: true,
	polygonOffsetFactor: -1,
	polygonOffsetUnits: -1,
});
// Darker the more a face turns from the camera, so a wall's shape reads; from each triangle's own slope, as the meshes have no normals.
WALL_MATERIAL.onBeforeCompile = (shader) => {
	shader.vertexShader = shader.vertexShader
		.replace('#include <common>', '#include <common>\nvarying vec3 vWallView;')
		.replace('#include <project_vertex>', '#include <project_vertex>\nvWallView = mvPosition.xyz;');
	shader.fragmentShader = shader.fragmentShader
		.replace('#include <common>', '#include <common>\nvarying vec3 vWallView;')
		.replace('#include <opaque_fragment>', /* glsl */ `
			vec3 wallNormal = normalize(cross(dFdx(vWallView), dFdy(vWallView)));
			outgoingLight *= 0.55 + 0.45 * abs(dot(wallNormal, normalize(vWallView)));
			#include <opaque_fragment>`);
};
WALL_MATERIAL.customProgramCacheKey = () => 'invisible-wall';

/** A ray-cast structure over triangles, for bareTriangles; the index is left as it is. */
export function surfaceTree(positions: THREE.BufferAttribute, indices: THREE.BufferAttribute): MeshBVH {
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', positions);
	geometry.setIndex(indices);
	return new MeshBVH(geometry, { indirect: true });
}

const point = new THREE.Vector3();
const closest = new THREE.Vector3();

/** A run of triangles in an index buffer: its first index position and how many positions. */
export interface IndexRange {
	start: number;
	count: number;
}

/**
 * The most a texture's opacity may reach (of 255) for what it's drawn on to count as unseen:
 * an invisible wall's texture is see-through all over.
 */
export const UNSEEN_OPACITY = 32;

/** Whether any drawn triangle of a surface comes within `near` of the point; hidden: its runs that aren't drawn. */
function hasSurfaceNear(surface: MeshBVH, hidden: IndexRange[], near: number): boolean {
	return surface.shapecast({
		intersectsBounds: (box: THREE.Box3) => box.distanceToPoint(point) <= near,
		intersectsTriangle: (triangle: ExtendedTriangle, index: number) =>
			!hidden.some((r) => index * 3 >= r.start && index * 3 < r.start + r.count) && triangle.closestPointToPoint(point, closest).distanceTo(point) <= near,
	});
}

/**
 * The collision triangles (the runs of an index buffer) with nothing drawn near them: invisible
 * walls, rather than the collision of something that can be seen. A triangle counts when a
 * corner or its middle is further than `near` from every drawn triangle of `surface`, which is
 * all of it but the `hidden` runs; with no surface, they all count. Null if there are none.
 */
export function bareTriangles(positions: THREE.BufferAttribute, indices: ArrayLike<number>, runs: IndexRange[], surface: MeshBVH | null, hidden: IndexRange[], near: number): Uint32Array | null {
	const bare: number[] = [];
	const corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
	for (const { start, count } of runs) {
		for (let i = start; i + 2 < start + count; i += 3) {
			let covered = false;
			if (surface) {
				for (let k = 0; k < 3; k++) corners[k].fromBufferAttribute(positions, indices[i + k]);
				// The middle first: a wall across a doorway has its corners on the frame.
				point.copy(corners[0]).add(corners[1]).add(corners[2]).divideScalar(3);
				covered = hasSurfaceNear(surface, hidden, near);
				for (let k = 0; covered && k < 3; k++) {
					point.copy(corners[k]);
					covered = hasSurfaceNear(surface, hidden, near);
				}
			}
			if (!covered) bare.push(indices[i], indices[i + 1], indices[i + 2]);
		}
	}
	return bare.length ? Uint32Array.from(bare) : null;
}
