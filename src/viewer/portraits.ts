import * as THREE from 'three';
import type { ModelData } from '../explorer/objects';
import { ANIM } from '../formats/m2Pose';
import type { AsyncStorageApi } from '../worker/protocol';
import type { CharacterLook } from './character';
import { createModelMaterial, type SkinUniforms } from './modelMaterials';
import { terrainShadowUniforms } from './terrainShadow';
import { TextureCache } from './textureCache';
import { supportsCompressedTextures } from './textures';

/** World axes from a model's (x forward, y left, z up), as the walking character's. */
const MODEL_BASIS = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0));
/** The model turned to face the camera, and a little to its left, for a three-quarter view. */
const FACING = Math.PI + 0.45;
/** Vertical field of view (degrees), and the room left round the model (share of its size). */
const FOV = 26;
const MARGIN = 1.08;
/** A portrait shows this share of the model's height, from the top. */
const HEAD_SHARE = 0.3;

/**
 * Pictures of travel forms for the picker: each look loaded on its own, standing in its first
 * Stand frame, lit from the front and drawn on a small renderer of its own (so the world's
 * renderer, its shaders and its frames are left alone), then handed back as an image.
 */
export class Portraits {
	private readonly renderer: THREE.WebGLRenderer;
	private readonly scene = new THREE.Scene();
	private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 200);
	private readonly textures: TextureCache;
	/** Stands in for the mountain shade map, which belongs to the world's renderer, while drawing here. */
	private readonly noShade = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);

	constructor(private readonly storage: AsyncStorageApi) {
		this.renderer = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), antialias: true, alpha: true, preserveDrawingBuffer: true });
		this.renderer.setClearColor(0x000000, 0);
		this.textures = new TextureCache(storage, supportsCompressedTextures(this.renderer), this.renderer.capabilities.getMaxAnisotropy());
		this.noShade.needsUpdate = true;
		this.scene.add(new THREE.AmbientLight(0xffffff, 1.9));
		const key = new THREE.DirectionalLight(0xfff4e0, 2.6);
		key.position.set(-1.5, 2, 3);
		this.scene.add(key);
		const rim = new THREE.DirectionalLight(0xbfd4ff, 1.2);
		rim.position.set(2, 1.5, -2);
		this.scene.add(rim);
	}

	/** Draws a look width by height pixels (head only for a unit frame); resolves to the picture, or null when it has no model. */
	async draw(look: CharacterLook, width: number, height: number, head = false): Promise<Blob | null> {
		const loaded = await this.storage.loadCharacter(look.race, look.sex, look.hd, look.look, [ANIM.Stand], look.outfit, false);
		return loaded ? this.drawModel(loaded.model, width, height, head) : null;
	}

	/** A creature spawn's head and shoulders, for the target frame; null when it has no model. */
	async drawCreature(displayId: number, variant: string | undefined, width: number, height: number): Promise<Blob | null> {
		const loaded = await this.storage.loadCreature(displayId, variant, [ANIM.Stand]);
		return loaded ? this.drawModel(loaded.model, width, height, true) : null;
	}

	private async drawModel(data: ModelData, width: number, height: number, head: boolean): Promise<Blob | null> {
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
		geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
		geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
		geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
		const a = data.animation;
		let boneTexture: THREE.DataTexture | null = null;
		let skin: SkinUniforms | null = null;
		let standRow = -1;
		if (a) {
			geometry.setAttribute('boneIndex', new THREE.BufferAttribute(a.boneIndex, 4));
			geometry.setAttribute('boneWeight', new THREE.BufferAttribute(a.boneWeight, 4, true));
			boneTexture = new THREE.DataTexture(a.data, a.bones * 3, a.data.length / (a.bones * 12), THREE.RGBAFormat, THREE.FloatType);
			boneTexture.magFilter = boneTexture.minFilter = THREE.NearestFilter;
			boneTexture.needsUpdate = true;
			const stand = a.clips.find((c) => c.id === ANIM.Stand) ?? a.clips[0];
			standRow = stand.row;
			skin = {
				uBoneTex: { value: boneTexture as THREE.Texture },
				uPoseA: { value: new THREE.Vector3(stand.row, stand.row, 0) },
				uPoseB: { value: new THREE.Vector3(stand.row, stand.row, 0) },
				uPoseMix: { value: 0 },
			};
		}
		const ids = [...new Set(data.batches.map((b) => b.material.texture).filter((t) => t))];
		const textures = await this.textures.acquire(ids);
		const batches = [...data.batches].sort((x, y) => x.order - y.order);
		const materials = batches.map((b, i) => {
			geometry.addGroup(b.start, b.count, i);
			return createModelMaterial(b.material, textures.get(b.material.texture) ?? null, false, skin);
		});
		const mesh = new THREE.Mesh(geometry, materials);
		mesh.frustumCulled = false;
		mesh.matrixAutoUpdate = false;
		mesh.matrix.copy(MODEL_BASIS).multiply(new THREE.Matrix4().makeRotationZ(FACING));
		mesh.updateMatrixWorld(true);
		try {
			const box = posedBounds(data, standRow).applyMatrix4(mesh.matrix);
			// A unit frame's portrait: the top of the model (the head on people), not all of it.
			if (head) box.min.y = Math.max(box.min.y, box.max.y - (box.max.y - box.min.y) * HEAD_SHARE);
			this.frame(box, width / height);
			this.scene.add(mesh);
			this.renderer.setSize(width, height, false);
			const shade = terrainShadowUniforms.uTerrainShade.value;
			terrainShadowUniforms.uTerrainShade.value = this.noShade;
			try {
				this.renderer.render(this.scene, this.camera);
			} finally {
				terrainShadowUniforms.uTerrainShade.value = shade;
				this.scene.remove(mesh);
			}
			// Taken as the canvas is now, before anything else is drawn on it.
			return await new Promise<Blob | null>((resolve) => this.renderer.domElement.toBlob(resolve, 'image/webp', 0.9));
		} finally {
			geometry.dispose();
			for (const m of materials) m.dispose();
			boneTexture?.dispose();
			this.textures.release(ids);
		}
	}

	/** Points the camera level at the middle of the model's bounds, back far enough to show all of it. */
	private frame(box: THREE.Box3, aspect: number): void {
		const size = box.getSize(new THREE.Vector3());
		const center = box.getCenter(new THREE.Vector3());
		const halfV = THREE.MathUtils.degToRad(FOV / 2);
		const halfH = Math.atan(Math.tan(halfV) * aspect);
		const depth = Math.max(size.x, size.z) / 2;
		const distance = Math.max((size.y / 2) * MARGIN / Math.tan(halfV), (Math.max(size.x, size.z) / 2) * MARGIN / Math.tan(halfH)) + depth;
		this.camera.aspect = aspect;
		this.camera.near = Math.max(0.01, distance - depth * 3);
		this.camera.far = distance + depth * 3 + 10;
		this.camera.position.set(center.x, center.y, center.z + distance);
		this.camera.lookAt(center);
		this.camera.updateProjectionMatrix();
	}

	dispose(): void {
		this.noShade.dispose();
		this.renderer.dispose();
	}
}

