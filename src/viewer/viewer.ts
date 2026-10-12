import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { TILE_SIZE } from '../formats/adt';
import { KNOWN_MAPS } from '../explorer/maps';
import type { FarTile, InstanceMap, MapCategory } from '../explorer/world';
import type { AsyncStorageApi } from '../worker/protocol';
import type { AreaInfo } from '../explorer/lighting';
import type { WmoArea } from '../explorer/music';
import type { Place } from '../explorer/places';
import type { SpawnInfo } from '../explorer/spawns';
import { Character, type CharacterLook } from './character';
import { Portraits } from './portraits';
import type { Emote } from './emotes';
import type { CharacterRace } from '../explorer/spawns';
import { FlyControls } from './flyControls';
import { Footsteps } from './footsteps';
import { Flights, type FlightMaster } from './flights';
import { RegionData } from './regionData';
import { RegionOverlay } from './regionOverlay';
import { RestedAreas } from './restedAreas';
import { Transports, type Transport } from './transports';
import { SNOWFLAKE_TEXTURE, Weather, type WeatherSetting } from './weather';
import type { WorldMapView } from './worldMap';
import { Highlights, type HighlightSettings } from './highlights';
import { setWalkableShown } from './walkable';
import { mouseSpeed, setMouseSpeed } from './look';
import { MapLabels } from './mapLabels';
import { DAY, LightFade, Lighting, Sky, sunDirection } from './lighting';
import { MusicPlayer, type MusicTarget } from './music';
import { Nameplates, type Plate, type Side } from './nameplates';
import { CLUTTER_RANGE_DEFAULT, ClutterManager } from './clutter';
import { headPosition, ObjectManager } from './objects';
import { unlitView } from './modelMaterials';
import { perf } from './perf';
import { TerrainManager, type ContinentPlacement } from './terrain';
import { GroundDistancePass, SeaFloorPass } from './groundDistance';
import { ViewOcclusion } from './occlusion';
import { UploadQueue } from './gpuUploads';
import { PostPass, type FogSettings } from './post';
import { commonShadowStandIns, installShadowGroups, setShadowLight, shadowStandIns } from './shadows';
import { TerrainShadowPass } from './terrainShadow';
import { animateFlipbooks, flipbooks, liquidBelowStandIns, liquidKindOf, liquidMaterials, liquidTime, seaMask, setLiquidLooks, setLiquidsFromBelow } from './terrainMaterials';
import { UnderwaterAudio } from './underwater';
import { BackgroundAudio, type BackgroundSounds } from './ambience';
import type { LiquidKind } from '../formats/mh2o';
import type { LiquidLooks } from '../explorer/clientDb';
import { createTexture, supportsCompressedTextures } from './textures';
import { isTyping } from './typing';
import { WalkControls } from './walkControls';

/** A dungeon view in the URL hash: #d<map ID>/... */
const HASH_INSTANCE = /^#d(\d+)\//;
/** Tiles of open sea between Kalimdor and the Eastern Kingdoms in the shared world. */
const CONTINENT_GAP = 6;
/** WoW world coordinates are measured from the centre of the 64x64 tile grid. */
const MAP_ORIGIN = 32 * TILE_SIZE;
const SKY = new THREE.Color(0x9ec4e4);
/** Yards the camera keeps from building surfaces: well past its 0.5 yd near plane, so looking down never clips through a floor. */
const CAMERA_RADIUS = 1.5;
/**
 * Tiles of open sea around each of the other maps (dungeons, raids, battlegrounds...), laid out
 * in rows south of the continents so they can be flown to.
 */
const MAP_GAP = 3;
/** Maps that couldn't be laid out with the rest go further south, side by side, in tiles. */
const INSTANCE_OFFSET_Y = 250;
const INSTANCE_SPACING = 70;
/** The order the other maps are laid out in, row by row. */
const MAP_ORDER: MapCategory[] = ['dungeon', 'raid', 'battleground', 'other'];
/** Yards above the ground the camera must be for the maps' names to show. */
const LABEL_ALTITUDE = 40;
/** Yards above the ground under which the camera counts as having explored the area it's over (the world map). */
const EXPLORE_ALTITUDE = 150;
/** Where the light of the open sea between the laid-out maps is taken from (see updateLighting). */
const OPEN_SEA_LIGHT = { mapId: 0, x: 1e6, y: 1e6 };
const CATEGORY_NAMES: Record<MapCategory, string> = { continent: 'Continent', dungeon: 'Dungeon', raid: 'Raid', battleground: 'Battleground', other: 'Other map' };
/** Yards above a teleport's destination (the ground there) to put the camera. */
const EYE_HEIGHT = 2;
/** Footsteps on a building's floor whose material names no ground sound like stone. */
const STONE_GROUND = 3;
/** A walking character smaller than this (its scale: gnomes) splashes in water with the small sounds. */
const SMALL_SPLASH = 0.7;
/** A hole in the ground is a way down for the walking character only with a building this near under it (yards). */
const HOLE_DEPTH = 40;
/** Yards of slack around area triggers: the camera is a little ball, not a point. */
const TRIGGER_MARGIN = 1;
/**
 * Under water: how far you can see (yards), and the colour for when the zone's light gives none.
 * Water and sea take their colour from the light (LightData's river and ocean colours).
 */
const UNDERWATER: Record<LiquidKind, { far: number; color: number }> = {
	water: { far: 70, color: 0x0b2c3c },
	ocean: { far: 100, color: 0x08243a },
	slime: { far: 25, color: 0x2e4f10 },
	magma: { far: 10, color: 0x9a3208 },
};
/** The far plane sits this much past the fog's end, where everything is already the fog's colour. */
const FAR_PAST_FOG = 1.1;
/** Yards; the far plane never comes closer than this, so the sky dome (1000 yd around the camera) always shows. */
const MIN_FAR = 1500;
/** With no fog, the view reaches this far: past every continent and map laid out in the sea. */
const CLEAR_VIEW_FAR = 200000;
/** Yards the sun's shadows reach from the camera on the ground, and how much further per yard of altitude. */
const SHADOW_RANGE = 300;
const SHADOW_RANGE_PER_ALTITUDE = 2;
const SHADOW_RANGE_MAX = 1200;
/** How much of the sun shade takes away: some stays, as light from the sky and the ground would fill it in. */
const SHADOW_INTENSITY = 0.8;
/** Height of the sun (y of its direction) below which the moon lights the world instead. */
const SUN_TO_MOON = 0.08;
/** Height fog: thickness per yard at the lowest ground around (times the zone's), and how fast it thins with height. */
const FOG_DENSITY = 0.0008;
const FOG_FALLOFF = 1 / 40;
/** How strongly the sun lights the fog. */
const FOG_SUNLIGHT = 2;
/** The fog lies at the lowest ground within this many yards of the camera, sampled on a grid this many to a side. */
const FOG_BASE_REACH = 600;
const FOG_BASE_SAMPLES = 9;
/**
 * Screenshots (P): at most this many tiles in view load in full, nearest first (each takes some
 * 6 MB of video memory), and the picture is this many times the screen's resolution, up to
 * SHOT_MAX_SIZE pixels across.
 */
const SHOT_TILES = 100;
const SHOT_SCALE = 2;
const SHOT_MAX_SIZE = 8192;
/** ms; once nothing is left to load, a screenshot waits this long for the last models to show. */
const SHOT_SETTLE = 500;
/** ms; a screenshot is taken after this long even if something never finished loading. */
const SHOT_TIMEOUT = 180000;
/** How far above the camera (yards) to look for a liquid surface. */
const LIQUID_PROBE = 400;
/** Half-minutes a second that holding T moves the time of day (3 hours, a day in 8 seconds). */
const TIME_RATE = 360;
/** Yards; NPC names show within this distance, small and unfaded far away. */
const NAMEPLATE_RANGE = 400;
/** Names kept per scan, nearest first, so the sight tests stay cheap with a long range. */
const NAMEPLATE_MAX = 80;
/** Yards; clicks further than this don't select anything. */
const PICK_DISTANCE = 400;
const TORCH_COLOR = 0xffa650;
/** Where the light is carried, in camera space (x right, y up, z back): as if from a torch held on the right. */
const TORCH_POSITION = new THREE.Vector3(0.35, 0, -1.13);
/** Yards; the light fades to nothing at this distance. */
const TORCH_RANGE = 45;
/** Candela-like units: about full daylight brightness at 10 yards. */
const TORCH_INTENSITY = 220;
/**
 * Inverse-square falloff blows out surfaces right next to the camera, so the torch's falloff is
 * held flat within about 7.5 yards (a floor on distance squared). It's the only point light here,
 * so three.js's shared attenuation function is patched directly.
 */
const TORCH_NEAR_SQUARED = 58;
THREE.ShaderChunk.lights_pars_begin = THREE.ShaderChunk.lights_pars_begin.replace(
	'max( pow( lightDistance, decayExponent ), 0.01 )',
	`max( pow( lightDistance, decayExponent ), ${TORCH_NEAR_SQUARED.toFixed(1)} )`,
);

export interface HudInfo {
	location: string;
	coordinates: string;
	altitude: number;
	height: number;
	speed: number;
	fps: number;
	near: string;
	textures: string;
	objects: string;
	/** Game time of day, e.g. 14:30. */
	time: string;
	/** Side that NPC name colours are shown for. */
	side: string;
	/** Top-level zone and the subzone under the camera, when known. */
	zone: string | null;
	subzone: string | null;
	music: string;
	/** Highlighted spawns on this map, or '' when nothing is being highlighted. */
	highlights: string;
	/** The weather now, or '' when it's off. */
	weather: string;
	/** The flight being ridden, or ''. */
	flight: string;
	/** The boat or zeppelin ridden, or ''. */
	voyage: string;
	/** Whether walls, floors and the ground stop the camera (G toggles). */
	collision: string;
}

/** What can be switched from the keyboard or the menus. */
export interface ViewSettings {
	/** Light carried with the camera (L). */
	torch: boolean;
	/** Grass, flowers and pebbles (V). */
	clutter: boolean;
	/** How far the grass, flowers and pebbles reach, in yards. */
	clutterRange: number;
	/** How far doodads (trees, rocks, props), creatures and objects show, as a multiple of the usual. */
	detailRange: number;
	/** How fast the mouse turns the view, as a multiple of the usual. */
	mouseSpeed: number;
	/** Walls, floors and the ground stop the camera (G). */
	collision: boolean;
	/** Whose eyes name colours are seen through (F). */
	side: Side;
	/** Names over the dungeons and other maps laid out in the sea (I). */
	mapNames: boolean;
	/** Turning glides after the mouse rather than following it at once (J). */
	cinematic: boolean;
	/** The game's colour grading for each zone and time of day (B). */
	grading: boolean;
	/** The sun and moon cast shadows (X). */
	shadows: boolean;
	/** Fog lying in the valleys, lit by the sun where it reaches it (Z). */
	fog: boolean;
	/** No fog of any kind (distance, valley, weather or under water), so the far continents show. */
	clearView: boolean;
	/** No lighting or shading: every surface its texture's own colour, as in full daylight with no sun. */
	unlit: boolean;
	/** NPCs and monsters. */
	creatures: boolean;
	/** Game objects: chests, herbs, ore, doors, mailboxes. */
	gameObjects: boolean;
	/** Spirit healers and battleground spirit guides (shown only while creatures are). */
	spiritHealers: boolean;
	/** Multiplies the flying speed, from 1/8 to 8 (Y faster, Shift+Y slower), while smart speed is on. */
	flySpeed: number;
	/** Flying speed scales with height above the ground; off, it's fixedSpeed everywhere. */
	smartSpeed: boolean;
	/** Flying speed when smart speed is off, yd/s (Y faster, Shift+Y slower). */
	fixedSpeed: number;
	/** Rain, snow and sandstorms: each zone's own (with or without rain and snow), none, or one kind everywhere. */
	weather: WeatherSetting;
	/** The size drawn: 'window' for the window's own, or a width and height in pixels ('1920x1080'), shown as large as fits. */
	resolution: string;
	/** The minimap and its zone name over the view. */
	minimap: boolean;
}

/** The smallest width or height a fixed resolution may have, in pixels. */
export const RESOLUTION_MIN = 160;

/** A fixed resolution's width and height ('1920x1080'), or null for the window's own (or one that makes no sense). */
export function parseResolution(resolution: string): [number, number] | null {
	const match = /^(\d+)x(\d+)$/.exec(resolution);
	if (!match) return null;
	const [w, h] = [Number(match[1]), Number(match[2])];
	return w >= RESOLUTION_MIN && h >= RESOLUTION_MIN ? [w, h] : null;
}

/** Steps of the flying speed: each Y press or slider notch multiplies it by 2^(1/4). */
export const FLY_SPEED_STEP = 0.25;
/** The flying speed's range, as powers of two either side of normal. */
export const FLY_SPEED_RANGE = 3;
/** The fixed flying speed's range and default, as powers of two of yd/s (4 to 16384, 64). */
export const FIXED_SPEED_MIN = 2;
export const FIXED_SPEED_MAX = 14;
export const FIXED_SPEED_DEFAULT = 64;

/** A setting, or the time of day or the sound, changed by its key; or walking started or stopped. */
export type ViewChange = keyof ViewSettings | 'time' | 'sound' | 'flight' | 'voyage' | 'walking';

/**
 * A point and a direction in one map's own frame, the same in every game version though each
 * lays the dungeons out elsewhere: x and z in the map's tiles, y in yards, yaw and pitch in radians.
 */
export interface MapSpot {
	mapId: number;
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
}

/**
 * What's in view, to show again exactly after a switch of game version: the camera, and on
 * foot, the character (yaw: which way it faces) with the camera's turn and zoom around it.
 */
export interface ViewSpot {
	camera: MapSpot;
	walker: (MapSpot & { orbit: number; zoom: number }) | null;
}

/** Where the camera is for the minimap: a map's tile grid, in fractional local tiles. */
export interface MinimapView {
	mapId: number;
	wdt: number;
	x: number;
	y: number;
	yaw: number;
}

/**
 * An area trigger that teleports (a dungeon entrance or exit): a sphere, or a box turned about
 * the vertical, in WoW world coordinates on one map, and where it sends you.
 */
interface AreaTrigger {
	name: string;
	map: number;
	x: number;
	y: number;
	z: number;
	radius: number;
	box: [number, number, number, number];
	target: { map: number; x: number; y: number; z: number; o: number };
}

type TriggerRow = [number, string, number, number, number, number, number, number, number, number, number, number, number, number, number, number];

/** Teleporting area triggers by map, from public/spawns/triggers.json (VMaNGOS data). */
async function loadTriggers(): Promise<Map<number, AreaTrigger[]>> {
	const byMap = new Map<number, AreaTrigger[]>();
	try {
		const response = await fetch('spawns/triggers.json');
		if (!response.ok) return byMap;
		const file = (await response.json()) as { triggers: TriggerRow[] };
		for (const [, name, map, x, y, z, radius, bx, by, bz, bo, tm, tx, ty, tz, to] of file.triggers) {
			const list = byMap.get(map) ?? [];
			list.push({ name, map, x, y, z, radius, box: [bx, by, bz, bo], target: { map: tm, x: tx, y: ty, z: tz, o: to } });
			byMap.set(map, list);
		}
	} catch (e) {
		console.warn('Area triggers unavailable:', e);
	}
	return byMap;
}

