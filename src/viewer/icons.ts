import type { Image } from '../formats/blp';
import type { AsyncStorageApi } from '../worker/protocol';

/** A decoded picture as a data URL; opaque forces full alpha (icons' files carry none, read as 0). */
export function imageUrl(image: Image, opaque = false): string {
	const canvas = document.createElement('canvas');
	canvas.width = image.width;
	canvas.height = image.height;
	const rgba = new Uint8ClampedArray(image.rgba);
	if (opaque) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
	canvas.getContext('2d')!.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
	return canvas.toDataURL();
}

/**
 * Spell icons from the install as data URLs, by Interface/Icons name or file ID, each read once;
 * '' for one not loaded (yet) or unreadable.
 */
export class Icons {
	private readonly urls = new Map<string | number, string>();
	constructor(private readonly storage: AsyncStorageApi) {}

	get(key: string | number): string {
		return this.urls.get(key) ?? '';
	}

	/** Loads those not asked for before; resolves once they're in. */
	async load(keys: (string | number)[]): Promise<void> {
		const wanted = [...new Set(keys)].filter((k) => !this.urls.has(k));
		if (!wanted.length) return;
		for (const k of wanted) this.urls.set(k, '');
		const names = wanted.filter((k): k is string => typeof k === 'string');
		const ids = wanted.filter((k): k is number => typeof k === 'number');
		const [named, numbered] = await Promise.all([
			names.length ? this.storage.loadInterfaceImages(names.map((n) => `interface/icons/${n}.blp`)) : [],
			ids.length ? this.storage.loadImages(ids) : [],
		]);
		names.forEach((n, i) => this.urls.set(n, named[i] ? imageUrl(named[i]!, true) : ''));
		ids.forEach((n, i) => this.urls.set(n, numbered[i] ? imageUrl(numbered[i]!, true) : ''));
	}
}
