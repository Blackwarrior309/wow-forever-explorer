import type { Image } from '../formats/blp';
import type { AsyncStorageApi } from '../worker/protocol';

/** The game's fonts by file ID (Fonts\*.ttf), under the family names viewer.css uses. */
const FONTS: [family: string, fdid: number][] = [
	['Friz Quadrata', 615960], // FRIZQT__: names over heads and most of the interface
	['Morpheus', 615962], // MORPHEUS: book and letter pages
	['Arial Narrow', 615958], // ARIALN: chat, numbers
];

/** How a picture becomes the image a CSS variable points at. */
type Shape =
	| { kind: 'whole' }
	/** Part of the picture: a texture's used corner, as the game's texcoords pick it. */
	| { kind: 'crop'; x: number; y: number; w: number; h: number }
	/**
	 * A backdrop edge strip (the game's edgeFile): eight square cells in a row, left, right,
	 * top, bottom, then the four corners; the top and bottom are stored stood on end. Laid out
	 * as a 3×3 nine-slice for border-image.
	 */
	| { kind: 'edge' };

/** Interface pictures, each set on :root as --wow-<name>: url(...). */
const IMAGES: [name: string, path: string, shape: Shape][] = [
	['tooltip-border', 'interface/tooltips/ui-tooltip-border.blp', { kind: 'edge' }],
	['dialog-border', 'interface/dialogframe/ui-dialogbox-border.blp', { kind: 'edge' }],
	['dialog-background', 'interface/dialogframe/ui-dialogbox-background.blp', { kind: 'whole' }],
	['button-up', 'interface/buttons/ui-panel-button-up.blp', { kind: 'crop', x: 0, y: 0, w: 80, h: 22 }],
	['button-down', 'interface/buttons/ui-panel-button-down.blp', { kind: 'crop', x: 0, y: 0, w: 80, h: 22 }],
	['button-highlight', 'interface/buttons/ui-panel-button-highlight.blp', { kind: 'crop', x: 0, y: 0, w: 80, h: 22 }],
	['checkbox-up', 'interface/buttons/ui-checkbox-up.blp', { kind: 'whole' }],
	['checkbox-down', 'interface/buttons/ui-checkbox-down.blp', { kind: 'whole' }],
	['checkbox-check', 'interface/buttons/ui-checkbox-check.blp', { kind: 'whole' }],
	['checkbox-highlight', 'interface/buttons/ui-checkbox-highlight.blp', { kind: 'whole' }],
	['slider-border', 'interface/buttons/ui-sliderbar-border.blp', { kind: 'edge' }],
	['slider-background', 'interface/buttons/ui-sliderbar-background.blp', { kind: 'whole' }],
	['slider-thumb', 'interface/buttons/ui-sliderbar-button-horizontal.blp', { kind: 'whole' }],
	['input-border', 'interface/common/common-input-border.blp', { kind: 'crop', x: 0, y: 0, w: 128, h: 20 }],
	['minimap-border', 'interface/minimap/ui-minimap-border.blp', { kind: 'whole' }],
	['minimap-north', 'interface/minimap/compassnorthtag.blp', { kind: 'whole' }],
	['zoom-in-up', 'interface/minimap/ui-minimap-zoominbutton-up.blp', { kind: 'whole' }],
	['zoom-in-down', 'interface/minimap/ui-minimap-zoominbutton-down.blp', { kind: 'whole' }],
	['zoom-out-up', 'interface/minimap/ui-minimap-zoomoutbutton-up.blp', { kind: 'whole' }],
	['zoom-out-down', 'interface/minimap/ui-minimap-zoomoutbutton-down.blp', { kind: 'whole' }],
	['zoom-highlight', 'interface/minimap/ui-minimap-zoombutton-highlight.blp', { kind: 'whole' }],
];

/**
 * The scroll bar's pictures (see scrollbar.ts): the arrow buttons and the knob cut out of their
 * 32×32 squares, and a stretch of the character sheet's scroll groove. Wanted but not needed:
 * without them the bar keeps its plain look, and the rest of the game's look stands.
 */
const SCROLL_IMAGES: [name: string, path: string, shape: Shape][] = [
	...(['up', 'down'] as const).flatMap((way) => (['up', 'down', 'disabled'] as const).map((state): [string, string, Shape] =>
		[`scroll-${way}-${state}`, `interface/buttons/ui-scrollbar-scroll${way}button-${state}.blp`, { kind: 'crop', x: 6, y: 7, w: 19, h: 17 }])),
	['scroll-knob', 'interface/buttons/ui-scrollbar-knob.blp', { kind: 'crop', x: 5, y: 6, w: 21, h: 19 }],
	['scroll-groove', 'interface/paperdollinfoframe/ui-character-scrollbar.blp', { kind: 'crop', x: 0, y: 64, w: 31, h: 128 }],
];

/** The player's arrow on the minimap, drawn by minimap.ts rather than CSS. */
const MINIMAP_ARROW = 'interface/minimap/minimaparrow.blp';

export interface UiAssets {
	/** The minimap's player arrow (pointing up), if the install has it. */
	minimapArrow: HTMLCanvasElement | null;
}

/** Pictures the game adds onto what's under them (highlights): black is clear, brightness is opacity. */
const GLOWS = new Set(['button-highlight', 'checkbox-highlight', 'zoom-highlight']);