/** A meeting stone outside a dungeon, in WoW world coordinates on its continent. */
export interface MeetingStone {
	guid: number;
	entry: number;
	/** The dungeon's name, as the stone gives it. */
	dungeon: string;
	dungeonMap: number;
	map: number;
	x: number;
	y: number;
	z: number;
	o: number;
	minLevel: number;
	maxLevel: number;
}

type StoneRow = [number, number, string, number, number, number, number, number, number, number, number];

/** The meeting stones, from public/spawns/stones.json (VMaNGOS data), lowest levels first. */
async function loadStones(): Promise<MeetingStone[]> {
	try {
		const response = await fetch('spawns/stones.json');
		if (!response.ok) return [];
		const file = (await response.json()) as { stones: StoneRow[] };
		return file.stones.map(([guid, entry, dungeon, dungeonMap, map, x, y, z, o, minLevel, maxLevel]) =>
			({ guid, entry, dungeon, dungeonMap, map, x, y, z, o, minLevel, maxLevel }));
	} catch (e) {
		console.warn('Meeting stones unavailable:', e);
		return [];
	}
}

/** Yards in front of a meeting stone that going to it puts you, as a summons does. */
const STONE_DISTANCE = 13;

/** Whether the GPU can draw with a reversed depth buffer (EXT_clip_control), asked of a throwaway context. */
function supportsClipControl(): boolean {
	const gl = document.createElement('canvas').getContext('webgl2');
	const supported = !!gl?.getExtension('EXT_clip_control');
	gl?.getExtension('WEBGL_lose_context')?.loseContext();
	return supported;
}

/** WoW world coordinates (x north, y west, z up) on a map -> where that map sits in the world. */
function worldFromWow(placement: ContinentPlacement, x: number, y: number, z: number): THREE.Vector3 {
	return new THREE.Vector3(MAP_ORIGIN - y + placement.offsetX * TILE_SIZE, z, MAP_ORIGIN - x + placement.offsetY * TILE_SIZE);
}

function insideTrigger(t: AreaTrigger, x: number, y: number, z: number): boolean {
	if (t.radius > 0) return (x - t.x) ** 2 + (y - t.y) ** 2 + (z - t.z) ** 2 <= (t.radius + TRIGGER_MARGIN) ** 2;
	const [length, width, height, o] = t.box;
	const dx = x - t.x;
	const dy = y - t.y;
	const along = dx * Math.cos(o) + dy * Math.sin(o);
	const across = -dx * Math.sin(o) + dy * Math.cos(o);
	return Math.abs(along) <= length / 2 + TRIGGER_MARGIN && Math.abs(across) <= width / 2 + TRIGGER_MARGIN && Math.abs(z - t.z) <= height / 2 + TRIGGER_MARGIN;
}

export class Viewer {
	readonly renderer: THREE.WebGLRenderer;
	private readonly scene = new THREE.Scene();
	private readonly camera: THREE.PerspectiveCamera;
	private readonly controls: FlyControls;
	/** A character on foot with the camera behind it, instead of flying (Backquote). */
	private readonly walker: WalkControls;
	/** The walking character as drawn; set up with the objects. */
	private character: Character | null = null;
	/** Who walks: race, sex, model and look (the default a Stormwind City Guard on the classic model). */
	private characterLook: CharacterLook = { race: 1, sex: 0, hd: false, look: 0, outfit: 'guard' };
	private portraitRenderer: Portraits | null = null;
	/** Whether the character has been dressed as characterLook yet (it is when first needed). */
	private dressed: Promise<number> | null = null;
	private terrain!: TerrainManager;
	private objects!: ObjectManager;
	/** Grass, flowers and pebbles near the camera (V toggles). */
	private clutter!: ClutterManager;
	private readonly fog = new THREE.Fog(SKY, 1000, 8000);
	private continents: ContinentPlacement[] = [];
	private frames = 0;
	private shadowFrame = 0;
	/** 0-1: shadows fade out as the light passes from the sun to the moon at dusk and back at dawn. */
	private shadowStrength = 1;
	/** World height the fog is thickest at, eased towards the lowest ground around. */
	private fogBase: number | null = null;
	/** No fog at all (ViewSettings.clearView). */
	private clearView = false;
	/** Flat, unlit view (ViewSettings.unlit); see updateLighting. */
	private unlit = false;
	/** The size drawn (ViewSettings.resolution); see resize. */
	private resolution = 'window';
	/** Where the names and highlights are laid over the canvas, kept to its box. */
	private readonly plateContainer: HTMLElement | null;
	private readonly fogLook: FogSettings = {
		color: new THREE.Color(),
		sunColor: new THREE.Color(),
		sunDir: new THREE.Vector3(0, 1, 0),
		density: FOG_DENSITY,
		falloff: FOG_FALLOFF,
		base: 0,
		sunlight: FOG_SUNLIGHT,
	};
	private fps = 0;
	private lastFpsTime = performance.now();
	private lastLodUpdate = 0;
	private readonly sun = new SunLight(0xfff2dd);
	private readonly ambient = new THREE.HemisphereLight(0x8899aa, 0x8899aa);
	private readonly sky = new Sky();
	private lighting: Lighting | null = null;
	private readonly areas = new Map<number, AreaInfo>();
	/** Half-minutes added to the local clock (T / Shift+T, N resets). */
	private timeOffset = 0;
	/** Which way the time of day is running while T is held: 1 forward, -1 back (Shift), 0 not held. */
	private timeRunning = 0;
	private lastTimeChange = 0;
	private lastLightUpdate = 0;
	/** Eases the light between zones; see updateLighting. */
	private readonly lightFade = new LightFade();
	private lastLightStep = 0;
	/** Warm light carried with the camera, like holding a torch (L toggles it). */
	private readonly torch = new THREE.PointLight(TORCH_COLOR, 0, TORCH_RANGE, 2);
	private torchOn = true;
	private readonly torchWorld = new THREE.Vector3();
	/** The sun and moon cast shadows (X); see setShadows. */
	private shadowsOn = true;
	/**
	 * Whether the shadow maps have been drawn yet. They're drawn once even with shadows off:
	 * the shaders still read them (see setShadows), and until they exist three binds a stand-in
	 * of the wrong kind, which the GPU refuses to draw with (GL_INVALID_OPERATION).
	 */
	private shadowMapsDrawn = false;
	/** Whose eyes name colours are seen through (F toggles). */
	private side: Side = 'alliance';
	private readonly nameplates: Nameplates | null;
	/** Markers over chests, herbs, ore and anything found by name. */
	private readonly highlights: Highlights | null;
	/** The ground tinted by graveyard, territory, levels, subzones or fishing; rested areas; flight paths. */
	private readonly regionOverlay: RegionOverlay | null;
	private readonly restedAreas: RestedAreas | null;
	private readonly flights: Flights | null;
	private readonly weather = new Weather();
	private regionData: RegionData | null = null;
	/** The flight being ridden: where to, and how long is left. */
	private flight: { to: string; remaining: () => number } | null = null;
	/** Boats and zeppelins, on their schedule; set up with the objects. */
	private transports: Transports | null = null;
	/** The boat or zeppelin being ridden. */
	private voyage: Transport | null = null;
	private lastExploreCheck = 0;
	private lastWeatherRoomCheck = 0;
	private weatherIndoors = false;
	/** Called with the area under the camera (and its parents) when the camera is down among it, for the world map. */
	onExplore: (areas: number[]) => void = () => {};
	/** Names over the maps laid out in the sea. */
	private readonly mapLabels: MapLabels | null;
	private lastLabelCheck = 0;
	/** Zone music (M toggles). */
	private music: MusicPlayer | null = null;
	private musicTarget: MusicTarget = { set: 0, intro: 0 };
	private lastMusicCheck = 0;
	/** WMOAreaTable rows by room, looked up in the worker as rooms are entered. */
	private readonly rooms = new Map<string, WmoArea | null | 'pending'>();
	/** The room the camera was last found in, if any. */
	private room: WmoArea | null = null;
	/** Dungeon entrances and exits by map. */
	private triggers = new Map<number, AreaTrigger[]>();
	/** Meeting stones outside the dungeons, lowest levels first. */
	meetingStones: MeetingStone[] = [];
	/** Dungeon maps by ID, laid out in the world when first entered. */
	private readonly instances = new Map<number, Promise<ContinentPlacement | null>>();
	private readonly loadedInstances = new Map<number, ContinentPlacement>();
	/** WMO-only maps' building bounds in world space, for landing above them. */
	private readonly instanceBounds = new Map<number, THREE.Box3>();
	/**
	 * Triggers fire only once the camera has been outside all of them, so arriving on (or
	 * starting in) one doesn't send you straight back.
	 */
	private triggersArmed = false;
	private teleporting = false;
	private lastTriggerCheck = 0;
	private ocean: THREE.Mesh | null = null;
	/** The liquid the camera is in, if any: its kind, LiquidType and surface height. */
	private underwater: { kind: LiquidKind; type: number; surface: number } | null = null;
	private liquidLooks: LiquidLooks | null = null;
	private underwaterAudio: UnderwaterAudio | null = null;
	/** The place's background loop (birds, wind, city bustle), and which ambience that is. */
	private backgroundAudio: BackgroundAudio | null = null;
	private background: BackgroundSounds | null = null;
	private readonly liquidRay = new THREE.Raycaster();
	private readonly liquidMeshes: THREE.Object3D[] = [];
	/** How far the ground is under each pixel, for how deep the water there looks. */
	private groundPass!: GroundDistancePass;
	private seaFloorPass!: SeaFloorPass;
	private readonly post: PostPass;
	private readonly uploads: UploadQueue;
	private readonly terrainShadow: TerrainShadowPass;
	/** What the ground and buildings hide from a screenshot's view; made with the first screenshot. */
	private occlusion: ViewOcclusion | null = null;
	/**
	 * A screenshot being prepared (P): when it started, how many tiles are held for it, since
	 * when nothing has been left to load, and the view it's taken from (the camera stays put).
	 */
	private shot: { started: number; tiles: number; readySince: number; position: THREE.Vector3; yaw: number; pitch: number } | null = null;
	/** Screenshot progress for the page to show; null when there's none, done once it's saved. */
	onShotStatus: (text: string | null, done?: boolean) => void = () => {};

