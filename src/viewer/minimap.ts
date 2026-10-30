import type { AsyncStorageApi } from '../worker/protocol';
import type { MinimapMarks, MinimapView } from './viewer';

/** Pixels per tile in a map's picture, made from the game's own minimap images. */
const CELL = 32;
/** Minimap images read per request: few enough that the terrain's own loading isn't held up for long. */
const BATCH = 32;
/** Tiles across the minimap at each zoom level (a tile is 533 yards). */
const SPANS = [1, 2, 4, 8, 16, 32];
const DEFAULT_ZOOM = 2;
const ZOOM_KEY = 'mapExplorer.minimapZoom';
const SEA = '#0f2434';

/** One map's picture, filled in as its minimap images are read. */
interface MapPicture {
	canvas: HTMLCanvasElement;
	/** The tile in the picture's top-left corner. */
	minX: number;
	minY: number;
	/** False for maps with no minimap images (most dungeons are one building). */
	any: boolean;
}

/**
 * A round, north-up map around the camera with an arrow for the heading. Each map's picture
 * is read once, the tiles nearest the camera first; clicking flies there, the wheel zooms.
 */
export class Minimap {
	private readonly pictures = new Map<number, Promise<MapPicture | null>>();
	private readonly ready = new Map<number, MapPicture | null>();
	private zoom = DEFAULT_ZOOM;
	private last = '';
	private dirty = true;
	private view: MinimapView | null = null;

	constructor(
		private readonly canvas: HTMLCanvasElement,
		private readonly storage: AsyncStorageApi,
		private readonly where: () => MinimapView | null,
		private readonly onPick: (mapId: number, x: number, y: number) => void,
		/** The game's player arrow (pointing up); without it, one is drawn. */
		private readonly arrow: HTMLCanvasElement | null = null,
		/** The guide's way and the other players, drawn over the map. */
		private readonly marks: () => MinimapMarks = () => ({ path: [], players: [], goal: null }),
	) {
		try {
			const saved = Number(localStorage.getItem(ZOOM_KEY));
			if (Number.isInteger(saved) && saved >= 0 && saved < SPANS.length && localStorage.getItem(ZOOM_KEY) !== null) this.zoom = saved;
		} catch {
			// Storage blocked: the default zoom.
		}
		canvas.addEventListener('wheel', (e) => {
			e.preventDefault();
			this.zoomBy(Math.sign(e.deltaY));
		}, { passive: false });
		canvas.addEventListener('click', (e) => {
			const view = this.view;
			if (!view || !this.ready.get(view.wdt)?.any) return;
			const rect = canvas.getBoundingClientRect();
			const span = SPANS[this.zoom];
			const dx = ((e.clientX - rect.left) / rect.width - 0.5) * span;
			const dy = ((e.clientY - rect.top) / rect.height - 0.5) * span;
			this.onPick(view.mapId, view.x + dx, view.y + dy);
		});
		const frame = () => {
			this.draw();
			requestAnimationFrame(frame);
		};
		requestAnimationFrame(frame);
	}

	/** Zooms out (+1) or in (-1) a level. */
	zoomBy(step: number): void {
		const next = Math.min(SPANS.length - 1, Math.max(0, this.zoom + step));
		if (next === this.zoom) return;
		this.zoom = next;
		this.dirty = true;
		try {
			localStorage.setItem(ZOOM_KEY, String(next));
		} catch {
			// Not remembered.
		}
	}

	private picture(view: MinimapView): MapPicture | null {
		if (!this.pictures.has(view.wdt)) {
			const loading = this.load(view).catch((e) => {
				console.warn(`Minimap for map ${view.mapId} unavailable:`, e);
				return null;
			});
			this.pictures.set(view.wdt, loading);
			void loading.then((p) => {
				this.ready.set(view.wdt, p);
				this.dirty = true;
			});
		}
		return this.ready.get(view.wdt) ?? null;
	}