/** Turns an additive picture into one that looks the same drawn normally over the page. */
function glowToAlpha(image: Image): Image {
	const rgba = new Uint8Array(image.rgba);
	for (let i = 0; i < rgba.length; i += 4) {
		const a = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]);
		if (a) for (let c = 0; c < 3; c++) rgba[i + c] = Math.round((rgba[i + c] * 255) / a);
		rgba[i + 3] = a;
	}
	return { ...image, rgba };
}

/**
 * Classic's minimap border ends its zone bar at x 226 and has a square of its own after it, to
 * 255 (where the game put the button that hides the minimap); later ones run the bar on to 255.
 * Joins the two by carrying a column from the bar's middle over the divider and the square's left
 * side, so the bar's own right end comes from the square's. Pictures without a square are kept.
 */
export function joinMinimapZoneBar(image: Image): Image {
	const { width, rgba } = image;
	if (width !== 256 || image.height !== 256) return image;
	const MIDDLE = 200;
	const [from, to] = [222, 241];
	// Above the ring, which starts below row 32.
	const ROWS = 32;
	const at = (x: number, y: number) => (y * width + x) * 4;
	const brightness = (i: number) => rgba[i] + rgba[i + 1] + rgba[i + 2];
	// Down the bar's middle row, a divider stands out from the bar's plain inside.
	const middle = brightness(at(MIDDLE, 14));
	let divided = false;
	for (let x = from; x <= to; x++) if (Math.abs(brightness(at(x, 14)) - middle) > 60) divided = true;
	if (!divided) return image;
	const out = new Uint8Array(rgba);
	for (let y = 0; y < ROWS; y++) {
		for (let x = from; x <= to; x++) out.set(rgba.subarray(at(MIDDLE, y), at(MIDDLE, y) + 4), at(x, y));
	}
	return { ...image, rgba: out };
}

function toCanvas(image: Image): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = image.width;
	canvas.height = image.height;
	canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height), 0, 0);
	return canvas;
}

function shape(source: HTMLCanvasElement, how: Shape): HTMLCanvasElement {
	if (how.kind === 'whole') return source;
	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d')!;
	if (how.kind === 'crop') {
		canvas.width = how.w;
		canvas.height = how.h;
		ctx.drawImage(source, how.x, how.y, how.w, how.h, 0, 0, how.w, how.h);
		return canvas;
	}
	const e = source.height;
	canvas.width = canvas.height = 3 * e;
	const cell = (i: number, x: number, y: number) => ctx.drawImage(source, i * e, 0, e, e, x, y, e, e);
	cell(0, 0, e);
	cell(1, 2 * e, e);
	cell(4, 0, 0);
	cell(5, 2 * e, 0);
	cell(6, 0, 2 * e);
	cell(7, 2 * e, 2 * e);
	// Top and bottom turned a quarter clockwise, so their stored left side faces up and right side down.
	for (const [i, y] of [[2, 0], [3, 2 * e]]) {
		ctx.save();
		ctx.translate(2 * e, y);
		ctx.rotate(Math.PI / 2);
		ctx.drawImage(source, i * e, 0, e, e, 0, 0, e, e);
		ctx.restore();
	}
	return canvas;
}

async function loadFonts(storage: AsyncStorageApi): Promise<void> {
	await Promise.all(FONTS.map(async ([family, fdid]) => {
		try {
			const face = new FontFace(family, new Uint8Array(await storage.loadFont(fdid)));
			document.fonts.add(await face.load());
		} catch (e) {
			console.warn(`Game font ${family} unavailable:`, e);
		}
	}));
}

/** A picture, shaped, as an object URL to set as a --wow-* variable. */
async function toUrl(image: Image, [name, path, how]: [string, string, Shape]): Promise<string> {
	const fixed = name === 'minimap-border' ? joinMinimapZoneBar(image) : image;
	const canvas = shape(toCanvas(GLOWS.has(name) ? glowToAlpha(fixed) : fixed), how);
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
	if (!blob) throw new Error(`could not encode ${path}`);
	return URL.createObjectURL(blob);
}

/**
 * Takes the game's own fonts and interface pictures from the install and dresses the page in
 * them: each picture becomes a --wow-* variable and <body> gets the wow-ui class, which
 * viewer.css styles. If any picture is missing, the page keeps its plain look.
 */
export async function loadUiAssets(storage: AsyncStorageApi): Promise<UiAssets> {
	const fonts = loadFonts(storage);
	let minimapArrow: HTMLCanvasElement | null = null;
	try {
		const images = await storage.loadInterfaceImages([...IMAGES.map(([, path]) => path), MINIMAP_ARROW, ...SCROLL_IMAGES.map(([, path]) => path)]);
		const scroll = images.splice(IMAGES.length + 1);
		const arrow = images.pop();
		if (arrow) minimapArrow = toCanvas(arrow);
		const missing = IMAGES.filter((_, i) => !images[i]).map(([, path]) => path);
		if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
		const urls = await Promise.all(images.map((image, i) => toUrl(image!, IMAGES[i])));
		const root = document.documentElement.style;
		IMAGES.forEach(([name], i) => root.setProperty(`--wow-${name}`, `url("${urls[i]}")`));
		document.body.classList.add('wow-ui');
		if (scroll.every((image) => image)) {
			const scrollUrls = await Promise.all(scroll.map((image, i) => toUrl(image!, SCROLL_IMAGES[i])));
			SCROLL_IMAGES.forEach(([name], i) => root.setProperty(`--wow-${name}`, `url("${scrollUrls[i]}")`));
			document.body.classList.add('wow-scroll');
		}
	} catch (e) {
		console.warn('Game interface pictures unavailable, keeping the plain look:', e);
	}
	await fonts;
	return { minimapArrow };
}
