import type { ProductInfo } from '../casc/config';
import type { StorageStats } from '../casc/storage';
import type { AreaInfo, LightingData } from '../explorer/lighting';
import type { MapSummary } from '../explorer/maps';
import type { FootstepSounds, LiquidLooks, LockKind } from '../explorer/clientDb';
import type { MusicData, WmoArea } from '../explorer/music';
import type { Place } from '../explorer/places';
import type { WorldMapInfo } from '../explorer/worldMap';
import type { SpellText, TalentTree } from '../explorer/spells';
import type { ModelData, ObjectKind, Placement } from '../explorer/objects';
import type { CharacterModel, FarTile, InstanceMap, LoadedTexture, MapListing, NearTile, TileTexture } from '../explorer/world';
import type { CharacterOutfit, CharacterRace } from '../explorer/spawns';
import type { Image } from '../formats/blp';

export type SourceInit =
	| { kind: 'files'; files: { path: string; file: File }[] }
	/** The install the portable launcher or dev server found, served at this URL (ending in '/'). */
	| { kind: 'http'; base: string };

/** Methods the storage worker exposes; every call is async across the worker boundary. */
export interface StorageApi {
	/** Where the page is served from, for files beside it (the worker's own URL is under assets/). */
	setPageUrl(url: string): void;
	setSource(source: SourceInit): ProductInfo[];
	open(product: string): StorageStats;
	loadMap(wdtFdid: number): MapSummary;
	minimapThumbnails(wdtFdid: number, coords: [number, number][], size: number): { x: number; y: number; image: Image | null }[];
	loadFarTiles(wdtFdid: number, wdlFdid: number): FarTile[];
	loadInstance(mapId: number): InstanceMap | null;
	listMaps(): MapListing[];
	loadTileTextures(wdtFdid: number, coords: [number, number][], maxSize: number, compressed: boolean): TileTexture[];
	loadNearTile(wdtFdid: number, x: number, y: number, compressed: boolean): NearTile;
	loadTextures(fdids: number[], compressed: boolean): LoadedTexture[];
	loadTileObjects(wdtFdid: number, x: number, y: number): Placement[];
	loadModels(models: { fdid: number; kind: ObjectKind; variant?: string }[]): (ModelData | null)[];
	/** The walking character: the races it can be, and one dressed as a look with the clips given. */
	characterRaces(): CharacterRace[];
	loadCharacter(race: number, sex: number, hd: boolean, look: number, clips: number[], outfit: CharacterOutfit | null, torch: boolean): CharacterModel | null;
	/** A creature spawn's look (display ID and held weapons) with the clips given, for one fought up close. */
	loadCreature(displayId: number, variant: string | undefined, clips: number[]): CharacterModel | null;
	loadLighting(mapIds: number[]): LightingData;
	loadAreas(): AreaInfo[];
	loadMusic(): MusicData;
	loadLiquidLooks(): LiquidLooks;
	loadLockKinds(): Record<number, LockKind>;
	loadFootsteps(): FootstepSounds;
	loadPlaces(): Place[];
	wmoArea(wmoId: number, nameSet: number, groupId: number): WmoArea | null;
	loadSound(fdid: number): Uint8Array;
	loadFont(fdid: number): Uint8Array;
	loadInterfaceImages(paths: string[]): (Image | null)[];
	loadImages(fdids: number[]): (Image | null)[];
	textureOpacity(fdids: number[]): number[];
	loadWorldMaps(mapIds: number[]): WorldMapInfo[];
	loadTalents(classId: number): TalentTree[];
	loadRacials(race: number, classId: number): SpellText[];
	loadItemIcons(ids: number[]): number[];
}

export type AsyncStorageApi = {
	[K in keyof StorageApi]: (...args: Parameters<StorageApi[K]>) => Promise<ReturnType<StorageApi[K]>>;
};

export type Request = { id: number; method: keyof StorageApi; args: unknown[] };

export type Response =
	| { id: number; result: unknown }
	| { id: number; error: string }
	| { id: -1; progress: string }
	/** The game was updated since the storage was opened: reads fail until the page is reloaded. */
	| { id: -1; changed: true };