	constructor(
		private readonly canvas: HTMLCanvasElement,
		private readonly storage: AsyncStorageApi,
		private readonly onHud: (info: HudInfo) => void,
		private readonly onSelect: (info: SpawnInfo) => void = () => {},
		plateContainer: HTMLElement | null = null,
	) {
		this.highlights = plateContainer ? new Highlights(plateContainer, storage.loadLockKinds()) : null;
		this.regionOverlay = plateContainer ? new RegionOverlay(plateContainer, (x, z) => this.terrain?.surfaceAt(x, z) ?? -Infinity) : null;
		this.restedAreas = plateContainer ? new RestedAreas(plateContainer) : null;
		this.flights = plateContainer ? new Flights(plateContainer) : null;
		this.mapLabels = plateContainer ? new MapLabels(plateContainer) : null;
		this.plateContainer = plateContainer;
		// Depth from half a yard to the horizon: a reversed float depth buffer where the GPU has
		// it, else a logarithmic one. The logarithmic one writes each pixel's depth from its shader,
		// so nothing hidden can be skipped before it's shaded; the reversed one lets the GPU do that.
		const reversed = supportsClipControl();
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, reversedDepthBuffer: reversed, logarithmicDepthBuffer: !reversed });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		// Checking a new shader for errors asks the GPU process and waits for the answer, a stall
		// for each one; while developing, the errors are worth it.
		this.renderer.debug.checkShaderErrors = import.meta.env.DEV;
		perf.watch(this.renderer);
		this.camera = new THREE.PerspectiveCamera(60, 1, 0.5, 400000);
		this.controls = new FlyControls(this.camera, canvas);
		this.walker = new WalkControls(this.camera, canvas);
		// Anything that puts the free camera somewhere (a flight, going to a place) ends walking first.
		this.controls.onTakeOver = () => this.stopWalking();
		this.groundPass = new GroundDistancePass(this.renderer);
		this.seaFloorPass = new SeaFloorPass(this.renderer);
		// Antialiased there rather than on the canvas.
		this.post = new PostPass(this.renderer, storage);
		this.nameplates = plateContainer ? new Nameplates(this.post.sceneDepth) : null;
		this.uploads = new UploadQueue(this.renderer);
		this.terrainShadow = new TerrainShadowPass(this.renderer);

		this.scene.background = SKY;
		this.scene.fog = this.fog;
		// Intensity pi: three's Lambert divides by pi, so the result is the game's
		// texture * (ambient + direct * N.L).
		this.sun.intensity = Math.PI;
		this.ambient.intensity = Math.PI;
		this.sun.position.set(-0.6, 1, 0.45);
		// Two cascades fitted to the view out to the shadow range, softened by filtering.
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFShadowMap;
		// Redrawn every other frame (see tick): each map is used with its own matrices, so a map a
		// frame old still lines up; only moving things' shadows lag a frame.
		this.renderer.shadowMap.autoUpdate = false;
		installShadowGroups(this.scene);
		setShadowLight(this.sun);
		this.post.setShadowLight(this.sun);
		this.sun.castShadow = true;
		this.sun.shadow.mapSize.set(2048, 2048);
		this.sun.shadow.camera.near = 1;
		this.sun.shadow.camera.far = SHADOW_RANGE;
		// Towards the light: down a normal depth buffer, up a reversed one (three's filtered shadows don't flip it themselves).
		this.sun.shadow.bias = this.renderer.capabilities.reversedDepthBuffer ? 0.0003 : -0.0003;
		this.sun.shadow.normalBias = 0.15;
		this.sun.shadow.radius = 2;
		this.sun.shadow.intensity = SHADOW_INTENSITY;
		this.scene.add(this.sun, this.ambient, this.sky.mesh);
		// Off to the right, so nearby surfaces get some shading rather than flat front light.
		this.torch.position.copy(TORCH_POSITION);
		this.camera.add(this.torch);
		this.scene.add(this.camera);

		window.addEventListener('resize', () => this.resize());
		window.addEventListener('keydown', (e) => this.onKey(e));
		window.addEventListener('keyup', (e) => {
			if (e.code === 'KeyT') this.stopTime();
		});
		window.addEventListener('blur', () => this.stopTime());
		canvas.addEventListener('mousedown', () => (this.pressedWalking = this.walker.active));
		canvas.addEventListener('click', (e) => this.onClick(e));
		canvas.addEventListener('mousemove', (e) => this.onHover(e));
		this.resize();
	}

	private readonly raycaster = new THREE.Raycaster();
	private lastHover = 0;
	/** The last press on the view began while walking, so its click doesn't capture the mouse for flying. */
	private pressedWalking = false;

	/** Spawn under the mouse, or under the centre crosshair while the mouse is captured. */
	private pickAt(e: MouseEvent): SpawnInfo | null {
		if (!this.objects) return null;
		const ndc = this.controls.locked
			? new THREE.Vector2(0, 0)
			: new THREE.Vector2((e.offsetX / this.canvas.clientWidth) * 2 - 1, -(e.offsetY / this.canvas.clientHeight) * 2 + 1);
		this.raycaster.setFromCamera(ndc, this.camera);
		this.raycaster.far = PICK_DISTANCE;
		return this.objects.pick(this.raycaster)?.info ?? null;
	}

	/** Clicking a creature or object opens its info (releasing the mouse); elsewhere captures the mouse. */
	private onClick(e: MouseEvent): void {
		// Walking, a click selects what's under the mouse and never captures it (holding the right
		// button does); a drag that turned the camera isn't a click.
		if (this.walker.active) {
			const hit = this.walker.wasDrag || this.controls.locked ? null : this.pickAt(e);
			if (hit) this.onSelect(hit);
			return;
		}
		if (this.pressedWalking) return;
		const hit = this.pickAt(e);
		if (hit) {
			if (this.controls.locked) document.exitPointerLock();
			this.onSelect(hit);
		} else {
			this.controls.lock();
		}
	}

	private onHover(e: MouseEvent): void {
		if (this.controls.locked || performance.now() - this.lastHover < 80) return;
		this.lastHover = performance.now();
		this.canvas.style.cursor = this.pickAt(e) ? 'pointer' : '';
	}

	/**
	 * Turns the torch on or off. Off only puts it out (see tick): taking the light away changed
	 * the number of lights every shader is built for, so three built them all again, those in
	 * view at once and the rest as each came back into view, freezing the view for seconds.
	 */
	private setTorch(on: boolean): void {
		if (on === this.torchOn) return;
		this.torchOn = on;
		// The walking character holds it too (if its model has a hand): dressed again now if it's out walking, else when it next is.
		this.dressed = null;
		if (this.walker.active) void this.dressCharacter();
	}

	/**
	 * Turns the sun's and moon's shadows on or off. Off stops drawing the shadow maps and fades
	 * the shadows out, but the sun still casts them as far as three is concerned: whether a light
	 * casts shadows is part of every shader too (see setTorch).
	 */
	private setShadows(on: boolean): void {
		this.shadowsOn = on;
		this.post.setShadowLight(on ? this.sun : null);
		this.sun.shadow.intensity = on ? SHADOW_INTENSITY * this.shadowStrength : 0;
	}

	/** What to highlight on the ground (chests, herbs, ore, fishing pools, names). */
	setHighlights(settings: HighlightSettings): void {
		this.highlights?.set(settings);
		setWalkableShown(settings.on && settings.walkable);
		if (this.objects) this.objects.invisibleWalls = settings.on && settings.walls;
		if (this.terrain) this.terrain.invisibleWalls = settings.on && settings.walls;
		this.regionOverlay?.setMode(settings.on ? settings.tint || null : null);
		this.regionOverlay?.setLevel(settings.level);
		if (this.restedAreas) this.restedAreas.shown = settings.on && settings.rested;
	}

	/** Called when a key changes a setting, the time or the sound, for the page to show and remember. */
	onChange: (change: ViewChange) => void = () => {};

	/** Called with a line for the page to show, when something asked for can't be done. */
	onNotice: (text: string) => void = () => {};

	/** Whether the camera follows a character on foot rather than flying. */
	get walking(): boolean {
		return this.walker.active;
	}

	/**
	 * Drops a character from where the camera is, facing the camera's way, to the ground under it, and follows it;
	 * or, off, flies on from where the walking camera was. Returns why it can't, or null.
	 */
	setWalking(on: boolean): string | null {
		if (on === this.walker.active || !this.terrain) return null;
		if (!on) {
			this.stopWalking();
			return null;
		}
		const cam = this.camera.position;
		const floor = this.walker.floorAt(cam.x, cam.z, cam.y, cam.y - 5000);
		if (!floor) return 'There’s no ground under the camera to stand on';
		const water = this.liquidOver(new THREE.Vector3(cam.x, floor.y, cam.z));
		if (water?.sea && water.surface - floor.y > 2) return 'Only open sea under the camera: fly over land to walk';
		this.controls.endRide(false);
		this.controls.enabled = false;
		// Dropped from where the camera was, falling to the ground.
		this.walker.dropFrom(cam, this.controls.yaw);
		this.walker.start();
		void this.dressCharacter();
		this.onChange('walking');
		return null;
	}

	/** A world position and direction in its map's own frame (see MapSpot); null off every map. */
	private mapSpot(p: THREE.Vector3, yaw: number, pitch: number): MapSpot | null {
		const at = this.terrain.locate(p.x, p.z);
		if (!at) return null;
		const c = at.continent;
		return { mapId: c.mapId, x: p.x / TILE_SIZE - c.offsetX, y: p.y, z: p.z / TILE_SIZE - c.offsetY, yaw, pitch };
	}

	/** Where a MapSpot is in this world, its map laid out first if it wasn't; null if this game version hasn't the map. */
	private async fromMapSpot(spot: MapSpot): Promise<THREE.Vector3 | null> {
		if (![spot.x, spot.y, spot.z, spot.yaw, spot.pitch].every(Number.isFinite)) return null;
		const c = await this.placementFor(spot.mapId);
		return c ? new THREE.Vector3((spot.x + c.offsetX) * TILE_SIZE, spot.y, (spot.z + c.offsetY) * TILE_SIZE) : null;
	}

	/**
	 * Exactly what's in view (the URL hash rounds it, and gives the height above the ground,
	 * which another version can have elsewhere), for showSpot and walkAt; null off every map.
	 */
	viewSpot(): ViewSpot | null {
		const camera = this.mapSpot(this.camera.position, this.controls.yaw, this.controls.pitch);
		if (!camera) return null;
		const feet = this.walker.active ? this.mapSpot(this.walker.position, this.walker.facing, this.walker.pitch) : null;
		return { camera, walker: feet && { ...feet, ...this.walker.aim } };
	}

	/** Puts the free camera where a viewSpot's camera was; false if this game version hasn't its map. */
	async showSpot(spot: MapSpot): Promise<boolean> {
		const position = await this.fromMapSpot(spot);
		if (!position) return false;
		this.controls.set(position, spot.yaw, spot.pitch);
		return true;
	}

	/**
	 * Puts the character back on foot where a viewSpot had it, the camera turned and zoomed as it
	 * was. Returns why it can't, or null.
	 */
	async walkAt(spot: NonNullable<ViewSpot['walker']>): Promise<string | null> {
		const feet = await this.fromMapSpot(spot);
		if (!feet) return 'That map isn’t in this game version: flying instead';
		this.controls.endRide(false);
		this.controls.enabled = false;
		// Stands on what's under the feet once it has loaded, as on the floor it was on.
		this.walker.place(feet, spot.yaw, spot.pitch);
		this.walker.aim = spot;
		this.walker.start();
		void this.dressCharacter();
		this.onChange('walking');
		return null;
	}

	/** Back to flying, the free camera where the walking camera was. */
	private stopWalking(): void {
		if (!this.walker.active) return;
		this.walker.stop();
		this.controls.enabled = true;
		this.controls.set(this.camera.position.clone(), this.walker.yaw, this.walker.pitch);
		this.onChange('walking');
	}

	/** Dresses the character as the look chosen, the first time it's needed. Resolves to the number of looks for its race and sex. */
	private dressCharacter(): Promise<number> {
		this.dressed ??= this.character?.dress(this.characterLook, this.torchOn) ?? Promise.resolve(0);
		return this.dressed;
	}

	/** The races the character can be, with how many looks each sex has (classic and HD). */
	characterRaces(): Promise<CharacterRace[]> {
		return this.storage.characterRaces();
	}

	/**
	 * Has the travel form perform an emote, over and over with repeat; asked again while it
	 * repeats, loops or holds a pose, it stops. Returns why it can't, or null.
	 */
	emote(emote: Emote, repeat: boolean): string | null {
		if (!this.walker.active) return 'Walk on the ground to perform emotes';
		if (this.walker.state === 'swim') return 'Emotes can’t be performed swimming';
		if (this.walker.state !== 'ground') return 'Emotes can’t be performed in the air';
		const done = this.character?.emote(emote, repeat);
		if (done === null || done === undefined) return 'Your travel form is still loading';
		return done ? null : `This travel form has no ${emote.name.toLowerCase()} emote`;
	}

	/** Stops the emote being performed, getting up from a pose. */
	stopEmote(): void {
		this.character?.stopEmote();
	}

	/** The emote the travel form is performing, if any. */
	get emoting(): Emote | null {
		return this.walker.active ? this.character?.emoting ?? null : null;
	}

	/** Pictures of travel forms for the picker, drawn on a renderer of their own made when first wanted. */
	portraits(): Portraits {
		this.portraitRenderer ??= new Portraits(this.storage);
		return this.portraitRenderer;
	}

	/** Who walks: race, sex, model and look. */
	get look(): CharacterLook {
		return { ...this.characterLook };
	}

	/** Changes who walks; resolves to how many looks that race and sex have (0 when it couldn't be dressed). */
	setLook(look: CharacterLook): Promise<number> {
		this.characterLook = { ...look };
		this.dressed = null;
		// Dressed now if it's out walking; otherwise when it next is.
		return this.walker.active ? this.dressCharacter() : Promise.resolve(this.character?.looks ?? 0);
	}

	/**
	 * Footsteps for the walking character and for creatures walking near the camera, on what's
	 * under their feet: a building's floor (its material's ground), the terrain's texture, or
	 * shallow water.
	 */
	private setUpFootsteps(footsteps: Footsteps): void {
		const down = new THREE.Vector3(0, -1, 0);
		const from = new THREE.Vector3();
		// building: the TerrainType of the floor, known for the character; for creatures, found by casting down when they're off the terrain.
		const step = (at: THREE.Vector3, kind: number, building: number | null | undefined) => {
			if (building === undefined) {
				building = null;
				const terrain = this.terrain.heightAt(at.x, at.z);
				if (!(Math.abs(terrain - at.y) < 1)) {
					from.set(at.x, at.y + 0.5, at.z);
					building = this.objects.castBuildings(from, down, 1.5)?.ground ?? null;
				}
			}
			const group = building !== null ? footsteps.groupOf(building) || STONE_GROUND : this.terrain.groundAt(at.x, at.z);
			const water = this.liquidOver(at);
			footsteps.step(at, this.camera.position, kind, group, water !== null && water.surface > at.y + 0.05);
		};
		if (this.character) {
			this.character.onStep = (kind) => {
				if (this.walker.state === 'ground') step(this.walker.position, kind, this.walker.ground);
			};
		}
		this.objects.onStep = (at, kind) => step(at, kind, undefined);
	}

	/** The walking character's state last frame (or '' not walking), for its splashes into and out of water. */
	private lastWalkerState = '';

	/** What the walking character collides with, stands on and swims in. */
	private setUpWalker(): void {
		const objects = this.objects;
		const terrain = this.terrain;
		// A hole in the ground opens only where a building lies under it (a mine's or a cave's
		// tunnel); elsewhere (a cellar's edge, hidden in the game under rocks and props, not all of
		// them solid) it's still ground, or the character would fall out of the world. Found by a
		// cast down at buildings alone (a rock over the edge isn't a tunnel), kept a moment per terrain cell.
		const holes = new Map<string, { open: boolean; until: number }>();
		const down = new THREE.Vector3(0, -1, 0);
		const holeOpen = (x: number, z: number, surface: number): boolean => {
			const cell = TILE_SIZE / 128;
			const key = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
			const now = performance.now();
			const known = holes.get(key);
			if (known && known.until > now) return known.open;
			const from = new THREE.Vector3(x, surface + 0.5, z);
			const open = objects.nearBuilding(from, HOLE_DEPTH, false) && objects.castBuildings(from, down, HOLE_DEPTH, false) !== null;
			if (holes.size > 4096) holes.clear();
			holes.set(key, { open, until: now + 2000 });
			return open;
		};
		this.walker.world = {
			terrain: (x, z) => {
				const h = terrain.heightAt(x, z);
				if (h > -Infinity) return h;
				const surface = terrain.surfaceAt(x, z);
				return surface > -Infinity && !holeOpen(x, z, surface) ? surface : h;
			},
			surface: (x, z) => terrain.surfaceAt(x, z),
			// A map with no terrain (a dungeon that's one building) is as loaded as it'll get.
			ready: (x, z) => terrain.detailedAt(x, z) || terrain.surfaceAt(x, z) === -Infinity,
			nearBuilding: (at, margin) => objects.nearBuilding(at, margin),
			cast: (from, direction, far) => objects.castBuildings(from, direction, far),
			sweep: (from, move, radius) => objects.sweep(from, move, radius, true),
			pushOut: (at, radius) => objects.pushOut(at, radius, true),
			liquid: (at) => this.liquidOver(at),
		};
	}

	get settings(): ViewSettings {
		return {
			torch: this.torchOn,
			clutter: this.clutter?.enabled ?? true,
			clutterRange: this.clutter?.range ?? CLUTTER_RANGE_DEFAULT,
			detailRange: this.objects?.detailRange ?? 1,
			mouseSpeed: mouseSpeed(),
			collision: !this.controls.ghost,
			side: this.side,
			mapNames: this.mapLabels?.enabled ?? false,
			cinematic: this.controls.cinematic,
			grading: this.post.gradingOn,
			shadows: this.shadowsOn,
			fog: this.post.fogOn,
			clearView: this.clearView,
			unlit: this.unlit,
			creatures: this.objects?.kindShown('creature') ?? true,
			gameObjects: this.objects?.kindShown('object') ?? true,
			spiritHealers: this.objects?.kindShown('spiritHealer') ?? true,
			flySpeed: this.controls.speedScale,
			smartSpeed: this.controls.smartSpeed,
			fixedSpeed: this.controls.fixedSpeed,
			weather: this.weather.setting,
			resolution: this.resolution,
			minimap: !(document.getElementById('minimap-wrap')?.hidden ?? false),
		};
	}

	/** Applies any of the settings; the clutter's needs load() to have run. */
	set settings(next: Partial<ViewSettings>) {
		perf.log('setting', JSON.stringify(next));
		if (next.torch !== undefined) this.setTorch(next.torch);
		if (next.clutter !== undefined && this.clutter) this.clutter.enabled = next.clutter;
		if (typeof next.clutterRange === 'number' && next.clutterRange > 0 && this.clutter) this.clutter.range = next.clutterRange;
		if (typeof next.detailRange === 'number' && next.detailRange > 0 && this.objects) this.objects.detailRange = next.detailRange;
		if (typeof next.mouseSpeed === 'number' && next.mouseSpeed > 0) setMouseSpeed(next.mouseSpeed);
		if (next.collision !== undefined) this.controls.ghost = !next.collision;
		if (next.side) {
			this.side = next.side;
			this.regionOverlay?.setSide(next.side);
			this.flights?.setSide(next.side);
		}
		if (next.weather) this.weather.setting = next.weather;
		if (next.mapNames !== undefined && this.mapLabels) this.mapLabels.enabled = next.mapNames;
		if (next.cinematic !== undefined) this.controls.cinematic = next.cinematic;
		if (next.grading !== undefined) this.post.gradingOn = next.grading;
		if (next.shadows !== undefined) this.setShadows(next.shadows);
		if (next.fog !== undefined) this.post.fogOn = next.fog;
		if (next.clearView !== undefined) this.clearView = next.clearView;
		if (next.unlit !== undefined) {
			this.unlit = next.unlit;
			unlitView.value = next.unlit ? 1 : 0;
			// So the light changes on the next frame, not up to 100 ms later.
			this.lastLightUpdate = 0;
		}
		if (next.creatures !== undefined) this.objects?.setKindShown('creature', next.creatures);
		if (next.gameObjects !== undefined) this.objects?.setKindShown('object', next.gameObjects);
		if (next.spiritHealers !== undefined) this.objects?.setKindShown('spiritHealer', next.spiritHealers);
		if (typeof next.flySpeed === 'number' && next.flySpeed > 0) {
			// Snapped to the slider's notches, so a remembered or stepped value lands on one.
			const notches = Math.round(Math.log2(next.flySpeed) / FLY_SPEED_STEP) * FLY_SPEED_STEP;
			this.controls.speedScale = 2 ** THREE.MathUtils.clamp(notches, -FLY_SPEED_RANGE, FLY_SPEED_RANGE);
		}
		if (next.smartSpeed !== undefined) this.controls.smartSpeed = next.smartSpeed;
		if (typeof next.fixedSpeed === 'number' && next.fixedSpeed > 0) {
			const notches = Math.round(Math.log2(next.fixedSpeed) / FLY_SPEED_STEP) * FLY_SPEED_STEP;
			this.controls.fixedSpeed = 2 ** THREE.MathUtils.clamp(notches, FIXED_SPEED_MIN, FIXED_SPEED_MAX);
		}
		if (next.minimap !== undefined) {
			const wrap = document.getElementById('minimap-wrap');
			if (wrap) wrap.hidden = !next.minimap;
		}
		if (typeof next.resolution === 'string') {
			this.resolution = parseResolution(next.resolution) ? next.resolution : 'window';
			this.resize();
		}
	}

	/** Music and sound on, or null until the music tables are read. */
	get soundOn(): boolean | null {
		return this.music?.enabled ?? null;
	}

	set soundOn(on: boolean) {
		if (this.music) this.music.enabled = on;
	}

	/** Game time of day in minutes (0-1439). */
	get timeMinutes(): number {
		return this.timeOfDay() / 2;
	}

	/** Sets the time of day; it keeps going with the clock from there. */
	set timeMinutes(minutes: number) {
		this.timeOffset = Math.round(minutes * 2 - this.clockTime());
	}

	/** Whether the time of day is the local time (N, or the View menu's Now). */
	get timeIsLocal(): boolean {
		return this.timeOffset === 0;
	}

	resetTime(): void {
		this.timeOffset = 0;
	}

	/** The address of this view, brought up to date, for sharing. */
	shareLink(): string {
		this.writeHash(performance.now(), true);
		return location.href;
	}

	get usesCompressedTextures(): boolean {
		return supportsCompressedTextures(this.renderer);
	}

	/** Loads the low-detail world, places the camera and starts streaming textures. */
	async load(onStatus: (text: string) => void): Promise<void> {
		const anisotropy = this.renderer.capabilities.getMaxAnisotropy();
		// Compiles shaders in the background (KHR_parallel_shader_compile) before objects are shown,
		// then sends their textures to the GPU a few per frame (see UploadQueue).
		// Its shadow's shaders too (see shadowStandIns): left to the shadow pass, each new kind was
		// built there, mid-frame, freezing it.
		const prepare = async (object: THREE.Object3D, shadowPass?: boolean) => {
			await Promise.all([
				this.post.compileAsync(this.renderer, object, this.camera, this.scene, shadowPass),
				...(shadowPass ? [] : shadowStandIns(object).map((o) => this.post.compileAsync(this.renderer, o, this.camera, this.scene, true))),
			]);
			await this.uploads.upload(object);
		};
		this.objects = new ObjectManager(this.storage, this.usesCompressedTextures, anisotropy, prepare);
		// Buildings (and the caves and mines built as buildings) are solid, and so are trees, rocks and logs.
		this.controls.collide = (from, move) => {
			// Most of the time there's no building anywhere near; skip the ray casts then.
			if (!this.objects.nearBuilding(from, move.length() + CAMERA_RADIUS)) return move;
			const allowed = this.objects.sweep(from, move, CAMERA_RADIUS);
			return allowed.add(this.objects.pushOut(from.clone().add(allowed), CAMERA_RADIUS));
		};
		this.terrain = new TerrainManager(this.storage, this.usesCompressedTextures, anisotropy, this.objects, prepare);
		this.terrain.preloadTexture = (texture) => this.uploads.texture(texture);
		this.setUpWalker();
		this.character = new Character(this.storage, this.usesCompressedTextures, anisotropy, prepare);
		this.scene.add(this.character.group);
		// Walking creatures follow the ground.
		this.objects.groundAt = (x, z) => this.terrain.heightAt(x, z);
		this.clutter = new ClutterManager(this.storage, this.usesCompressedTextures, anisotropy, prepare);
		this.terrain.clutter = this.clutter;
		this.scene.add(this.terrain.group, this.objects.group, this.clutter.group);

		const loaded: { map: (typeof KNOWN_MAPS)[number]; tiles: FarTile[] }[] = [];
		for (const map of KNOWN_MAPS) {
			onStatus(`Reading ${map.name} heightmap`);
			loaded.push({ map, tiles: await this.storage.loadFarTiles(map.wdt, map.wdl) });
		}
		this.continents = layoutContinents(loaded);
		loaded.forEach(({ tiles }, i) => this.terrain.addContinent(this.continents[i], tiles));
		onStatus('Placing dungeons and other maps');
		await this.placeMaps();
		this.terrain.buildSeaMask();
		this.addOcean();
		this.loadRegions();

		onStatus('Reading lighting and zone names');
		[this.triggers, this.meetingStones] = await Promise.all([loadTriggers(), loadStones()]);
		// Light for every map in the install (any of them can be gone to).
		const mapIds = new Set(this.continents.map((c) => c.mapId));
		for (const m of await this.storage.listMaps().catch(() => [])) mapIds.add(m.id);
		try {
			const [lighting, areas] = await Promise.all([
				this.storage.loadLighting([...mapIds]),
				this.storage.loadAreas(),
			]);
			this.lighting = new Lighting(lighting);
			for (const a of areas) this.areas.set(a.id, a);
		} catch (e) {
			console.warn('Lighting unavailable, using defaults:', e);
		}
		// The liquids' animation frames; until they're read, liquids are drawn without them.
		for (const [name, book] of Object.entries(flipbooks)) {
			this.storage.loadTextures(book.ids, this.usesCompressedTextures).then(
				(frames) => book.setFrames(frames.every((f) => f.texture) ? frames.map((f) => createTexture(f.texture!, anisotropy, true)) : []),
				(e) => console.warn(`${name} textures unavailable:`, e),
			);
		}
		this.storage.loadLiquidLooks().then((looks) => {
			this.liquidLooks = looks;
			setLiquidLooks(looks);
		}, (e) => console.warn('Liquid types unavailable:', e));
		// Music starts once its tables are read; the world needn't wait for it.
		this.storage.loadMusic().then(
			(data) => {
				this.music = new MusicPlayer(this.storage, data);
				this.underwaterAudio = new UnderwaterAudio(this.music);
				this.backgroundAudio = new BackgroundAudio(this.music);
				this.weather.setMusic(this.music);
				const music = this.music;
				this.storage.loadFootsteps().then((sounds) => this.setUpFootsteps(new Footsteps(music, sounds)), (e) => console.warn('Footstep sounds unavailable:', e));
			},
			(e) => console.warn('Music unavailable:', e),
		);

		// ?time=HH:MM starts at that time of day.
		const time = /^(\d{1,2}):(\d{2})$/.exec(new URLSearchParams(location.search).get('time') ?? '');
		if (time) this.timeOffset = (Number(time[1]) * 60 + Number(time[2])) * 2 - this.timeOfDay();

		// A view inside a dungeon needs that dungeon laid out first.
		const hashInstance = HASH_INSTANCE.exec(location.hash);
		if (hashInstance) await this.placementFor(Number(hashInstance[1]));
		const view = this.viewFromHash();
		if (view) this.controls.set(view.position, view.yaw, view.pitch);
		else this.goToStart();
		window.addEventListener('pagehide', () => this.writeHash(performance.now(), true));
		window.addEventListener('hashchange', async () => {
			if (location.hash === this.lastHash) return;
			const instance = HASH_INSTANCE.exec(location.hash);
			if (instance) await this.placementFor(Number(instance[1]));
			const next = this.viewFromHash();
			if (next) this.travelTo(next.position, next.yaw, next.pitch);
		});
		void this.terrain.loadFarTextures(this.camera.position);
		// Whatever's in the world already (low-detail land, sea, sky), compiled before the first frame.
		// Only compiled: the upload queue is drained by frames, which haven't started yet.
		onStatus('Preparing shaders');
		// With them, what the first detailed tiles and models will need: the shadows' depth shaders
		// and the ground-distance and mountain-shadow passes' for detailed tiles.
		await Promise.all([
			// Not in turn (see PostPass.compileAsync): behind the loading screen, all at once is quickest.
			this.post.compileAsync(this.renderer, this.scene, this.camera, this.scene, false, false),
			...commonShadowStandIns().map((o) => this.post.compileAsync(this.renderer, o, this.camera, this.scene, true, false)),
			this.groundPass.warm(this.renderer),
			this.seaFloorPass.warm(this.renderer),
			this.terrainShadow.warm(this.renderer),
			this.post.compileAsync(this.renderer, liquidBelowStandIns(), this.camera, this.scene, false, false),
		]);
		// One frame drawn behind the loading screen compiles the rest: the shadow, ground-distance
		// and full-screen passes, which draw with shaders of their own.
		this.tick(0, performance.now());
	}

	/**
	 * The URL hash holds the camera as #continent/tileX/tileY/heightAboveGround/yaw/pitch
	 * (tiles fractional, angles in degrees), so views can be bookmarked and shared. Inside a
	 * dungeon the first part is d<map ID> instead.
	 */
	private viewFromHash(): { position: THREE.Vector3; yaw: number; pitch: number } | null {
		const [first = '', ...rest] = location.hash.slice(1).split('/');
		const parts = rest.map(Number);
		if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return null;
		const [tx, ty, alt = 150, yaw = 0, pitch = -17] = parts;
		const instance = HASH_INSTANCE.exec(`#${first}/`);
		const continent = instance ? this.loadedInstances.get(Number(instance[1])) : this.continents[Number(first)];
		if (!continent) return null;
		const x = (tx + continent.offsetX) * TILE_SIZE;
		const z = (ty + continent.offsetY) * TILE_SIZE;
		const ground = Math.max(0, this.terrain.heightAt(x, z));
		return { position: new THREE.Vector3(x, ground + alt, z), yaw: THREE.MathUtils.degToRad(yaw), pitch: THREE.MathUtils.degToRad(pitch) };
	}

	private lastHash = '';
	private pendingHash = '';
	private pendingHashSince = 0;

	private currentHash(): string | null {
		const pos = this.camera.position;
		const at = this.terrain.locate(pos.x, pos.z);
		if (!at) return null;
		const c = at.continent.instance ? `d${at.continent.mapId}` : this.continents.indexOf(at.continent);
		const deg = (r: number) => THREE.MathUtils.radToDeg(r).toFixed(0);
		const yaw = ((this.controls.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
		return `#${c}/${(pos.x / TILE_SIZE - at.continent.offsetX).toFixed(3)}/${(pos.z / TILE_SIZE - at.continent.offsetY).toFixed(3)}/${this.controls.altitude.toFixed(0)}/${deg(yaw)}/${deg(this.controls.pitch)}`;
	}

	/**
	 * Updates the URL once the view has been still for a second. history.replaceState is slow
	 * in Chromium (tens to hundreds of ms per call), so it must never run while flying.
	 */
	private writeHash(now: number, force = false): void {
		const hash = this.currentHash();
		if (!hash || hash === this.lastHash) return;
		if (hash !== this.pendingHash) {
			this.pendingHash = hash;
			this.pendingHashSince = now;
			if (!force) return;
		}
		if (!force && now - this.pendingHashSince < 1000) return;
		this.lastHash = hash;
		history.replaceState(null, '', hash);
	}

	/**
	 * Sea-level plane reaching well past the horizon, so no edge shows even from the overview. In
	 * cells of 3000 yards: across one giant pair of triangles, clipped at the screen's edges, the
	 * positions worked out for each pixel drift by yards as the view turns, and the foam with them.
	 */
	private addOcean(): void {
		const center = this.terrain.bounds().getCenter(new THREE.Vector2());
		const ocean = new THREE.Mesh(
			new THREE.PlaneGeometry(600000, 600000, 200, 200),
			liquidMaterials.ocean,
		);
		ocean.rotation.x = -Math.PI / 2;
		ocean.position.set(center.x, 0, center.y);
		this.scene.add(ocean);
		this.ocean = ocean;
	}

	/**
	 * Where a map sits in the world: a continent's placement, or another map's from the layout
	 * made at the start (placeMaps). Null when the map isn't in the install.
	 */
	private placementFor(mapId: number): Promise<ContinentPlacement | null> {
		const continent = this.continents.find((c) => c.mapId === mapId);
		if (continent) return Promise.resolve(continent);
		let placement = this.instances.get(mapId);
		if (!placement) {
			// Normally every map was laid out at the start; this is for one that wasn't.
			const slot = this.instances.size;
			placement = this.storage.loadInstance(mapId).then((map) => {
				if (!map) return null;
				const p = this.addMap(map, slot * INSTANCE_SPACING, INSTANCE_OFFSET_Y, true);
				void this.terrain.loadFarTextures(this.camera.position, p);
				return p;
			}, (e) => {
				console.warn(`Map ${mapId}:`, e);
				return null;
			});
			this.instances.set(mapId, placement);
		}
		return placement;
	}

	/**
	 * Lays every map other than the continents out in the sea south of them, in rows, so all
	 * of them can be flown to. Reading them takes little: their layout (WDT) and low-detail
	 * terrain; buildings and full detail stream in as the camera comes near, as on the continents.
	 */
	private async placeMaps(): Promise<void> {
		const listings = await this.storage.listMaps().catch((e) => {
			console.warn('Map list unavailable:', e);
			return [];
		});
		const others = listings.filter((m) => !this.continents.some((c) => c.mapId === m.id));
		const maps = (await Promise.all(others.map((m) => this.storage.loadInstance(m.id).then(
			(map) => (map ? { map, category: m.category } : null),
			(e) => {
				console.warn(`Map ${m.id}:`, e);
				return null;
			},
		)))).filter((m) => m !== null);
		const world = this.terrain.bounds();
		for (const { map, category, offsetX, offsetY } of layoutMaps(maps, world)) {
			const p = this.addMap(map, offsetX, offsetY);
			this.labelMap(map, p, CATEGORY_NAMES[category]);
			this.instances.set(map.mapId, Promise.resolve(p));
		}
	}

	/** Puts a map into the world with its tile (0, 0) at the given tile offset. */
	private addMap(map: InstanceMap, offsetX: number, offsetY: number, apart = false): ContinentPlacement {
		const p: ContinentPlacement = { name: map.name, mapId: map.mapId, wdt: map.wdt, offsetX, offsetY, instance: true, apart };
		if (map.wmoTiles.length && !map.farTiles.length && !map.terrainTiles.length) {
			const xs = map.wmoTiles.map((t) => t[0]);
			const ys = map.wmoTiles.map((t) => t[1]);
			p.building = new THREE.Box2(
				new THREE.Vector2((Math.min(...xs) + offsetX) * TILE_SIZE, (Math.min(...ys) + offsetY) * TILE_SIZE),
				new THREE.Vector2((Math.max(...xs) + 1 + offsetX) * TILE_SIZE, (Math.max(...ys) + 1 + offsetY) * TILE_SIZE),
			);
		}
		this.terrain.addContinent(p, map.farTiles);
		this.terrain.addObjectTiles(p, map.wmoTiles);
		this.terrain.addObjectTiles(p, map.terrainTiles, true);
		if (map.wmoBounds) {
			// Placement space around the map's centre -> this map's place in the world.
			const at = (v: [number, number, number]) => new THREE.Vector3(MAP_ORIGIN + v[0] + p.offsetX * TILE_SIZE, v[1], MAP_ORIGIN + v[2] + p.offsetY * TILE_SIZE);
			this.instanceBounds.set(map.mapId, new THREE.Box3().setFromPoints([at(map.wmoBounds.min), at(map.wmoBounds.max)]));
		}
		this.loadedInstances.set(map.mapId, p);
		return p;
	}

	/** A name over the middle of a placed map, a little above its highest point. */
	private labelMap(map: InstanceMap, p: ContinentPlacement, kind: string): void {
		if (!this.mapLabels) return;
		const tiles = [...map.farTiles.map((t): [number, number] => [t.x, t.y]), ...map.terrainTiles, ...map.wmoTiles];
		if (!tiles.length) return;
		const xs = tiles.map((t) => t[0]);
		const ys = tiles.map((t) => t[1]);
		const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs) + 1, Math.min(...ys), Math.max(...ys) + 1];
		let top = map.wmoBounds?.max[1] ?? -Infinity;
		for (const t of map.farTiles) for (const h of t.heights) top = Math.max(top, h);
		if (!Number.isFinite(top)) top = 100;
		const position = new THREE.Vector3(((minX + maxX) / 2 + p.offsetX) * TILE_SIZE, top + 80, ((minY + maxY) / 2 + p.offsetY) * TILE_SIZE);
		this.mapLabels.add(map.name, kind, position, (Math.max(maxX - minX, maxY - minY) / 2) * TILE_SIZE);
	}

	/**
	 * Jumps to any map, including ones nothing leads to (battlegrounds, test and unused maps):
	 * a continent's overview, a dungeon's entrance, above a one-building map's building, or over
	 * the middle of a map's terrain. False when the map can't be loaded.
	 */
	async goToMap(mapId: number): Promise<boolean> {
		const continent = this.continents.findIndex((c) => c.mapId === mapId);
		if (continent >= 0) {
			this.goToContinent(continent);
			return true;
		}
		const placement = await this.placementFor(mapId);
		if (!placement) return false;
		this.triggersArmed = false;
		// Where the game puts you: the entrance, if one leads here.
		const entrance = [...this.triggers.values()].flat().find((t) => t.target.map === mapId);
		if (entrance) {
			this.controls.set(worldFromWow(placement, entrance.target.x, entrance.target.y, entrance.target.z + EYE_HEIGHT), entrance.target.o, 0);
			return true;
		}
		const bounds = this.instanceBounds.get(mapId);
		if (bounds) {
			// Above the building, a little to the south, looking down into it.
			const center = bounds.getCenter(new THREE.Vector3());
			const size = bounds.getSize(new THREE.Vector3());
			this.controls.set(new THREE.Vector3(center.x, bounds.max.y + 40, center.z + Math.max(size.x, size.z) * 0.35), 0, -1);
			return true;
		}
		// Over the middle of the terrain, backed off to the south, looking north and down.
		const { center, extent } = this.terrain.focus(placement);
		const ground = Math.max(0, this.terrain.heightAt(center.x, center.y));
		const pitch = -0.6;
		// Low enough that the terrain around loads in full detail straight away.
		const distance = THREE.MathUtils.clamp(extent * 0.3, 250, 700);
		this.controls.set(new THREE.Vector3(center.x, ground - Math.sin(pitch) * distance, center.y + Math.cos(pitch) * distance), 0, pitch);
		return true;
	}

	/** Walks through dungeon entrances and exits: sends the camera on when it enters a teleport trigger. */
	private checkTriggers(): void {
		// On foot, it's the character that walks in.
		const at = this.walker.active ? this.walker.position : this.camera.position;
		const where = this.wowPosition(at);
		if (!where || this.teleporting) return;
		const z = at.y;
		const hit = this.triggers.get(where.mapId)?.find((t) => insideTrigger(t, where.x, where.y, z));
		if (!this.triggersArmed) {
			this.triggersArmed = !hit;
			return;
		}
		if (hit) void this.teleport(hit);
	}

	private async teleport(t: AreaTrigger): Promise<void> {
		this.teleporting = true;
		try {
			const placement = await this.placementFor(t.target.map);
			if (!placement) {
				console.warn(`${t.name}: map ${t.target.map} isn't in this install`);
				return;
			}
			// WoW orientation turns from north toward west, as the camera's yaw does.
			if (this.walker.active) this.walker.place(worldFromWow(placement, t.target.x, t.target.y, t.target.z), t.target.o);
			else this.controls.set(worldFromWow(placement, t.target.x, t.target.y, t.target.z + EYE_HEIGHT), t.target.o, 0);
		} finally {
			this.teleporting = false;
			this.triggersArmed = false;
		}
	}

	/** Puts you in front of a meeting stone, facing it, as being summoned to it does; the reason it can't, or null. */
	async goToMeetingStone(guid: number): Promise<string | null> {
		const stone = this.meetingStones.find((s) => s.guid === guid);
		const placement = stone && (await this.placementFor(stone.map));
		if (!stone || !placement) return 'That meeting stone isn’t in this install';
		const x = stone.x + Math.cos(stone.o) * STONE_DISTANCE;
		const y = stone.y + Math.sin(stone.o) * STONE_DISTANCE;
		const facing = stone.o + Math.PI;
		this.triggersArmed = false;
		if (this.walker.active) this.walker.place(worldFromWow(placement, x, y, stone.z), facing, 0);
		else this.controls.set(worldFromWow(placement, x, y, stone.z + EYE_HEIGHT + 1), facing, 0.05);
		return null;
	}

	/**
	 * Takes you into a meeting stone's dungeon, where its entrance nearest the stone leads (Dire
	 * Maul and Maraudon have several); the reason it can't, or null.
	 */
	async enterDungeon(guid: number): Promise<string | null> {
		const stone = this.meetingStones.find((s) => s.guid === guid);
		if (!stone) return 'No such meeting stone';
		const distance = (t: AreaTrigger) => (t.map === stone.map ? Math.hypot(t.x - stone.x, t.y - stone.y) : Infinity);
		const entrance = [...this.triggers.values()].flat()
			.filter((t) => t.target.map === stone.dungeonMap)
			.sort((a, b) => distance(a) - distance(b))[0];
		if (entrance) {
			await this.teleport(entrance);
			return null;
		}
		return (await this.goToMap(stone.dungeonMap)) ? null : `${stone.dungeon} isn’t in this install`;
	}

	/** The meeting stone a spawn is, if it is one. */
	meetingStone(guid: number): MeetingStone | null {
		return this.meetingStones.find((s) => s.guid === guid) ?? null;
	}

	/** Above Northshire Abbey, looking north. */
	goToStart(): void {
		this.controls.set(this.startPosition(), 0, -0.3);
	}

	/** Straight down over the whole world. */
	overview(): void {
		const bounds = this.terrain.bounds();
		const size = bounds.getSize(new THREE.Vector2());
		const center = bounds.getCenter(new THREE.Vector2());
		const fov = THREE.MathUtils.degToRad(this.camera.fov);
		const fitHeight = size.y / 2 / Math.tan(fov / 2);
		const fitWidth = size.x / 2 / Math.tan(fov / 2) / this.camera.aspect;
		this.controls.flyTo(new THREE.Vector3(center.x, Math.max(fitHeight, fitWidth) * 1.05, center.y), 0, -Math.PI / 2 + 0.001, 2.5);
	}

	/** An angled view over one continent. */
	goToContinent(index: number): void {
		const c = this.continents[index];
		if (!c) return;
		const { center, extent } = this.terrain.focus(c);
		// Back off to the south and look north at about 50 degrees down.
		const pitch = -0.9;
		const distance = extent * 0.75;
		const target = new THREE.Vector3(center.x, 0, center.y);
		const position = target.clone().add(new THREE.Vector3(0, -Math.sin(pitch), Math.cos(pitch)).multiplyScalar(distance));
		this.controls.flyTo(position, 0, pitch, 2.5);
	}

	private onKey(e: KeyboardEvent): void {
		if (isTyping(e) || !this.terrain) return;
		if (e.code === 'KeyP') {
			if (this.shot) this.endShot();
			else this.startShot();
		} else if (e.code === 'Escape' && this.shot) this.endShot();
		else if (e.code === 'KeyO') this.overview();
		else if (e.code === 'KeyR') this.controls.flyTo(this.startPosition(), 0, -0.3, 2.5);
		// Walking, the number keys perform emotes instead (see the Emotes menu).
		// With Ctrl they switch game version (see the Game version menu).
		else if (e.code.startsWith('Digit') && !this.walker.active && !e.ctrlKey && !e.metaKey && !e.altKey) this.goToContinent(Number(e.code.slice(5)) - 1);
		else if (e.code === 'Backquote' && !e.ctrlKey && !e.metaKey && !e.altKey) {
			const problem = this.setWalking(!this.walker.active);
			if (problem) this.onNotice(problem);
		}
		// Letters rather than [ ] \, which need AltGr on many layouts. The sun moves while T is
		// held; key repeats only pick up Shift being pressed or let go along the way.
		else if (e.code === 'KeyT') this.timeRunning = e.shiftKey ? -1 : 1;
		else if (e.code === 'KeyY') {
			const step = 2 ** (e.shiftKey ? -FLY_SPEED_STEP : FLY_SPEED_STEP);
			if (this.controls.smartSpeed) this.settings = { flySpeed: this.controls.speedScale * step };
			else this.settings = { fixedSpeed: this.controls.fixedSpeed * step };
			this.onChange(this.controls.smartSpeed ? 'flySpeed' : 'fixedSpeed');
		} else if (e.code === 'KeyN') {
			this.resetTime();
			this.onChange('time');
		} else if (e.code === 'KeyM' && this.music) {
			this.music.enabled = !this.music.enabled;
			this.onChange('sound');
		} else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
			const s = this.settings;
			const toggles: Record<string, Partial<ViewSettings>> = {
				KeyL: { torch: !s.torch },
				KeyG: { collision: !s.collision },
				KeyF: { side: s.side === 'alliance' ? 'horde' : 'alliance' },
				KeyV: { clutter: !s.clutter },
				KeyJ: { cinematic: !s.cinematic },
				KeyB: { grading: !s.grading },
				// Walking, X sinks in water instead.
				...(this.walker.active ? {} : { KeyX: { shadows: !s.shadows } }),
				KeyZ: { fog: !s.fog },
			};
			if (this.mapLabels) toggles.KeyI = { mapNames: !s.mapNames };
			const change = toggles[e.code];
			if (!change) return;
			this.settings = change;
			this.onChange(Object.keys(change)[0] as keyof ViewSettings);
		}
	}

	/** Reads the regions (areas, graveyards, inns, weather), flight paths and transports, and lays them over the continents. */
	private loadRegions(): void {
		if (this.restedAreas) this.scene.add(this.restedAreas.group);
		if (this.flights) this.scene.add(this.flights.group);
		this.scene.add(this.weather.group);
		RegionData.load().then((data) => {
			if (!data) return;
			this.regionData = data;
			this.regionOverlay?.setData(data, this.continents);
			this.restedAreas?.setData(data, this.continents);
		}, (e) => console.warn('Regions unavailable:', e));
		if (this.flights) {
			Flights.loadFile().then((file) => {
				if (file) this.flights!.setData(file, this.continents);
			}, (e) => console.warn('Flight paths unavailable:', e));
		}
		const transports = new Transports(this.objects);
		this.transports = transports;
		Transports.loadFile().then((file) => {
			if (file) transports.setData(file, this.continents, (mapId, x, y) => this.regionData?.areaAtWow(mapId, x, y)?.name ?? null);
		}, (e) => console.warn('Boats and zeppelins unavailable:', e));
		this.storage.loadTextures([SNOWFLAKE_TEXTURE], this.usesCompressedTextures).then(
			([flake]) => {
				if (flake?.texture) this.weather.setSnowflake(createTexture(flake.texture, 1));
			},
			(e) => console.warn('Snowflake texture unavailable:', e),
		);
	}

	/** The weather for the zone under the camera, drawn round it outdoors and above water. */
	private updateWeather(dt: number, now: number): void {
		const pos = this.camera.position;
		const continent = this.terrain.locate(pos.x, pos.z)?.continent;
		const area = continent && this.regionData ? this.regionData.areaAt(continent, pos.x, pos.z) : null;
		const zone = area ? this.regionData!.areas.get(area.zone) ?? area : null;
		if (now - this.lastWeatherRoomCheck > 250) {
			this.lastWeatherRoomCheck = now;
			this.weatherIndoors = !!this.objects.roomAt(pos);
		}
		const open = !this.underwater && !this.weatherIndoors;
		this.weather.update(dt, this.camera, zone ? { id: zone.id, name: zone.name } : null, zone ? this.regionData!.weather(zone.id) : null, open);
	}

	/** The area under the camera and its parents count as explored once the camera is down among them. */
	private explore(): void {
		if (this.controls.altitude > EXPLORE_ALTITUDE) return;
		const areas: number[] = [];
		for (let id = this.areaHere() ?? 0, i = 0; id && i < 8; i++) {
			areas.push(id);
			id = this.areas.get(id)?.parent ?? 0;
		}
		if (areas.length) this.onExplore(areas);
	}

	/** What the ground tint's colours mean, for the panel's key. */
	get tintKey(): [string, string][] {
		return this.regionOverlay?.key ?? [];
	}

	/** Flight masters the side shown can use. */
	get flightMasters(): FlightMaster[] {
		return this.flights?.list ?? [];
	}

	/** Called when the flight masters on offer change (the side changed, or they were read). */
	set onFlightsChange(fn: () => void) {
		if (this.flights) this.flights.onChange = fn;
	}

	/** Whether the flight paths are drawn. */
	set flightPathsShown(shown: boolean) {
		if (this.flights) this.flights.shown = shown;
	}

	/** The flight master nearest the camera on this map, for the side shown. */
	nearestFlightMaster(): FlightMaster | null {
		const pos = this.camera.position;
		const continent = this.terrain.locate(pos.x, pos.z)?.continent;
		return continent && this.flights ? this.flights.nearest(pos, continent.mapId) : null;
	}

	/**
	 * Takes the flight from one flight master to another, the way the game would route it, at a
	 * multiple of the mounts' speed. The reason it can't, or null once under way.
	 */
	takeFlight(from: number, to: number, speedScale = 1): string | null {
		const flights = this.flights;
		if (!flights) return 'No flight paths';
		const plan = flights.plan(from, to);
		if (!plan) return 'No route between those for this side';
		const ride = flights.ride(plan.points, speedScale);
		const start = plan.points[0];
		const destination = flights.list.find((m) => m.id === to)?.name ?? '';
		this.triggersArmed = false;
		this.controls.set(start.clone().setY(start.y + 2), this.controls.yaw, this.controls.pitch);
		this.flight = { to: destination, remaining: ride.remaining };
		this.controls.ride(ride, () => {
			this.flight = null;
			this.triggersArmed = false;
			this.onChange('flight');
		});
		this.onChange('flight');
		return null;
	}

	/** Gets off the flight, boat or zeppelin being ridden. */
	stopFlight(): void {
		this.controls.endRide(false);
	}

	get onFlight(): boolean {
		return this.flight !== null;
	}

	/** The boats and zeppelins, once read. */
	get transportList(): Transport[] {
		return this.transports?.transports ?? [];
	}

	/** Called once the boats and zeppelins are read. */
	set onTransportsChange(fn: () => void) {
		if (this.transports) this.transports.onChange = fn;
	}

	/** Puts the camera on board a boat or zeppelin, where it is now; the reason it can't, or null. */
	goToTransport(entry: number): string | null {
		const t = this.transports?.get(entry);
		const seat = t && this.transports!.seat(t, Date.now());
		if (!seat) return 'That isn’t anywhere on the continents';
		this.triggersArmed = false;
		this.controls.set(seat.position, seat.yaw, -0.15);
		return null;
	}

	/** Rides a boat or zeppelin wherever it goes, holding still on board at the docks, until got off. */
	rideTransport(entry: number): string | null {
		const problem = this.goToTransport(entry);
		if (problem) return problem;
		const t = this.transports!.get(entry)!;
		this.voyage = t;
		this.controls.ride(this.transports!.ride(t), () => {
			this.voyage = null;
			this.triggersArmed = false;
			this.onChange('voyage');
		});
		this.onChange('voyage');
		return null;
	}

	get onTransport(): boolean {
		return this.voyage !== null;
	}

	/** What a boat or zeppelin is doing now, in words. */
	transportStatus(entry: number): string {
		const t = this.transports?.get(entry);
		if (!t) return '';
		const s = this.transports!.status(t, Date.now());
		return s.docked ? `At ${s.dock}, leaves for ${s.next} in ${formatDuration(s.seconds)}` : `On the way to ${s.next}, arrives in ${formatDuration(s.seconds)}`;
	}

	/** The dock nearest the camera on this map and the next departures from it, in words; '' where there's none. */
	nearestDockStatus(): string {
		const pos = this.camera.position;
		const continent = this.terrain.locate(pos.x, pos.z)?.continent;
		const dock = continent && this.transports?.nearestDock(pos, continent.mapId, Date.now());
		if (!dock) return '';
		const kinds = { ship: 'boat', zeppelin: 'zeppelin' };
		const lines = dock.departures.map((d) => `The ${kinds[d.transport.kind]} to ${d.to} ${d.docked ? 'is in, ' : ''}leaves in ${formatDuration(d.seconds)}`);
		return [`Nearest dock: ${dock.name}, ${(dock.distance / 1000).toFixed(1)} km away`, ...lines].join('\n');
	}

	/** Where the camera is (or the character walking), for the world map. */
	worldMapView(): WorldMapView | null {
		const w = this.wowPosition(this.walker.active ? this.walker.position : this.camera.position);
		return w ? { ...w, facing: this.walker.active ? this.walker.facing : this.controls.yaw } : null;
	}

	/** The area's name at a point on a continent (WoW coordinates), for the world map. */
	areaNameAt(mapId: number, x: number, y: number): string | null {
		return this.regionData?.areaAtWow(mapId, x, y)?.name ?? null;
	}

	/** Flies over a point of a map in WoW coordinates. */
	flyOverWow(mapId: number, x: number, y: number): void {
		this.flyOver(mapId, (MAP_ORIGIN - y) / TILE_SIZE, (MAP_ORIGIN - x) / TILE_SIZE);
	}

	/** Where in which map's tile grid the camera (or the character walking) is, for the minimap; null over the open sea. */
	minimapView(): MinimapView | null {
		const walking = this.walker.active;
		const pos = walking ? this.walker.position : this.camera.position;
		const at = this.terrain?.locate(pos.x, pos.z);
		if (!at) return null;
		const c = at.continent;
		return { mapId: c.mapId, wdt: c.wdt, x: pos.x / TILE_SIZE - c.offsetX, y: pos.z / TILE_SIZE - c.offsetY, yaw: walking ? this.walker.facing : this.controls.yaw };
	}

	/** Flies over a point of a map's tile grid (in local tiles), keeping the height above ground and the heading. */
	flyOver(mapId: number, x: number, y: number): void {
		const c = this.continents.find((p) => p.mapId === mapId) ?? this.loadedInstances.get(mapId);
		if (!c) return;
		const wx = (x + c.offsetX) * TILE_SIZE;
		const wz = (y + c.offsetY) * TILE_SIZE;
		const ground = Math.max(0, this.terrain.heightAt(wx, wz));
		this.controls.flyTo(new THREE.Vector3(wx, ground + Math.max(this.controls.altitude, 40), wz), this.controls.yaw, this.controls.pitch, 1.5);
	}

	/**
	 * Goes to a zone (looking north over the whole of it) or a town or landmark (from close by).
	 * False when its map isn't in the install.
	 */
	async goToPlace(place: Place): Promise<boolean> {
		const placement = await this.placementFor(place.mapId);
		if (!placement) return false;
		this.triggersArmed = false;
		const spot = worldFromWow(placement, place.x, place.y, 0);
		const pitch = place.size ? -0.7 : -0.5;
		const distance = place.size ? THREE.MathUtils.clamp(place.size * 0.35, 400, 2200) : 420;
		const position = new THREE.Vector3(spot.x, 0, spot.z + Math.cos(pitch) * distance);
		// Above the higher of the ground there and under the camera, so a hill between doesn't swallow it.
		const ground = Math.max(0, this.terrain.heightAt(spot.x, spot.z), this.terrain.heightAt(position.x, position.z));
		position.y = ground - Math.sin(pitch) * distance;
		this.travelTo(position, 0, pitch);
		return true;
	}

	/** Flies to a view on the same map; across maps, jumps, as flying there would cross the whole world. */
	private travelTo(position: THREE.Vector3, yaw: number, pitch: number): void {
		const here = this.terrain.locate(this.camera.position.x, this.camera.position.z)?.continent;
		const there = this.terrain.locate(position.x, position.z)?.continent;
		if (here === there) this.controls.flyTo(position, yaw, pitch, 2.5);
		else this.controls.set(position, yaw, pitch);
	}

	private startPosition(): THREE.Vector3 {
		const ek = this.continents[0];
		const x = (32.5 + ek.offsetX) * TILE_SIZE;
		const z = (48.95 + ek.offsetY) * TILE_SIZE;
		return new THREE.Vector3(x, this.terrain.heightAt(x, z) + 140, z);
	}

	private plates: Plate[] = [];
	private lastPlateScan = 0;

	/** Rescans nearby NPCs a few times a second; re-projects their names every frame. */
	private updateNameplates(now: number): void {
		if (!this.nameplates) return;
		if (now - this.lastPlateScan > 150) {
			this.lastPlateScan = now;
			this.objects.nameplates(this.camera.position, NAMEPLATE_RANGE, this.plates);
				if (this.plates.length > NAMEPLATE_MAX) {
					this.plates.sort((a, b) => a.distance - b.distance).length = NAMEPLATE_MAX;
				}
			// Like the game, only name NPCs you could actually see. Underground (caves, mines) the
			// terrain surface is overhead, so only buildings count.
			const cam = this.camera.position;
			const underground = cam.y < this.terrain.surfaceAt(cam.x, cam.z) - 0.5;
			for (const p of this.plates) {
				p.visible = (underground || !this.terrainBlocks(this.camera.position, p.position)) && !this.objects.blocksSight(this.camera.position, p.position);
			}
		}
		// Every frame, so names keep up with walking creatures; and distances change as the camera moves.
		for (const p of this.plates) {
			headPosition(p.matrix, p.height, p.position);
			p.distance = p.position.distanceTo(this.camera.position);
		}
		this.nameplates.update(this.plates, this.camera, this.renderer, this.side);
	}

	/** Whether the ground rises above the straight line between two points (sampled every 1.5 yd). */
	private terrainBlocks(from: THREE.Vector3, to: THREE.Vector3): boolean {
		const steps = Math.ceil(from.distanceTo(to) / 1.5);
		for (let i = 1; i < steps; i++) {
			const t = i / steps;
			const x = from.x + (to.x - from.x) * t;
			const y = from.y + (to.y - from.y) * t;
			const z = from.z + (to.z - from.z) * t;
			if (y < this.terrain.heightAt(x, z) - 0.2) return true;
		}
		return false;
	}

	/**
	 * Sizes the canvas to the window, or to the fixed size chosen: a box of exactly that many
	 * CSS pixels (shrunk to fit a smaller window) centred in the window, with the names and
	 * highlights laid over the same box. The world's detail is the same either way.
	 */
	private resize(): void {
		const fixed = parseResolution(this.resolution);
		const boxes = [this.canvas.style, ...(this.plateContainer ? [this.plateContainer.style] : [])];
		if (!fixed) {
			for (const box of boxes) box.left = box.top = box.width = box.height = '';
			const w = this.canvas.clientWidth || window.innerWidth;
			const h = this.canvas.clientHeight || window.innerHeight;
			this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
			this.renderer.setSize(w, h, false);
			this.camera.aspect = w / h;
			this.camera.updateProjectionMatrix();
			return;
		}
		// The viewer is that many CSS pixels (shrunk to fit if the window is smaller), drawn at
		// the same pixel density as the window would be, so only its size changes.
		const fit = Math.min(1, window.innerWidth / fixed[0], window.innerHeight / fixed[1]);
		const [shownW, shownH] = [fixed[0] * fit, fixed[1] * fit];
		for (const box of boxes) {
			box.width = `${shownW}px`;
			box.height = `${shownH}px`;
			box.left = `${(window.innerWidth - shownW) / 2}px`;
			box.top = `${(window.innerHeight - shownH) / 2}px`;
		}
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.renderer.setSize(shownW, shownH, false);
		this.camera.aspect = shownW / shownH;
		this.camera.updateProjectionMatrix();
	}

	start(): void {
		let last = performance.now();
		const frame = (now: number) => {
			const dt = Math.min(0.1, (now - last) / 1000);
			last = now;
			this.tick(dt, now);
			requestAnimationFrame(frame);
		};
		requestAnimationFrame(frame);
	}

	private tick(dt: number, now: number): void {
		perf.frameStart(now, this.renderer.info.programs?.length ?? 0);
		// The camera holds still while a screenshot is prepared.
		if (!this.shot) {
			if (this.walker.active) {
				this.walker.update(dt);
				const cam = this.camera.position;
				this.controls.mirror(this.walker.yaw, this.walker.pitch, Math.max(0, cam.y - Math.max(this.terrain.surfaceAt(cam.x, cam.z), 0)), this.walker.speed);
			} else {
				this.controls.update(dt, (x, z) => this.terrain.heightAt(x, z), (x, z) => this.terrain.surfaceAt(x, z));
			}
		}
		this.character?.update(dt, this.walker);

		liquidTime.value = now / 1000;
		animateFlipbooks(now / 1000);
		const pos = this.camera.position;

		if (now - this.lastTriggerCheck > 100) {
			this.lastTriggerCheck = now;
			this.checkTriggers();
		}
		// While T is held the light follows every frame, so the sun glides rather than steps.
		if (this.timeRunning) {
			this.timeOffset += this.timeRunning * TIME_RATE * dt;
			this.updateLighting();
			if (now - this.lastTimeChange > 100) {
				this.lastTimeChange = now;
				this.onChange('time');
			}
		} else if (this.lightFade.fading || now - this.lastLightUpdate > 100) {
			// Every frame while the light fades to a new zone's, so the fade is smooth.
			this.lastLightUpdate = now;
			this.updateLighting();
		}
		this.sky.mesh.position.copy(pos);
		// The light comes from the torch in the character's hand when it holds one in view, else from where the camera carries it.
		if (this.walker.active && this.character?.torchAt(this.torchWorld)) {
			this.camera.updateMatrixWorld();
			this.torch.position.copy(this.camera.worldToLocal(this.torchWorld));
		} else {
			this.torch.position.copy(TORCH_POSITION);
		}
		// A few out-of-phase sines give the flame's flicker.
		const s = now / 1000;
		this.torch.intensity = !this.torchOn || this.unlit ? 0 : TORCH_INTENSITY * (1 + 0.06 * Math.sin(s * 11.3) + 0.04 * Math.sin(s * 23.7 + 1.3) + 0.03 * Math.sin(s * 5.1 + 0.4));

		if (now - this.lastLodUpdate > 200) {
			this.lastLodUpdate = now;
			perf.time('lod.update', () => this.terrain.update(pos));
		}
		// Before the objects, so the transports' new places are drawn this frame.
		this.transports?.update(Date.now(), pos);
		this.objects.extraEmitters = this.character?.emitterSources() ?? [];
		perf.time('objects.update', () => this.objects.update(now, pos));
		perf.time('uploads', () => this.uploads.drain());
		this.clutter.update(now, pos, this.terrain.surfaceAt(pos.x, pos.z));
		// Under water the surface is seen from below, where its depth isn't used.
		if (!this.underwater) perf.time('groundDistance', () => this.groundPass.render(this.renderer, this.terrain.group, this.camera));
		if (!this.underwater) perf.time('seaFloor', () => this.seaFloorPass.update(this.renderer, this.terrain.group, pos, now));
		// Mountains' shadows past the shadow maps' reach.
		perf.time('terrainShadow', () => this.terrainShadow.update(this.renderer, this.terrain.group, pos, this.controls.altitude, this.sun.position, this.sun.shadow.camera.far, this.shadowsOn ? this.shadowStrength : 0, now));
		this.renderer.shadowMap.needsUpdate = (this.shadowsOn || !this.shadowMapsDrawn) && (this.shadowFrame++ & 1) === 0;
		if (this.renderer.shadowMap.needsUpdate) this.shadowMapsDrawn = true;
		perf.time('render', () => this.post.render(this.renderer, this.scene, this.camera));
		if (this.shot) this.updateShot(now);
		perf.time('nameplates', () => this.updateNameplates(now));
		if (this.mapLabels) {
			// Only out in the open: not in a cave, a building or down on the ground among things.
			if (now - this.lastLabelCheck > 250) {
				this.lastLabelCheck = now;
				this.mapLabels.visible = this.controls.altitude > LABEL_ALTITUDE && !this.objects.roomAt(pos);
			}
			this.mapLabels.update(this.camera, this.canvas.clientWidth, this.canvas.clientHeight);
		}
		perf.time('highlights', () => {
			const continent = this.terrain.locate(pos.x, pos.z)?.continent ?? null;
			this.highlights?.update(now, this.camera, continent, this.canvas.clientWidth, this.canvas.clientHeight);
			this.regionOverlay?.update(now, this.camera, continent, this.terrain.surfaceAt(pos.x, pos.z), this.canvas.clientWidth, this.canvas.clientHeight);
			this.restedAreas?.update(now, this.camera, this.canvas.clientWidth, this.canvas.clientHeight);
			this.flights?.update(this.camera, continent, this.canvas.clientWidth, this.canvas.clientHeight);
		});
		this.updateWeather(dt, now);
		if (now - this.lastExploreCheck > 250) {
			this.lastExploreCheck = now;
			this.explore();
		}
		if (this.music) {
			if (now - this.lastMusicCheck > 250) {
				this.lastMusicCheck = now;
				this.musicTarget = this.musicHere();
				this.background = this.backgroundHere();
			}
			const night = sunDirection(this.timeOfDay()).y < 0;
			this.music.update(dt, now, this.musicTarget, night);
			const height = pos.y - Math.max(0, this.terrain.heightAt(pos.x, pos.z));
			this.backgroundAudio?.update(dt, now, this.background, night, height, this.underwater !== null);
			this.underwaterAudio?.update(dt, this.underwater !== null, this.underwaterSounds(), !this.walker.active && this.underwater !== null);
			// The character splashes going into water (falling, jumping or wading in until it swims) and coming out.
			const state = this.walker.active ? this.walker.state : '';
			const swam = this.lastWalkerState === 'swim';
			if (this.lastWalkerState && this.lastWalkerState !== 'settling' && state && (state === 'swim') !== swam) {
				this.underwaterAudio?.splash(state === 'swim', this.walker.scale < SMALL_SPLASH);
			}
			this.lastWalkerState = state;
		}
		perf.record('drawCalls', this.renderer.info.render.calls);
		perf.record('triangles', this.renderer.info.render.triangles);

		this.frames++;
		if (now - this.lastFpsTime > 500) {
			this.fps = (this.frames * 1000) / (now - this.lastFpsTime);
			this.frames = 0;
			this.lastFpsTime = now;
			this.onHud(this.hudInfo());
			this.writeHash(now);
		}
	}

	/**
	 * Starts a screenshot of the current view: the tiles in it load in full, with every tree, prop,
	 * tuft of grass and particle effect on them however far off, and once they have the picture is saved (see updateShot).
	 */
	private startShot(): void {
		if (this.controls.locked) document.exitPointerLock();
		// Only the tiles that can be seen: not those behind a hill, or above a cave from inside it.
		this.occlusion ??= new ViewOcclusion(this.renderer);
		this.occlusion.render(this.renderer, this.camera, this.terrain.group, this.objects.group, this.objects.buildingMeshes());
		const tiles = this.terrain.holdInView(this.camera, SHOT_TILES, (box) => this.occlusion!.inView(box));
		this.objects.unlimited = true;
		this.clutter.holdInView(this.camera);
		this.shot = { started: performance.now(), tiles, readySince: 0, position: this.camera.position.clone(), yaw: this.controls.yaw, pitch: this.controls.pitch };
		// Start loading on the next frame.
		this.lastLodUpdate = 0;
		this.onShotStatus('Screenshot: finding what’s in view…');
	}

	/** Lets the held tiles and far objects go again, back at the view the screenshot was taken from. */
	private endShot(): void {
		const shot = this.shot;
		if (!shot) return;
		this.shot = null;
		this.terrain.holdInView(null);
		this.objects.unlimited = false;
		this.clutter.holdInView(null);
		// Walking, the camera was held where it was (the character waited too).
		if (!this.walker.active) this.controls.set(shot.position, shot.yaw, shot.pitch);
		this.onShotStatus(null);
	}

	/** Called after each frame while a screenshot is prepared: reports progress, and takes it once all has loaded. */
	private updateShot(now: number): void {
		const shot = this.shot!;
		const tiles = this.terrain.heldPending;
		const models = this.objects.pending + this.clutter.pending;
		const timedOut = now - shot.started > SHOT_TIMEOUT;
		if ((tiles || models) && !timedOut) {
			shot.readySince = 0;
			this.onShotStatus(`Screenshot: loading ${shot.tiles - tiles} of ${shot.tiles} tiles, ${models} model loads to go · P or Esc cancels`);
			return;
		}
		shot.readySince ||= now;
		if (now - shot.readySince < SHOT_SETTLE && !timedOut) return;
		const name = this.takeShot();
		this.endShot();
		this.onShotStatus(`Screenshot saved: ${name}${timedOut ? ' (some of it never loaded)' : ''}`, true);
	}

	/** Draws the view again at a higher resolution and saves it as a PNG; returns the file name. */
	private takeShot(): string {
		const ratio = this.renderer.getPixelRatio();
		const size = this.renderer.getSize(new THREE.Vector2());
		const largest = Math.min(this.renderer.capabilities.maxTextureSize, SHOT_MAX_SIZE);
		this.renderer.setPixelRatio(ratio * Math.min(SHOT_SCALE, largest / (size.x * ratio), largest / (size.y * ratio)));
		if (!this.underwater) this.groundPass.render(this.renderer, this.terrain.group, this.camera);
		this.renderer.shadowMap.needsUpdate = true;
		this.post.render(this.renderer, this.scene, this.camera);
		const pos = this.camera.position;
		const place = this.zoneNames().zone ?? this.terrain.locate(pos.x, pos.z)?.continent.name ?? 'Open sea';
		const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
		const name = `MapExplorer ${place.replace(/[\\/:*?"<>|]/g, '')} ${stamp}.png`;
		// The canvas is copied now, before it's resized back (which clears it); only the encoding waits.
		this.canvas.toBlob((blob) => {
			if (!blob) return;
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = name;
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 60000);
		}, 'image/png');
		this.renderer.setPixelRatio(ratio);
		return name;
	}

	/** The local clock in half-minutes. */
	private clockTime(): number {
		const d = new Date();
		return (d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60) * 2;
	}

	/** Game time in half-minutes: the local clock, shifted with T and Shift+T. */
	private timeOfDay(): number {
		const t = this.clockTime() + this.timeOffset;
		return ((t % DAY) + DAY) % DAY;
	}

	private stopTime(): void {
		if (!this.timeRunning) return;
		this.timeRunning = 0;
		this.onChange('time');
	}

	/** Position in WoW world coordinates (x north, y west) and the continent's map ID, of the camera or another point. */
	private wowPosition(pos = this.camera.position): { mapId: number; x: number; y: number } | null {
		const at = this.terrain.locate(pos.x, pos.z);
		if (!at) return null;
		return {
			mapId: at.continent.mapId,
			x: MAP_ORIGIN - (pos.z / TILE_SIZE - at.continent.offsetY) * TILE_SIZE,
			y: MAP_ORIGIN - (pos.x / TILE_SIZE - at.continent.offsetX) * TILE_SIZE,
		};
	}

	/**
	 * Rain, snow and sandstorms dim the sun, cloud the sky over and bring the fog in, its colour
	 * as bright as the sky's fog would be (so a rainy night stays dark).
	 */
	private applyWeatherLight(skyFog: THREE.Color | null): void {
		const look = this.weather.lightLook;
		if (!look || !skyFog) return;
		const brightness = THREE.MathUtils.clamp((skyFog.r * 0.3 + skyFog.g * 0.59 + skyFog.b * 0.11) * 2.5, 0.06, 1);
		const color = look.fogColor.clone().multiplyScalar(brightness);
		this.sun.color.multiplyScalar(1 - look.darken);
		this.ambient.color.multiplyScalar(1 - look.darken * 0.4);
		this.sky.overcast(color, look.fogMix);
		const fog = this.fogLook;
		fog.color.lerp(color, look.fogMix);
		fog.sunColor.multiplyScalar(1 - look.darken);
		fog.density *= look.fogDensity;
		this.fog.color.lerp(color, look.fogMix);
		(this.scene.background as THREE.Color).lerp(color, look.fogMix);
		const alt = this.controls.altitude;
		this.fog.far = Math.min(this.fog.far, look.fogFar + alt * 4);
		this.fog.near = Math.min(this.fog.near, this.fog.far * 0.15);
	}

	/** The lowest ground on a grid around a point (for the fog to lie at); sea level over open sea, where there's none. */
	private lowestGroundAround(p: THREE.Vector3): number {
		let lowest = Infinity;
		const half = (FOG_BASE_SAMPLES - 1) / 2;
		for (let i = 0; i < FOG_BASE_SAMPLES; i++) {
			for (let j = 0; j < FOG_BASE_SAMPLES; j++) {
				const h = this.terrain.heightAt(p.x + ((i - half) / half) * FOG_BASE_REACH, p.z + ((j - half) / half) * FOG_BASE_REACH);
				if (h > -Infinity && h < lowest) lowest = h;
			}
		}
		return lowest < Infinity ? lowest : 0;
	}

	/** Sun, ambient, sky and fog from the game's light zones for the current place and time. */
	private updateLighting(): void {
		// A map laid out apart isn't in the sea mask, so it gets no sea at all.
		const here = this.terrain.locate(this.camera.position.x, this.camera.position.z);
		if (this.ocean) this.ocean.visible = !here?.continent.apart;
		// Over a map that's only a building, the sea opens up over it.
		const building = here?.continent.building;
		if (building) seaMask.uSeaHole.value.set(building.min.x, building.min.y, building.max.x, building.max.y);
		else seaMask.uSeaHole.value.set(0, 0, 0, 0);
		const t = this.timeOfDay();
		const sunDir = sunDirection(t);
		const where = this.wowPosition();
		// The open sea between the laid-out maps belongs to no map: the Eastern Kingdoms' outdoor
		// light there (far from any of its zones, so only its global light).
		const place = where ?? OPEN_SEA_LIGHT;
		const sampled = this.lighting ? this.lighting.sample(place.mapId, place.x, place.y, t) : null;
		// Light zones can change quickly at their edges; fade to the new light rather than jump.
		const now = performance.now();
		const state = this.lightFade.step(sampled, Math.min(1, (now - this.lastLightStep) / 1000), t, this.camera.position);
		this.lastLightStep = now;
		const alt = this.controls.altitude;
		this.sun.shadow.camera.far = Math.min(SHADOW_RANGE + alt * SHADOW_RANGE_PER_ALTITUDE, SHADOW_RANGE_MAX);
		let fogNear = 1200;
		let fogFar = 9000;
		if (state) {
			const c = state.colors;
			// Lit by the sun by day and by the (opposite) moon at night; the colours already say how bright.
			const bySun = sunDir.y > SUN_TO_MOON;
			const lightDir = bySun ? sunDir : new THREE.Vector3(-sunDir.x, Math.abs(sunDir.y) + 0.35, sunDir.z).normalize();
			// Shadows fade to nothing either side of the switch, so they don't jump round.
			this.shadowStrength = bySun ? THREE.MathUtils.smoothstep(sunDir.y, SUN_TO_MOON, SUN_TO_MOON + 0.12) : THREE.MathUtils.smoothstep(-sunDir.y, -SUN_TO_MOON, 0.1);
			this.sun.shadow.intensity = this.shadowsOn ? SHADOW_INTENSITY * this.shadowStrength : 0;
			this.sun.position.copy(lightDir);
			this.sun.color.copy(c.direct);
			this.ambient.color.copy(c.ambient);
			this.ambient.groundColor.copy(c.ambient).multiplyScalar(0.8);
			this.sky.update(state, sunDir, this.camera.position);
			this.post.grading.set(state.grading);
			const fog = this.fogLook;
			fog.color.copy(c.skyFog);
			fog.sunColor.copy(c.direct).multiplyScalar(this.shadowStrength);
			fog.sunDir.copy(lightDir);
			// Gone from far above, where it would only veil the map.
			fog.density = FOG_DENSITY * state.fogDensity * (1 - THREE.MathUtils.smoothstep(alt, 1500, 4000));
			this.fog.color.copy(c.skyFog);
			(this.scene.background as THREE.Color).copy(c.skyFog);
			if (state.fogEnd > 0) {
				fogFar = state.fogEnd;
				fogNear = state.fogEnd * THREE.MathUtils.clamp(state.fogScaler, 0, 0.9);
			}
		}
		// Clear from high up so the overview shows everything.
		this.fog.near = Math.max(fogNear, 1200 + alt * 2);
		this.fog.far = Math.max(fogFar, 9000 + alt * 14);
		this.applyWeatherLight(state?.colors.skyFog ?? null);

		// Under water, as in the game: the view closes in and fades to the water's colour, darker
		// the deeper you are.
		this.underwater = this.liquidAt(this.camera.position);
		this.sky.mesh.visible = !this.underwater;
		const base = this.lowestGroundAround(this.camera.position);
		this.fogBase = this.fogBase === null ? base : this.fogBase + (base - this.fogBase) * 0.15;
		this.fogLook.base = this.fogBase;
		this.post.setFog(this.underwater || !state || this.clearView ? null : this.fogLook);
		setLiquidsFromBelow(this.underwater !== null);
		if (this.underwater) {
			const { kind, type, surface } = this.underwater;
			const look = UNDERWATER[kind];
			const liquid = this.liquidLooks?.types[type];
			const color = new THREE.Color(look.color);
			if (liquid?.color) {
				color.setHex(liquid.color);
			} else if (state && (kind === 'water' || kind === 'ocean')) {
				const c = state.colors;
				// Rivers and lakes use the zone light's river colours, the sea its ocean ones; either stands in for the other.
				const [first, second] = kind === 'ocean' ? [c.oceanFar, c.riverFar] : [c.riverFar, c.oceanFar];
				const far = first.getHex() ? first : second.getHex() ? second : null;
				if (far) color.copy(far);
			}
			const depth = Math.max(0, surface - this.camera.position.y);
			// The liquid's own darkening where it has one; otherwise a gentle one over the first 60 yards.
			const reach = liquid?.darkenDepth ? Math.min(1, depth / liquid.darkenDepth) : Math.min(1, depth / 60);
			const fogDarken = liquid?.darkenDepth ? liquid.fogDarken : 0.55;
			color.multiplyScalar(1 - reach * fogDarken);
			// Light too (only when just set from the zone's light, so it doesn't compound).
			if (state) {
				const ambient = 1 - reach * (liquid?.darkenDepth ? liquid.ambientDarken : 0.4);
				this.ambient.color.multiplyScalar(ambient);
				this.ambient.groundColor.multiplyScalar(ambient);
				this.sun.color.multiplyScalar(1 - reach * (liquid?.darkenDepth ? liquid.sunDarken : 0.5));
			}
			this.fog.color.copy(color);
			(this.scene.background as THREE.Color).copy(color);
			// Starting the fade in front of the camera tints even what's close, as in the game.
			this.fog.near = -look.far * 0.3;
			this.fog.far = look.far;
		}
		// Unlit: an even white ambient light of the intensity that gives each surface its texture's
		// own colour, and no sun (so no shadows or highlights either). Only colours change, never
		// which lights there are, so no shader is built again (see setTorch).
		if (this.unlit) {
			this.sun.color.setRGB(0, 0, 0);
			this.ambient.color.setRGB(1, 1, 1);
			this.ambient.groundColor.setRGB(1, 1, 1);
		}
		// The fog pushed out past where anything is drawn (near and far apart, as smoothstep needs).
		if (this.clearView) {
			this.fog.near = CLEAR_VIEW_FAR * 2;
			this.fog.far = CLEAR_VIEW_FAR * 3;
		}
		// Past the fog's end everything is the fog's colour: don't draw it at all.
		const far = this.clearView ? CLEAR_VIEW_FAR : Math.max(this.fog.far * FAR_PAST_FOG, MIN_FAR);
		if (Math.abs(far - this.camera.far) > this.camera.far * 0.01) {
			this.camera.far = far;
			this.camera.updateProjectionMatrix();
		}
	}

	/**
	 * The surface of the liquid a point is under (the lowest above it, of a lake, river, canal or
	 * pool; or the open sea's), for the walking character. Unlike liquidAt it keeps no state.
	 */
	private liquidOver(p: THREE.Vector3): { surface: number; sea: boolean } | null {
		const meshes = this.liquidMeshes;
		meshes.length = 0;
		meshes.push(...this.terrain.liquidsAt(p.x, p.z));
		this.objects.liquidMeshes(meshes);
		if (meshes.length) {
			// Surfaces are only hit on the side they're drawn from, which flips while the camera is
			// under water (see liquidAt): then up from the point to the nearest above it, else down
			// from high up to the lowest one over it.
			const below = this.underwater !== null;
			if (below) this.liquidRay.set(p, new THREE.Vector3(0, 1, 0));
			else this.liquidRay.set(new THREE.Vector3(p.x, p.y + LIQUID_PROBE, p.z), new THREE.Vector3(0, -1, 0));
			this.liquidRay.far = LIQUID_PROBE;
			let surface = -Infinity;
			for (const hit of this.liquidRay.intersectObjects(meshes, false)) {
				if (!liquidKindOf((hit.object as THREE.Mesh).material)) continue;
				surface = hit.point.y;
				if (below) break;
			}
			if (surface > -Infinity) return { surface, sea: false };
		}
		const here = this.terrain.locate(p.x, p.z);
		if (!here?.continent.apart && !here?.continent.building && p.y < 0 && this.terrain.surfaceAt(p.x, p.z) < p.y && this.terrain.isSea(p.x, p.z)) {
			return { surface: 0, sea: true };
		}
		return null;
	}

	/**
	 * The liquid the camera is in: the surface
 of a lake, river, canal or pool somewhere above it,
	 * or the open sea below sea level (where the ground is lower still).
	 */
	private liquidAt(p: THREE.Vector3): { kind: LiquidKind; type: number; surface: number } | null {
		const meshes = this.liquidMeshes;
		meshes.length = 0;
		meshes.push(...this.terrain.liquidsAt(p.x, p.z));
		this.objects.liquidMeshes(meshes);
		if (meshes.length) {
			// Surfaces only hit on the side they're drawn from: from above out of the water (down
			// from high up, the lowest surface over the camera), from below in it (straight up).
			const below = this.underwater !== null;
			if (below) this.liquidRay.set(p, new THREE.Vector3(0, 1, 0));
			else this.liquidRay.set(new THREE.Vector3(p.x, p.y + LIQUID_PROBE, p.z), new THREE.Vector3(0, -1, 0));
			this.liquidRay.far = LIQUID_PROBE;
			const hits = this.liquidRay.intersectObjects(meshes, false);
			const hit = below ? hits[0] : hits[hits.length - 1];
			if (hit) {
				const kind = liquidKindOf((hit.object as THREE.Mesh).material);
				if (kind) return { kind, type: (hit.object.userData.liquidType as number | undefined) ?? 0, surface: hit.point.y };
			}
		}
		const here = this.terrain.locate(p.x, p.z);
		// Not in a map laid out apart (no sea there) or over a building-only one (the sea opens up).
		if (!here?.continent.apart && !here?.continent.building && p.y < 0 && this.terrain.surfaceAt(p.x, p.z) < p.y && this.terrain.isSea(p.x, p.z)) {
			return { kind: 'ocean', type: this.liquidLooks?.ocean ?? 0, surface: 0 };
		}
		return null;
	}

	/** The underwater ambience for where the camera is (nearly everywhere the same). */
	private underwaterSounds() {
		const data = this.music?.data;
		if (!data) return null;
		const area = this.areaHere();
		return data.ambiences[(area && data.underwater[area]) || data.underwaterDefault] ?? null;
	}

	/**
	 * The indoor room around the camera (inns, Ironforge, Undercity), from WMOAreaTable. Rows are
	 * fetched from the worker on first entry; until then the previous answer stands.
	 */
	private updateRoom(): void {
		const at = this.objects.roomAt(this.camera.position);
		if (!at) {
			this.room = null;
			return;
		}
		const key = `${at.wmoId}:${at.nameSet}:${at.groupId}`;
		const known = this.rooms.get(key);
		if (known === 'pending') return;
		if (known !== undefined) {
			this.room = known;
			return;
		}
		this.rooms.set(key, 'pending');
		this.storage.wmoArea(at.wmoId, at.nameSet, at.groupId).then(
			(row) => this.rooms.set(key, row),
			() => this.rooms.set(key, null),
		);
	}

	/** The AreaTable ID for the camera: the room's area indoors, else the terrain's. */
	private areaHere(): number | null {
		const pos = this.camera.position;
		return this.room?.area || this.terrain.areaAt(pos.x, pos.z);
	}

	/** The music for where the camera is: the room's, else the area's or its parent zone's. */
	private musicHere(): MusicTarget {
		this.updateRoom();
		const music = this.music!.data;
		let id = this.areaHere();
		const intro = this.room?.intro || (id ? music.areas[id]?.intro ?? 0 : 0);
		let set = this.room?.music ?? 0;
		for (let i = 0; i < 8 && !set && id; i++) {
			set = music.areas[id]?.music ?? 0;
			id = this.areas.get(id)?.parent ?? 0;
		}
		return { set, intro };
	}

	/** The background loops for where the camera is: the room's, else the area's or its parent zone's. */
	private backgroundHere(): BackgroundSounds | null {
		const music = this.music!.data;
		const room = this.room?.ambience ? music.backgrounds[this.room.ambience] : undefined;
		if (room) return room;
		let id = this.areaHere();
		for (let i = 0; i < 8 && id; i++) {
			const sounds = music.backgrounds[music.areaAmbience[id] ?? 0];
			if (sounds) return sounds;
			id = this.areas.get(id)?.parent ?? 0;
		}
		return null;
	}

	/** Zone and subzone names for the AreaTable ID under the camera; indoors, the room's name. */
	private zoneNames(): { zone: string | null; subzone: string | null } {
		const id = this.areaHere();
		let area = id ? this.areas.get(id) : undefined;
		if (!area) return { zone: null, subzone: null };
		const subzone = this.room?.name ?? area.name;
		for (let i = 0; i < 8 && area.parent && this.areas.has(area.parent); i++) area = this.areas.get(area.parent)!;
		return { zone: area.name, subzone: subzone !== area.name ? subzone : null };
	}

	private hudInfo(): HudInfo {
		const pos = this.camera.position;
		const at = this.terrain.locate(pos.x, pos.z);
		const stats = this.terrain.stats();
		const [texLoaded, texTotal] = this.terrain.farTextureProgress;
		let location = 'Open sea';
		let coordinates = '–';
		if (at) {
			// Local tile coordinates -> WoW world coordinates (x north, y west).
			const lx = pos.x / TILE_SIZE - at.continent.offsetX;
			const ly = pos.z / TILE_SIZE - at.continent.offsetY;
			const wowX = MAP_ORIGIN - ly * TILE_SIZE;
			const wowY = MAP_ORIGIN - lx * TILE_SIZE;
			location = `${at.continent.name} · tile ${at.tileX}_${at.tileY}`;

			coordinates = `${wowX.toFixed(0)}, ${wowY.toFixed(0)}, ${pos.y.toFixed(0)}`;
		}
		return {
			location,
			coordinates,
			altitude: this.controls.altitude,
			height: pos.y,
			speed: this.controls.speed,
			fps: this.fps,
			near: `${stats.nearTiles} detailed${stats.nearLoading ? `, ${stats.nearLoading} loading` : ''} · ${stats.layerTextures} layer textures`,
			objects: (() => { const o = this.objects.stats(); return `${o.drawn.toLocaleString()} of ${o.instances.toLocaleString()} drawn · ${o.models} models${o.loading ? `, ${o.loading} loading` : ''}`; })(),
			textures: texLoaded < texTotal ? `${texLoaded} / ${texTotal}` : `${texTotal}`,
			time: (() => { const t = this.timeOfDay(); return `${String(Math.floor(t / 120)).padStart(2, '0')}:${String(Math.floor(t / 2) % 60).padStart(2, '0')}`; })(),
			...this.zoneNames(),
			side: this.side === 'alliance' ? 'Alliance' : 'Horde',
			music: this.music?.status ?? 'unavailable',
			highlights: [this.highlights?.status, this.regionOverlay?.status, this.restedAreas?.status].filter(Boolean).join('\n'),
			weather: this.weather.status,
			flight: this.flight ? `To ${this.flight.to}, ${formatDuration(this.flight.remaining())} left (Esc or move to get off)` : '',
			voyage: this.voyage ? `${this.voyage.name}: ${this.transportStatus(this.voyage.entry)} (Esc or move to get off)` : '',
			collision: this.controls.ghost ? 'Off: through walls' : 'On',
		};
	}
}