	private async load(view: MinimapView): Promise<MapPicture> {
		const summary = await this.storage.loadMap(view.wdt);
		const tiles = summary.tiles.filter((t) => t.files.minimap);
		const xs = tiles.map((t) => t.x);
		const ys = tiles.map((t) => t.y);
		const minX = Math.min(...xs);
		const minY = Math.min(...ys);
		const canvas = document.createElement('canvas');
		const picture: MapPicture = { canvas, minX, minY, any: tiles.length > 0 };
		if (!tiles.length) return picture;
		canvas.width = (Math.max(...xs) - minX + 1) * CELL;
		canvas.height = (Math.max(...ys) - minY + 1) * CELL;
		const ctx = canvas.getContext('2d')!;
		// Shown (empty) straight away; the images go in as they come, nearest the camera first.
		this.ready.set(view.wdt, picture);
		const near = this.view?.wdt === view.wdt ? this.view : view;
		const coords = tiles.map((t): [number, number] => [t.x, t.y]);
		coords.sort((a, b) => Math.hypot(a[0] + 0.5 - near.x, a[1] + 0.5 - near.y) - Math.hypot(b[0] + 0.5 - near.x, b[1] + 0.5 - near.y));
		for (let i = 0; i < coords.length; i += BATCH) {
			const thumbs = await this.storage.minimapThumbnails(view.wdt, coords.slice(i, i + BATCH), CELL);
			for (const { x, y, image } of thumbs) {
				if (!image) continue;
				ctx.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height), (x - minX) * CELL, (y - minY) * CELL);
			}
			this.dirty = true;
		}
		return picture;
	}

	private draw(): void {
		if (!this.canvas.getClientRects().length) return;
		const view = this.where();
		this.view = view;
		const ratio = window.devicePixelRatio || 1;
		const size = Math.round(this.canvas.clientWidth * ratio);
		const marks: MinimapMarks = view ? this.marks() : { path: [], players: [], goal: null };
		const spanTiles = SPANS[this.zoom];
		const key = view ? `${view.wdt}/${view.x.toFixed(3)}/${view.y.toFixed(3)}/${view.yaw.toFixed(3)}/${size}/${marks.path.length}/${marks.goal?.join() ?? ''}/${marks.players.map((p) => p.map((v) => v.toFixed(3)).join()).join(';')}` : `none/${size}`;
		if (key === this.last && !this.dirty) return;
		this.last = key;
		this.dirty = false;
		if (this.canvas.width !== size) this.canvas.width = this.canvas.height = size;
		const ctx = this.canvas.getContext('2d')!;
		ctx.fillStyle = SEA;
		ctx.fillRect(0, 0, size, size);
		const picture = view ? this.picture(view) : null;
		if (view && picture?.any) {
			const span = SPANS[this.zoom] * CELL;
			ctx.imageSmoothingQuality = 'high';
			ctx.drawImage(picture.canvas, (view.x - picture.minX) * CELL - span / 2, (view.y - picture.minY) * CELL - span / 2, span, span, 0, 0, size, size);
		} else {
			ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
			ctx.font = `${12 * ratio}px system-ui, sans-serif`;
			ctx.textAlign = 'center';
			ctx.fillText(view ? (picture ? 'No map here' : 'Reading map…') : 'Open sea', size / 2, size / 2 + 26 * ratio);
		}
		// The guide's way (gold, the step's place a dot) and the others in the room (blue dots).
		const at = ([x, y]: [number, number]): [number, number] => [size / 2 + (x / spanTiles) * size, size / 2 + (y / spanTiles) * size];
		if (marks.path.length) {
			ctx.lineJoin = ctx.lineCap = 'round';
			for (const [width, colour] of [[4, 'rgba(0, 0, 0, 0.6)'], [2, '#ffd200']] as const) {
				ctx.beginPath();
				ctx.moveTo(size / 2, size / 2);
				for (const p of marks.path) ctx.lineTo(...at(p));
				ctx.lineWidth = width * ratio;
				ctx.strokeStyle = colour;
				ctx.stroke();
			}
		}
		const dot = (p: [number, number], fill: string, r: number) => {
			ctx.beginPath();
			ctx.arc(...at(p), r * ratio, 0, Math.PI * 2);
			ctx.fillStyle = fill;
			ctx.strokeStyle = '#000';
			ctx.lineWidth = ratio;
			ctx.fill();
			ctx.stroke();
		};
		if (marks.goal) dot(marks.goal, '#ffd200', 4);
		for (const p of marks.players) dot(p, '#4aa8ff', 3.5);
		// The camera: an arrow for its heading. Yaw turns from north toward west, the canvas clockwise.
		ctx.save();
		ctx.translate(size / 2, size / 2);
		ctx.rotate(-(view?.yaw ?? 0));
		ctx.scale(ratio, ratio);
		if (this.arrow) {
			ctx.drawImage(this.arrow, -this.arrow.width / 2, -this.arrow.height / 2);
		} else {
			ctx.beginPath();
			ctx.moveTo(0, -9);
			ctx.lineTo(6, 7);
			ctx.lineTo(0, 3);
			ctx.lineTo(-6, 7);
			ctx.closePath();
			ctx.fillStyle = '#ffd35a';
			ctx.strokeStyle = '#000';
			ctx.lineWidth = 1.5;
			ctx.fill();
			ctx.stroke();
		}
		ctx.restore();
	}
}
