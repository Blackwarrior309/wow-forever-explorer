import { FileListSource, HttpSource, type FileSource } from '../casc/source';
import { CascStorage, StorageChangedError } from '../casc/storage';
import { describeError, MapExplorer } from '../explorer/maps';
import { setPageUrl } from '../explorer/spawns';
import { WorldLoader } from '../explorer/world';
import type { AsyncStorageApi, Request, Response, SourceInit } from './protocol';

let source: FileSource | null = null;
let explorer: MapExplorer | null = null;
let world: WorldLoader | null = null;

function requireExplorer(): MapExplorer {
	if (!explorer) throw new Error('Storage is not open');
	return explorer;
}

function requireWorld(): WorldLoader {
	world ??= new WorldLoader(requireExplorer());
	return world;
}

function send(message: Response, transfer: Transferable[] = []): void {
	postMessage(message, { transfer });
}

const api: AsyncStorageApi = {
	async setPageUrl(url) {
		setPageUrl(url);
	},
	async setSource(init: SourceInit) {
		source = init.kind === 'http' ? new HttpSource(init.base) : new FileListSource(init.files);
		explorer = null;
		world = null;
		return CascStorage.listProducts(source);
	},
	async open(product) {
		if (!source) throw new Error('No folder selected');
		const storage = await CascStorage.open(source, product, (progress) => send({ id: -1, progress }));
		storage.onChanged(() => send({ id: -1, changed: true }));
		explorer = new MapExplorer(storage);
		world = null;
		return storage.stats;
	},
	async loadMap(wdtFdid) {
		return requireExplorer().loadMap(wdtFdid);
	},
	async minimapThumbnails(wdtFdid, coords, size) {
		return requireExplorer().minimapThumbnails(wdtFdid, coords, size);
	},
	async loadFarTiles(wdtFdid, wdlFdid) {
		return requireWorld().loadFarTiles(wdtFdid, wdlFdid);
	},
	async loadTileTextures(wdtFdid, coords, maxSize, compressed) {
		return requireWorld().loadTileTextures(wdtFdid, coords, maxSize, compressed);
	},
	async loadNearTile(wdtFdid, x, y, compressed) {
		return requireWorld().loadNearTile(wdtFdid, x, y, compressed);
	},
	async loadTextures(fdids, compressed) {
		return requireWorld().loadTextures(fdids, compressed);
	},
	async loadTileObjects(wdtFdid, x, y) {
		return requireWorld().loadTileObjects(wdtFdid, x, y);
	},
	async loadModels(models) {
		return requireWorld().loadModels(models);
	},
	async characterRaces() {
		return requireWorld().characterRaces();
	},
	async loadCharacter(race, sex, hd, look, clips, outfit, torch) {
		return requireWorld().loadCharacter(race, sex, hd, look, clips, outfit, torch);
	},
	async loadLighting(mapIds) {
		return requireWorld().loadLighting(mapIds);
	},
	async loadAreas() {
		return requireWorld().loadAreas();
	},
	async loadInstance(mapId) {
		return requireWorld().loadInstance(mapId);
	},
	async listMaps() {
		return requireWorld().listMaps();
	},
	async loadLiquidLooks() {
		return requireWorld().loadLiquidLooks();
	},
	async loadFootsteps() {
		return requireWorld().loadFootsteps();
	},
	async loadLockKinds() {
		return requireWorld().loadLockKinds();
	},
	async loadPlaces() {
		return requireWorld().loadPlaces();
	},
	async loadMusic() {
		return requireWorld().loadMusic();
	},
	async wmoArea(wmoId, nameSet, groupId) {
		return requireWorld().wmoArea(wmoId, nameSet, groupId);
	},
	async loadFont(fdid) {
		return requireWorld().loadFont(fdid);
	},
	async loadInterfaceImages(paths) {
		return requireWorld().loadInterfaceImages(paths);
	},
	async loadSound(fdid) {
		return requireWorld().loadSound(fdid);
	},
	async loadImages(fdids) {
		return requireWorld().loadImages(fdids);
	},
	async textureOpacity(fdids) {
		return requireWorld().textureOpacity(fdids);
	},
	async loadWorldMaps(mapIds) {
		return requireWorld().loadWorldMaps(mapIds);
	},
};

/** Collects typed-array buffers in a result so they move to the main thread instead of being copied. */
function transferables(value: unknown, out: Set<ArrayBuffer> = new Set(), depth = 0): Set<ArrayBuffer> {
	if (depth > 8 || value === null || typeof value !== 'object') return out;
	if (value instanceof ArrayBuffer) {
		out.add(value);
		return out;
	}
	if (ArrayBuffer.isView(value)) {
		if (value.buffer instanceof ArrayBuffer && value.byteLength === value.buffer.byteLength) out.add(value.buffer);
		return out;
	}
	for (const v of Array.isArray(value) ? value : Object.values(value)) transferables(v, out, depth + 1);
	return out;
}

onmessage = async (event: MessageEvent<Request>) => {
	const { id, method, args } = event.data;
	try {
		const result = await (api[method] as (...a: unknown[]) => Promise<unknown>)(...args);
		send({ id, result }, [...transferables(result)]);
	} catch (e) {
		// Once the game has been updated every read fails; the page says so once instead.
		if (!(e instanceof StorageChangedError)) console.error(e);
		send({ id, error: describeError(e) });
	}
};