/**
 * Rows of maps south of the continents (world, in yards), each map with MAP_GAP tiles of sea
 * around it: dungeons first, then raids, battlegrounds and the rest, tallest first in each
 * group so rows fill evenly. Returns where each map's tile (0, 0) goes.
 */
function layoutMaps(maps: { map: InstanceMap; category: MapCategory }[], world: THREE.Box2): { map: InstanceMap; category: MapCategory; offsetX: number; offsetY: number }[] {
	const footprints = maps.map(({ map, category }) => {
		const tiles = [...map.farTiles.map((t): [number, number] => [t.x, t.y]), ...map.terrainTiles, ...map.wmoTiles];
		if (!tiles.length) return null;
		const xs = tiles.map((t) => t[0]);
		const ys = tiles.map((t) => t[1]);
		const minX = Math.min(...xs);
		const minY = Math.min(...ys);
		return { map, category, minX, minY, width: Math.max(...xs) - minX + 1, height: Math.max(...ys) - minY + 1 };
	}).filter((f) => f !== null);
	footprints.sort((a, b) => MAP_ORDER.indexOf(a.category) - MAP_ORDER.indexOf(b.category) || b.height - a.height || a.map.name.localeCompare(b.map.name));

	const left = Math.floor(world.min.x / TILE_SIZE) + MAP_GAP;
	const right = Math.ceil(world.max.x / TILE_SIZE) - MAP_GAP;
	let x = left;
	let y = Math.ceil(world.max.y / TILE_SIZE) + MAP_GAP;
	let rowHeight = 0;
	return footprints.map((f) => {
		if (x > left && x + f.width > right) {
			x = left;
			y += rowHeight + MAP_GAP;
			rowHeight = 0;
		}
		const placed = { map: f.map, category: f.category, offsetX: x - f.minX, offsetY: y - f.minY };
		x += f.width + MAP_GAP;
		rowHeight = Math.max(rowHeight, f.height);
		return placed;
	});
}

