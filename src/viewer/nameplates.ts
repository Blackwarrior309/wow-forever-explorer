import * as THREE from 'three';
import type { Reaction, SpawnInfo } from '../explorer/spawns';
import { behindCamera } from './screen';

export type Side = 'alliance' | 'horde';

export interface Plate {
	info: SpawnInfo;
	position: THREE.Vector3;
	distance: number;
	/** The creature's placement, which walkers update every frame, and its height, for following it. */
	matrix: THREE.Matrix4;
	height: number;
	/** In line of sight from the camera (not behind terrain or a building). */
	visible?: boolean;
	/** A quest giver's mark over the name: quests to take (!), to hand in (?), under way (…). */
	marker?: '!' | '?' | '…' | null;
}

/** The scene's depth as the post pass left it, for names to be hidden by what's in front of them. */
export interface SceneDepth {
	uDepth: { value: THREE.Texture | null };
	uDepthDecode: { value: THREE.Vector2 };
	uLogFar: { value: number };
}

const MAX_PLATES = 80;
/**
 * As in the game, names have a size in the world (yards of font size), so they shrink with
 * distance like everything else and are large up close; within these pixel sizes, so far
 * ones stay legible and near ones don't fill the screen.
 */
const NAME_HEIGHT = 0.32;
const NAME_MIN_PX = 4;
const NAME_MAX_PX = 72;
/** Opacity a second a name gains coming into sight or loses going out of it (a quarter second). */
const FADE_RATE = 4;
/** Milliseconds out of the list after which a name's fade starts over (from nothing) when it returns. */
const FADE_FORGET = 500;
/** Milliseconds out of the list after which a name's picture is let go. */
const DISPOSE_AFTER = 5000;
/** Yards a model must be in front of a name to hide it, so the creature's own head doesn't. */
const DEPTH_BIAS = 0.5;
/**
 * A name is drawn into its picture at a font size from these steps (in device pixels, a quarter
 * octave apart) just above the size it's shown at, so it's only redrawn when it crosses one.
 */
const STEPS_PER_OCTAVE = 4;
const PICTURE_MIN_PX = 12;
const PICTURE_MAX_PX = 160;
/** The game's own font, read from the install by uiAssets.ts. */
const FONT_FAMILY = `'Friz Quadrata', 'Trebuchet MS', system-ui, sans-serif`;
/** UnitSelectionColor: pure red, yellow and green. */
const COLORS: Record<Reaction, string> = { hostile: '#ff0000', neutral: '#ffff00', friendly: '#00ff00' };

const VERTEX = /* glsl */ `
uniform vec4 uRect;
varying vec2 vUv;
void main() {
	vUv = position.xy;
	gl_Position = vec4(uRect.xy + position.xy * uRect.zw, 0.0, 1.0);
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uDepth;
uniform vec2 uDepthDecode;
uniform float uLogFar;
uniform vec2 uScreen;
uniform float uPlateDepth;
uniform float uAlpha;
varying vec2 vUv;
void main() {
	float depth = texture2D(uDepth, gl_FragCoord.xy / uScreen).r;
	// The scene's view depth here, as post.ts decodes it; nothing drawn counts as infinitely far.
	#ifdef USE_REVERSED_DEPTH_BUFFER
		float scene = depth <= 0.0 ? 1e9 : uDepthDecode.y / (depth + uDepthDecode.x);
	#else
		float scene = depth >= 0.999999 ? 1e9 : exp2(depth * uLogFar) - 1.0;
	#endif
	if (scene < uPlateDepth) discard;
	gl_FragColor = texture2D(uMap, vUv) * uAlpha;
}`;

/** One creature's name: its picture, the quad it's drawn on, and how faded in it is. */
interface Label {
	mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
	canvas: HTMLCanvasElement;
	texture: THREE.CanvasTexture | null;
	/** What the picture shows: text, colour, font size and the fonts there were to draw it with. */
	key: string;
	/** Font size the picture was drawn at, and the margin around the text for its shadow, in its pixels. */
	fontPx: number;
	pad: number;
	alpha: number;
	seen: number;
}