/**
 * The bounds of the triangles drawn (in the model's own axes), posed as in a frame of the bone
 * texture (none: as modelled). Not the whole vertex list: models carry the geosets they hide too.
 */
function posedBounds(data: ModelData, row: number): THREE.Box3 {
	const box = new THREE.Box3();
	const p = data.positions;
	const a = row >= 0 ? data.animation : undefined;
	const seen = new Uint8Array(p.length / 3);
	const v = new THREE.Vector3();
	for (const b of data.batches) {
		if (b.material.collision) continue;
		for (let i = b.start; i < b.start + b.count; i++) {
			const n = data.indices[i];
			if (seen[n]) continue;
			seen[n] = 1;
			const x = p[n * 3], y = p[n * 3 + 1], z = p[n * 3 + 2];
			if (!a) {
				box.expandByPoint(v.set(x, y, z));
				continue;
			}
			let px = 0, py = 0, pz = 0, total = 0;
			for (let k = 0; k < 4; k++) {
				const w = a.boneWeight[n * 4 + k];
				if (!w) continue;
				// Three texels (the rows of a 3x4 matrix) per bone, a row of texels per frame.
				const m = (row * a.bones * 3 + a.boneIndex[n * 4 + k] * 3) * 4;
				const d = a.data;
				px += w * (d[m] * x + d[m + 1] * y + d[m + 2] * z + d[m + 3]);
				py += w * (d[m + 4] * x + d[m + 5] * y + d[m + 6] * z + d[m + 7]);
				pz += w * (d[m + 8] * x + d[m + 9] * y + d[m + 10] * z + d[m + 11]);
				total += w;
			}
			box.expandByPoint(total ? v.set(px / total, py / total, pz / total) : v.set(x, y, z));
		}
	}
	return box;
}