/** Places Kalimdor west of the Eastern Kingdoms, vertically centred, with open sea between. */
function layoutContinents(loaded: { map: (typeof KNOWN_MAPS)[number]; tiles: FarTile[] }[]): ContinentPlacement[] {
	const extent = (tiles: FarTile[]) => {
		const land = tiles.filter((t) => t.hasAdt);
		const xs = land.map((t) => t.x);
		const ys = land.map((t) => t.y);
		return { minX: Math.min(...xs), maxX: Math.max(...xs), midY: (Math.min(...ys) + Math.max(...ys)) / 2 };
	};
	const placements: ContinentPlacement[] = [];
	let anchor: ReturnType<typeof extent> | null = null;
	for (const { map, tiles } of loaded) {
		const e = extent(tiles);
		if (!anchor) {
			placements.push({ name: map.name, mapId: map.mapId, wdt: map.wdt, offsetX: 0, offsetY: 0 });
			anchor = e;
			continue;
		}
		// WDL tiles extend past the land; keep the whole WDL grid clear of the previous continent.
		const wdlMaxX = Math.max(...tiles.map((t) => t.x));
		const anchorWdlMin = Math.min(...loaded[0].tiles.map((t) => t.x));
		const offsetX = Math.min(anchor.minX - CONTINENT_GAP - e.maxX - 1, anchorWdlMin - wdlMaxX - 1);
		placements.push({ name: map.name, mapId: map.mapId, wdt: map.wdt, offsetX, offsetY: Math.round(anchor.midY - e.midY) });
	}
	return placements;
}

/** Seconds as m:ss. */
function formatDuration(seconds: number): string {
	const s = Math.round(seconds);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