/**
 * Names above NPCs' heads, like the game's: coloured by how they react to the chosen side
 * (red hostile, yellow neutral, green friendly), with their title below, in the game's font with
 * only a faint shadow. Drawn over the finished frame rather than laid over it as page text, so
 * that wherever a model (or anything else) is nearer than the name, it covers it.
 */
export class Nameplates {
	private readonly scene = new THREE.Scene();
	/** Unused by the shader, which places the quads itself, but three needs one to draw with. */
	private readonly camera = new THREE.OrthographicCamera();
	private readonly quad = new THREE.BufferGeometry();
	private readonly labels = new Map<SpawnInfo, Label>();
	private readonly projected = new THREE.Vector3();
	private readonly view = new THREE.Vector3();
	private readonly screen = { value: new THREE.Vector2() };
	private lastFrame = 0;

	constructor(private readonly depth: SceneDepth) {
		this.quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3));
		this.quad.setIndex([0, 1, 2, 0, 2, 3]);
	}

	private label(info: SpawnInfo, now: number): Label {
		let label = this.labels.get(info);
		if (!label) {
			const material = new THREE.ShaderMaterial({
				uniforms: {
					uDepth: this.depth.uDepth,
					uDepthDecode: this.depth.uDepthDecode,
					uLogFar: this.depth.uLogFar,
					uScreen: this.screen,
					uMap: { value: null },
					uRect: { value: new THREE.Vector4() },
					uPlateDepth: { value: 0 },
					uAlpha: { value: 0 },
				},
				vertexShader: VERTEX,
				fragmentShader: FRAGMENT,
				transparent: true,
				premultipliedAlpha: true,
				depthTest: false,
				depthWrite: false,
			});
			const mesh = new THREE.Mesh(this.quad, material);
			mesh.frustumCulled = false;
			this.scene.add(mesh);
			label = { mesh, canvas: document.createElement('canvas'), texture: null, key: '', fontPx: 0, pad: 0, alpha: 0, seen: now };
			this.labels.set(info, label);
		}
		return label;
	}

	/** Draws the name (and title) into the label's picture at the given font size, if it isn't already. */
	private paint(label: Label, name: string, sub: string, reaction: Reaction, fontPx: number, marker: Plate['marker'] = null): void {
		// The game's font arrives after the first names may have been drawn; they're drawn again in it.
		const key = `${name}\n${sub}\n${reaction}\n${fontPx}\n${document.fonts.size}\n${marker ?? ''}`;
		if (label.key === key) return;
		label.key = key;
		const lines = [...(marker ? [marker === '…' ? '?' : marker] : []), name, ...(sub ? [sub] : [])];
		const ctx = label.canvas.getContext('2d')!;
		const font = `400 ${fontPx}px ${FONT_FAMILY}`;
		ctx.font = font;
		const width = Math.max(...lines.map((line) => ctx.measureText(line).width));
		const lineHeight = fontPx * 1.05;
		const pad = Math.ceil(fontPx * 0.15) + 1;
		label.canvas.width = Math.ceil(width) + pad * 2;
		label.canvas.height = Math.ceil(lineHeight * lines.length) + pad * 2;
		// Resizing the canvas reset its state.
		ctx.font = font;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillStyle = COLORS[reaction];
		ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
		ctx.shadowOffsetX = ctx.shadowOffsetY = fontPx * 0.04;
		ctx.shadowBlur = fontPx * 0.08;
		lines.forEach((line, i) => {
			// The quest mark: gold, or grey for quests under way, bold and a little larger.
			if (marker && i === 0) {
				ctx.save();
				ctx.fillStyle = marker === '…' ? '#a8a8a8' : '#ffd200';
				ctx.font = `700 ${Math.round(fontPx * 1.3)}px ${FONT_FAMILY}`;
				ctx.fillText(line, label.canvas.width / 2, pad + lineHeight * (i + 0.5));
				ctx.restore();
			} else ctx.fillText(line, label.canvas.width / 2, pad + lineHeight * (i + 0.5));
		});
		label.fontPx = fontPx;
		label.pad = pad;
		// A new texture each time: three can't change the size of one it has uploaded.
		label.texture?.dispose();
		const texture = (label.texture = new THREE.CanvasTexture(label.canvas));
		texture.premultiplyAlpha = true;
		texture.minFilter = THREE.LinearMipmapLinearFilter;
		texture.anisotropy = 1;
		label.mesh.material.uniforms.uMap.value = texture;
	}

	private dispose(info: SpawnInfo, label: Label): void {
		this.scene.remove(label.mesh);
		label.mesh.material.dispose();
		label.texture?.dispose();
		this.labels.delete(info);
	}

	/**
	 * Draws the names for the given plates over the frame the post pass just finished, whose
	 * depth they're tested against; call every frame, after it.
	 */
	update(plates: Plate[], camera: THREE.Camera, renderer: THREE.WebGLRenderer, side: Side): void {
		const now = performance.now();
		const step = Math.min(0.1, (now - this.lastFrame) / 1000) * FADE_RATE;
		this.lastFrame = now;
		for (const label of this.labels.values()) label.mesh.visible = false;
		for (const [info, label] of this.labels) if (now - label.seen > DISPOSE_AFTER) this.dispose(info, label);
		// Hidden with the rest of the interface.
		if (document.body.classList.contains('ui-hidden')) return;
		const size = renderer.getDrawingBufferSize(this.screen.value);
		const ratio = renderer.getPixelRatio();
		// Nearest first, so the closest names win when there are many.
		plates.sort((a, b) => a.distance - b.distance);
		// Pixels a yard spans one yard from the camera: half the view's height over tan(half the field of view).
		const pixelsPerYard = (camera.projectionMatrix.elements[5] * size.y) / ratio / 2;
		let shown = 0;
		for (const plate of plates) {
			if (shown >= MAX_PLATES) break;
			this.projected.copy(plate.position).project(camera);
			// Behind the camera or off screen.
			if (behindCamera(this.projected, camera) || Math.abs(this.projected.x) > 1.1 || Math.abs(this.projected.y) > 1.1) continue;
			const label = this.label(plate.info, now);
			if (now - label.seen > FADE_FORGET) label.alpha = 0;
			label.seen = now;
			label.alpha = plate.visible === false ? Math.max(0, label.alpha - step) : Math.min(1, label.alpha + step);
			if (label.alpha <= 0) continue;
			shown++;
			// Font size in CSS pixels, then in the screen's.
			const px = Math.min(NAME_MAX_PX, Math.max(NAME_MIN_PX, (NAME_HEIGHT * pixelsPerYard) / Math.max(plate.distance, 0.1)));
			const devicePx = px * ratio;
			const fontPx = Math.min(PICTURE_MAX_PX, Math.max(PICTURE_MIN_PX, Math.round(2 ** (Math.ceil(Math.log2(devicePx) * STEPS_PER_OCTAVE) / STEPS_PER_OCTAVE))));
			const reaction: Reaction = plate.info.reaction?.[side] ?? 'neutral';
			this.paint(label, plate.info.name, plate.info.subname ? `<${plate.info.subname}>` : '', reaction, fontPx, plate.marker);
			// Centred over the head, the text's bottom on it; whole pixels, so it's sharp at its own size.
			const scale = devicePx / label.fontPx;
			const w = label.canvas.width * scale;
			const h = label.canvas.height * scale;
			const x = Math.round((this.projected.x * 0.5 + 0.5) * size.x - w / 2);
			const y = Math.round((this.projected.y * 0.5 + 0.5) * size.y - label.pad * scale);
			const u = label.mesh.material.uniforms;
			u.uRect.value.set((x / size.x) * 2 - 1, (y / size.y) * 2 - 1, (w / size.x) * 2, (h / size.y) * 2);
			u.uPlateDepth.value = -this.view.copy(plate.position).applyMatrix4(camera.matrixWorldInverse).z - DEPTH_BIAS;
			u.uAlpha.value = label.alpha;
			// Farther names first, so nearer ones are drawn over them.
			label.mesh.renderOrder = -plate.distance;
			label.mesh.visible = true;
		}
		if (!shown) return;
		const autoClear = renderer.autoClear;
		renderer.autoClear = false;
		renderer.setRenderTarget(null);
		renderer.render(this.scene, this.camera);
		renderer.autoClear = autoClear;
	}
}
