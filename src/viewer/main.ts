import { droppedFolderToSource, filesToSource, hasDirectoryPicker, pickDirectory } from '../app/folderPicker';
import { createStorageClient } from '../worker/client';
import type { SourceInit } from '../worker/protocol';
import type { ProductInfo } from '../casc/config';
import type { Place } from '../explorer/places';
import type { SpawnInfo } from '../explorer/spawns';
import type { MapCategory, MapListing } from '../explorer/world';
import type { HighlightGroup, HighlightSettings } from './highlights';
import { CLUTTER_RANGE_DEFAULT, CLUTTER_RANGE_MAX, CLUTTER_RANGE_MIN } from './clutter';
import { Minimap } from './minimap';
import { perf } from './perf';
import { DETAIL_RANGE_MAX, DETAIL_RANGE_MIN } from './objects';
import { MOUSE_SPEED_MAX, MOUSE_SPEED_MIN } from './look';
import type { TintMode } from './regionOverlay';
import { isTyping } from './typing';
import { loadUiAssets } from './uiAssets';
import { FIXED_SPEED_DEFAULT, FIXED_SPEED_MAX, FIXED_SPEED_MIN, FLY_SPEED_RANGE, FLY_SPEED_STEP, Viewer, parseResolution, RESOLUTION_MIN, type HudInfo, type MeetingStone, type ViewSettings, type WalkingSpot } from './viewer';
import type { CharacterLook } from './character';
import { FormPicker } from './formPicker';
import { DEFAULT_EMOTE_KEYS, EMOTES, type Emote } from './emotes';
import { CHARACTER_OUTFITS, type CharacterOutfit, type CharacterRace } from '../explorer/spawns';

import { setVolume, volumeSetting, type VolumeChannel } from './volume';
import { WorldMap } from './worldMap';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status');

const storage = createStorageClient((message) => showProgress(message), () => ($('game-updated').hidden = false));
$('game-updated-reload').addEventListener('click', () => location.reload());

/** A message under the buttons; errors also end the loading bar, so the buttons come back. */
function setStatus(text: string, isError = false): void {
	status.textContent = text;
	status.className = isError ? 'bad' : 'muted';
	if (isError) hideProgress();
}

// --- Loading bar ---

/**
 * How far along each loading step starts, as a share of the whole. Reading the folder is the
 * longest step (the browser listing every file), but it reports nothing, so the bar creeps
 * toward where it ends meanwhile.
 */
const LOADING_STEPS: [RegExp, number, string][] = [
	[/^Reading your folder/, 0.02, 'Reading your World of Warcraft folder'],
	[/^Reading \.build\.info/, 0.45, 'Finding the game version'],
	[/^Reading local indexes/, 0.5, 'Opening the game files'],
	[/^Reading encoding table/, 0.57, 'Opening the game files'],
	[/^Reading root table/, 0.64, 'Opening the game files'],
	[/^Reading Eastern Kingdoms/, 0.72, 'Loading Eastern Kingdoms'],
	[/^Reading Kalimdor/, 0.82, 'Loading Kalimdor'],
	[/^Placing/, 0.88, 'Placing dungeons and other maps'],
	[/^Reading lighting/, 0.9, 'Loading light and zones'],
	[/^Starting/, 0.97, 'Starting'],
];
/** Where the bar creeps to while the folder is read, and how long that takes (s). */
const FOLDER_CREEP = [0.42, 20] as const;

/** Shows the loading bar at a step, in place of the folder buttons. */
function showProgress(message: string): void {
	perf.log('load', message);
	const step = LOADING_STEPS.find(([pattern]) => pattern.test(message));
	const appearing = $('loading').hidden;
	$('drop').hidden = true;
	$('loading').hidden = false;
	// A bar that was hidden has no width to animate from until it's laid out once.
	if (appearing) void $('loading-fill').offsetWidth;
	status.textContent = '';
	if (!step) return;
	const fill = $('loading-fill');
	const creep = step === LOADING_STEPS[0];
	const target = creep ? FOLDER_CREEP[0] : step[1];
	fill.style.transition = creep ? `width ${FOLDER_CREEP[1]}s cubic-bezier(0.1, 0.7, 0.3, 1)` : '';
	// Never backwards, whatever order messages arrive in.
	if (parseFloat(fill.style.width || '0') < target * 100) fill.style.width = `${target * 100}%`;
	$('loading-text').textContent = `${step[2]}…`;
}

function hideProgress(): void {
	$('loading').hidden = true;
	$('drop').hidden = false;
	$('loading-fill').style.width = '0%';
}

const PRODUCT_KEY = 'mapExplorer.product';
/** Every game version in the folder, for the Game version menu. */
let installed: ProductInfo[] = [];
/** Set once a game version has been opened: the viewer starts once per page, so another one takes a reload. */
let exploring = false;

/** What each game version is called, by its product code; others go by their code. */
const PRODUCT_NAMES: Record<string, string> = {
	wow_classic_beta: 'Forever',
	wow_classic_era: 'Classic',
	wow: 'Retail',
	wow_classic: 'MoP Classic',
	wow_anniversary: 'Classic Anniversary',
	wowt: 'Retail PTR',
	wowxptr: 'Retail PTR (next patch)',
	wow_beta: 'Retail Beta',
	wow_classic_ptr: 'MoP Classic PTR',
	wow_classic_era_ptr: 'Classic Era PTR',
};
/** The Game version menu lists these first, in this order (and so they get Ctrl+1, 2, 3); the rest after. */
const PRODUCT_ORDER = ['wow_classic_beta', 'wow_classic_era', 'wow'];

function productName(product: string): string {
	return PRODUCT_NAMES[product] ?? product;
}

/** Ctrl and the number for the nth version in the menu: 1 to 9, then 0; none past the tenth. */
function versionKey(index: number): string {
	return index < 10 ? String((index + 1) % 10) : '';
}

/** The game version chosen in the Game version menu on an earlier visit, if any. */
function savedProduct(): string | null {
	try {
		return localStorage.getItem(PRODUCT_KEY);
	} catch {
		// Storage blocked: the automatic choice.
		return null;
	}
}

/**
 * What a switch to another game version carries over the reload, besides the camera (the URL
 * hash): the character on foot where it stood, and a time of day moved from the local time.
 */
const SWITCH_KEY = 'mapExplorer.switch';
interface SwitchState {
	walking: WalkingSpot | null;
	time: number | null;
}

/** Remembers a game version and reloads the page into it, where it was. */
function switchProduct(product: string): void {
	try {
		localStorage.setItem(PRODUCT_KEY, product);
		if (infoViewer) {
			const state: SwitchState = { walking: infoViewer.walkingSpot(), time: infoViewer.timeIsLocal ? null : infoViewer.timeMinutes };
			sessionStorage.setItem(SWITCH_KEY, JSON.stringify(state));
		}
	} catch {
		// Not remembered: the reload comes back to the version it was, or starts afresh.
	}
	location.reload();
}

/** Puts back what switchProduct carried over, once; walking where it can, else flying as the hash left it. */
async function restoreSwitch(viewer: Viewer): Promise<void> {
	let state: Partial<SwitchState> = {};
	try {
		state = JSON.parse(sessionStorage.getItem(SWITCH_KEY) ?? '{}') ?? {};
		sessionStorage.removeItem(SWITCH_KEY);
	} catch {
		// Storage blocked or unreadable: nothing carried over.
	}
	if (typeof state.time === 'number' && Number.isFinite(state.time)) viewer.timeMinutes = state.time;
	if (state.walking) {
		const problem = await viewer.walkAt(state.walking);
		if (problem) notify(problem);
	}
}

async function useSource(init: SourceInit): Promise<void> {
	showProgress('Reading .build.info');
	try {
		const products = (await storage.setSource(init)).filter((p) => p.product.startsWith('wow'));
		// Once each: a version can be listed with several builds, and opening it picks the one that can be read.
		installed = products.filter((p, i) => products.findIndex((q) => q.product === p.product) === i);
		const rank = (product: string) => (PRODUCT_ORDER.includes(product) ? PRODUCT_ORDER.indexOf(product) : PRODUCT_ORDER.length);
		installed.sort((a, b) => rank(a.product) - rank(b.product));
		const select = $<HTMLSelectElement>('product');
		select.replaceChildren(...products.map((p) => new Option(`${productName(p.product)} ${p.version}`, p.product)));
		const saved = savedProduct();
		// The version chosen before, if it's still installed. Otherwise prefer a classic build: the continent file IDs are the classic ones.
		const preferred = products.find((p) => p.product === saved) ?? products.find((p) => p.product === 'wow_classic_beta') ?? products.find((p) => p.product.startsWith('wow_classic'));
		if (preferred) {
			// Nothing to choose: straight in.
			select.value = preferred.product;
			await explore();
			return;
		}
		hideProgress();
		$('product-step').hidden = products.length === 0;
		setStatus(products.length ? 'No Classic version found; choose a game version and press Explore.' : 'No World of Warcraft game found in this folder.', true);
	} catch (e) {
		console.error('Reading the game folder failed', e);
		setStatus(folderProblem(init, e), true);
	}
}

/** What to tell the user when a folder couldn't be read, with the reason. */
function folderProblem(init: SourceInit, error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	if (init.kind === 'http') return `World of Warcraft was found but couldn't be read (${reason}). Choose its folder instead.`;
	if (init.kind === 'handle') return `That folder couldn't be read (${reason}). Choose the folder that contains _classic_ or _classic_beta_ (not that folder itself).`;
	const hasBuildInfo = init.files.some(({ path }) => path === '.build.info');
	const dataFiles = init.files.filter(({ path }) => /^data\/data\//i.test(path)).length;
	const counts = `Got ${init.files.length} files: ${hasBuildInfo ? '.build.info found' : '.build.info missing'}, ${dataFiles} in Data/data.`;
	if (!hasBuildInfo && dataFiles) {
		// The browser's folder dialog leaves out hidden files (.build.info) on macOS and Linux.
		return `${counts} The browser's folder dialog left out .build.info, a hidden file. Drag the folder onto this page instead, or use "Open with direct access" under Help (Chrome or Edge).`;
	}
	return `${counts} That doesn't look like the World of Warcraft folder: choose the one that contains _classic_ or _classic_beta_ (not that folder itself). Reason: ${reason}`;
}

/**
 * The portable launcher (and the dev server) look for World of Warcraft on this computer and
 * serve it under /__wow/; when they found it, there's nothing to choose. A plain web server
 * has no such path, and then the folder is chosen by hand.
 */
async function findWow(): Promise<void> {
	const base = new URL('__wow/', location.href).href;
	let found = false;
	try {
		const response = await fetch(`${base}.build.info`, { method: 'HEAD' });
		// Some servers answer every path with the page itself.
		found = response.ok && !response.headers.get('Content-Type')?.includes('text/html');
	} catch {
		// Not served from here.
	}
	$('start').classList.remove('finding');
	if (found) await useSource({ kind: 'http', base });
}
void findWow();

// Dropping the folder on the page works like choosing it.
const drop = $('drop');
const start = $('start');
start.addEventListener('dragover', (e) => {
	e.preventDefault();
	drop.classList.add('dragging');
});
start.addEventListener('dragleave', (e) => {
	if (e.target === start) drop.classList.remove('dragging');
});
start.addEventListener('drop', async (e) => {
	e.preventDefault();
	drop.classList.remove('dragging');
	const entry = e.dataTransfer?.items[0]?.webkitGetAsEntry();
	if (!entry?.isDirectory) {
		setStatus('Drop the World of Warcraft folder itself, not a file.', true);
		return;
	}
	showProgress('Reading your folder');
	await useSource(await droppedFolderToSource(entry as FileSystemDirectoryEntry));
});

// After "Upload", the browser lists the whole folder before telling the page anything; show
// the bar as soon as the dialog closes (the page gets focus back), and drop it if it was cancelled.
let choosingFolder = false;
$('pick').addEventListener('click', () => {
	choosingFolder = true;
	$<HTMLInputElement>('pick-input').click();
});
window.addEventListener('focus', () => {
	if (choosingFolder) showProgress('Reading your folder');
});
$('pick-input').addEventListener('cancel', () => {
	choosingFolder = false;
	hideProgress();
});
$<HTMLInputElement>('pick-input').addEventListener('change', async (event) => {
	choosingFolder = false;
	const input = event.target as HTMLInputElement;
	const source = await filesToSource(input.files ?? []);
	// Emptied once read: the browser keeps a filled file input in the page's saved state, and
	// re-sends that (every file in the install, tens of MB) after each key press, a stall each time.
	input.value = '';
	showProgress('Reading your folder');
	await useSource(source);
});

if (!hasDirectoryPicker) $('pick-direct').hidden = true;
$('pick-direct').addEventListener('click', async () => {
	try {
		const init = await pickDirectory();
		if (init) await useSource(init);
	} catch (e) {
		setStatus((e as Error).message, true);
	}
});

$('explore').addEventListener('click', () => {
	// After a version that couldn't start, another one starts from a fresh page.
	if (exploring) switchProduct($<HTMLSelectElement>('product').value);
	else void explore();
});

/**
 * The Game version menu: every version in the folder, the open one marked; choosing another
 * reloads into it. Ctrl and a number choose one too, in the menu's order.
 */
function setUpVersions(): void {
	const current = $<HTMLSelectElement>('product').value;
	$('version').hidden = installed.length < 2;
	$('version-list').replaceChildren(...installed.map((p, i) => {
		const button = document.createElement('button');
		const name = document.createElement('span');
		name.className = 'version-name';
		name.textContent = productName(p.product);
		const version = document.createElement('small');
		version.textContent = p.version;
		name.append(version);
		button.append(name);
		const key = versionKey(i);
		if (key) {
			const kbd = document.createElement('kbd');
			kbd.textContent = `Ctrl+${key}`;
			button.append(kbd);
			button.setAttribute('aria-keyshortcuts', `Control+${key}`);
		}
		if (p.product === current) {
			button.className = 'primary';
			button.setAttribute('aria-current', 'true');
			button.title = `${p.product}: the version open now`;
		} else {
			button.title = p.product;
			button.addEventListener('click', () => switchProduct(p.product));
		}
		return button;
	}));
	if (installed.length < 2) return;
	window.addEventListener('keydown', (e) => {
		if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || isTyping(e)) return;
		const digit = /^Digit(\d)$/.exec(e.code)?.[1];
		if (digit === undefined) return;
		const chosen = installed[(Number(digit) + 9) % 10];
		if (!chosen) return;
		// Not the browser's own Ctrl+number, which goes to another tab.
		e.preventDefault();
		if (chosen.product !== current) switchProduct(chosen.product);
	});
}

/** Opens the chosen game version and starts the viewer. */
async function explore(): Promise<void> {
	exploring = true;
	const button = $<HTMLButtonElement>('explore');
	button.disabled = true;
	for (const id of ['pick', 'pick-direct']) $<HTMLButtonElement>(id).disabled = true;
	try {
		await storage.open($<HTMLSelectElement>('product').value);
		const ui = loadUiAssets(storage);
		const viewer = new Viewer($('view'), storage, showHud, showInfo, $('nameplates'));
		infoViewer = viewer;
		// For poking at the scene from the console (and test scripts) while developing.
		if (import.meta.env.DEV) (globalThis as unknown as { mapExplorerViewer: Viewer }).mapExplorerViewer = viewer;
		viewer.onShotStatus = showShotStatus;
		// Shadows and the torch are part of what three builds each shader for, and load() builds
		// those the world will need; set only afterwards, every one was built again while flying.
		const { stats: _, ...saved } = readSaved<SavedView>(VIEW_KEY);
		viewer.settings = saved;
		await viewer.load((text) => showProgress(text));
		const { minimapArrow } = await ui;
		showProgress('Starting');
		$('start').hidden = true;
		$('menu').hidden = $('top-left').hidden = $('side').hidden = false;
		setUpView(viewer);
		viewer.start();
		perf.log('load', 'world shown');
		console.info('[MapExplorer] Freezes of 100 ms or more are written here as they happen. F9 saves the full debug log to a file; mapExplorerPerf.verbose = true writes every log line here too.');
		setUpMinimap(viewer, minimapArrow);
		void setUpGoTo(viewer);
		setUpHighlights(viewer);
		setUpVersions();
		setUpTravel(viewer, minimapArrow);
		setUpWalking(viewer);
		setUpEmotes(viewer);
		setUpSound(viewer);
		setUpHelp();
		void restoreSwitch(viewer);
	} catch (e) {
		perf.log('error', `could not start: ${(e as Error).message}`);
		setStatus(`Could not start: ${(e as Error).message}`, true);
		button.disabled = false;
		for (const id of ['pick', 'pick-direct']) $<HTMLButtonElement>(id).disabled = false;
		// A way out of a version that doesn't start, which would otherwise be opened again every time.
		if (installed.length > 1) $('product-step').hidden = false;
		try {
			localStorage.removeItem(PRODUCT_KEY);
		} catch {
			// Storage blocked: nothing was remembered either.
		}
	}
}

// --- Remembered settings ---

function readSaved<T>(key: string): Partial<T> {
	try {
		return JSON.parse(localStorage.getItem(key) ?? '{}') ?? {};
	} catch {
		// Storage blocked or unreadable: the defaults.
		return {};
	}
}

function save(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Not remembered; it still applies for this visit.
	}
}

// --- Notices: what a key just changed ---

let noticeTimer = 0;

/** A line low in the middle saying what just changed; it fades after a moment. Shown even with the interface hidden. */
function notify(text: string): void {
	const el = $('notice');
	el.textContent = text;
	el.classList.add('show');
	clearTimeout(noticeTimer);
	noticeTimer = window.setTimeout(() => el.classList.remove('show'), 1800);
}

const onOff = (on: boolean) => (on ? 'on' : 'off');

/** Minutes after midnight as HH:MM. */
function clock(minutes: number): string {
	const m = Math.floor(minutes) % 1440;
	return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** A speed multiplier as ×1, ×2.4, ×0.59 and so on. */
function speedLabel(scale: number): string {
	return `×${Number(scale.toPrecision(2))}`;
}

/** A fixed flying speed as 64 yd/s, 1100 yd/s and so on. */
function fixedSpeedLabel(speed: number): string {
	return `${Number(speed.toPrecision(2))} yd/s`;
}

// --- Keys belong to the world ---

// Text boxes and lists keep keys while in use; everything else hands them back once used, and
// clicking the world or pressing Esc always does.
document.addEventListener('change', (e) => {
	if (!isTyping(e) || e.target instanceof HTMLSelectElement) (e.target as HTMLElement).blur();
});
document.addEventListener('click', (e) => {
	// Space flies up; it mustn't fold a panel or press a button again.
	(e.target as Element).closest<HTMLElement>('summary, button')?.blur();
});
$('view').addEventListener('pointerdown', () => {
	(document.activeElement as HTMLElement | null)?.blur();
	closeMenu();
});
document.addEventListener('keydown', (e) => {
	if (e.code === 'Escape' && isTyping(e)) (e.target as HTMLElement).blur();
	else if (e.code === 'Escape') closeMenu();
});

/** Folds away whichever menu along the top is open. */
function closeMenu(): void {
	for (const menu of document.querySelectorAll<HTMLDetailsElement>('#menu details[open]')) menu.open = false;
}

// --- The View, Graphics and Camera menus and the HUD ---

const VIEW_KEY = 'mapExplorer.view';
type SavedView = Partial<ViewSettings> & { stats: boolean };

/** Called with each HUD update, for the parts of the page that follow the viewer. */
const hudFollowers: (() => void)[] = [];

/** The View, Graphics and Camera menus: every setting the keys toggle, the time of day and the HUD's stats; remembered between visits. */
function setUpView(viewer: Viewer): void {
	const menu = $('menu');
	const { stats = false, ...settings } = readSaved<SavedView>(VIEW_KEY);
	viewer.settings = settings;
	const statsBox = $<HTMLInputElement>('stats-on');
	const controls = [...menu.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]')];
	const remember = () => save(VIEW_KEY, { ...viewer.settings, stats: statsBox.checked });
	const sync = () => {
		const s = viewer.settings;
		for (const c of controls) {
			const value = s[c.dataset.setting as keyof ViewSettings];
			if (c instanceof HTMLInputElement) c.checked = value as boolean;
			else c.value = String(value);
		}
	};
	const setStats = (on: boolean) => {
		statsBox.checked = on;
		$('hud-stats').hidden = !on;
	};
	setStats(stats);
	sync();
	for (const c of controls) {
		c.addEventListener('change', () => {
			viewer.settings = { [c.dataset.setting!]: c instanceof HTMLInputElement ? c.checked : c.value };
			remember();
		});
	}
	statsBox.addEventListener('change', () => {
		setStats(statsBox.checked);
		remember();
	});
	window.addEventListener('keydown', (e) => {
		if (e.code !== 'KeyK' || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
		setStats(!statsBox.checked);
		remember();
		notify(`Performance stats ${onOff(statsBox.checked)}`);
	});

	// The time of day: the slider follows the clock unless it's being dragged.
	const time = $<HTMLInputElement>('time');
	const timeOut = $('time-out');
	const now = $<HTMLButtonElement>('time-now');
	let dragging = false;
	const syncTime = () => {
		const minutes = viewer.timeMinutes;
		if (!dragging) time.value = String(Math.round(minutes / 15) * 15);
		timeOut.textContent = clock(minutes);
		timeOut.classList.toggle('shifted', !viewer.timeIsLocal);
		timeOut.title = viewer.timeIsLocal ? 'Your local time' : 'Moved from your local time';
		now.disabled = viewer.timeIsLocal;
	};
	time.addEventListener('pointerdown', () => (dragging = true));
	window.addEventListener('pointerup', () => (dragging = false));
	time.addEventListener('input', () => {
		viewer.timeMinutes = Number(time.value);
		syncTime();
	});
	now.addEventListener('click', () => {
		viewer.resetTime();
		syncTime();
	});
	syncTime();
	hudFollowers.push(syncTime);

	// The flying speed: a slider in powers of two, either side of normal with smart speed, or of
	// yd/s without it.
	const speed = $<HTMLInputElement>('fly-speed');
	const speedOut = $('fly-speed-out');
	const speedReset = $<HTMLButtonElement>('fly-speed-reset');
	speed.step = String(FLY_SPEED_STEP);
	const syncSpeed = () => {
		const s = viewer.settings;
		const value = s.smartSpeed ? s.flySpeed : s.fixedSpeed;
		const normal = s.smartSpeed ? 1 : FIXED_SPEED_DEFAULT;
		speed.min = String(s.smartSpeed ? -FLY_SPEED_RANGE : FIXED_SPEED_MIN);
		speed.max = String(s.smartSpeed ? FLY_SPEED_RANGE : FIXED_SPEED_MAX);
		speed.value = String(Math.log2(value));
		speed.title = `${s.smartSpeed ? 'Multiplies the speed, which follows your height' : 'Always this speed'} · Faster: Y · Slower: Shift+Y`;
		speedOut.textContent = s.smartSpeed ? speedLabel(value) : fixedSpeedLabel(value);
		speedOut.classList.toggle('shifted', value !== normal);
		speedReset.disabled = value === normal;
	};
	speed.addEventListener('input', () => {
		const value = 2 ** Number(speed.value);
		viewer.settings = viewer.settings.smartSpeed ? { flySpeed: value } : { fixedSpeed: value };
		syncSpeed();
		remember();
	});
	speedReset.addEventListener('click', () => {
		viewer.settings = viewer.settings.smartSpeed ? { flySpeed: 1 } : { fixedSpeed: FIXED_SPEED_DEFAULT };
		syncSpeed();
		remember();
	});
	menu.querySelector('[data-setting="smartSpeed"]')!.addEventListener('change', syncSpeed);
	syncSpeed();

	// How far the grass reaches, in yards, and how far the doodads, NPCs and objects show, as a
	// share of the usual distance for their size.
	const syncClutterRange = setUpRangeSlider(viewer, 'clutter-range', {
		min: CLUTTER_RANGE_MIN, max: CLUTTER_RANGE_MAX, step: 25, normal: CLUTTER_RANGE_DEFAULT,
		get: (s) => s.clutterRange,
		set: (value) => ({ clutterRange: value }),
		label: (value) => `${value} yd`,
	}, remember);
	const syncDetailRange = setUpRangeSlider(viewer, 'detail-range', {
		min: DETAIL_RANGE_MIN, max: DETAIL_RANGE_MAX, step: 0.25, normal: 1,
		get: (s) => s.detailRange,
		set: (value) => ({ detailRange: value }),
		label: (value) => `${Math.round(value * 100)}%`,
	}, remember);
	const syncMouseSpeed = setUpRangeSlider(viewer, 'mouse-speed', {
		min: MOUSE_SPEED_MIN, max: MOUSE_SPEED_MAX, step: 0.05, normal: 1,
		get: (s) => s.mouseSpeed,
		set: (value) => ({ mouseSpeed: value }),
		label: (value) => `${Math.round(value * 100)}%`,
	}, remember);

	// The resolution: the window's own, one of the usual sizes, or any width and height.
	const resolution = $<HTMLSelectElement>('resolution');
	const custom = $('resolution-custom');
	const customW = $<HTMLInputElement>('resolution-w');
	const customH = $<HTMLInputElement>('resolution-h');
	const syncResolution = () => {
		const value = viewer.settings.resolution;
		const preset = [...resolution.options].some((o) => o.value === value && value !== 'custom');
		resolution.value = preset ? value : 'custom';
		custom.hidden = preset;
		const [w, h] = parseResolution(value) ?? [window.innerWidth, window.innerHeight];
		customW.value = String(w);
		customH.value = String(h);
	};
	resolution.addEventListener('change', () => {
		if (resolution.value === 'custom') {
			custom.hidden = false;
			customW.focus();
			return;
		}
		viewer.settings = { resolution: resolution.value };
		syncResolution();
		remember();
	});
	const applyCustom = () => {
		const value = `${Math.round(Number(customW.value))}x${Math.round(Number(customH.value))}`;
		if (!parseResolution(value)) {
			notify(`A resolution needs a width and height of at least ${RESOLUTION_MIN} pixels`);
			return;
		}
		viewer.settings = { resolution: value };
		syncResolution();
		remember();
		(document.activeElement as HTMLElement | null)?.blur();
	};
	$('resolution-apply').addEventListener('click', applyCustom);
	for (const input of [customW, customH]) {
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') applyCustom();
		});
	}
	syncResolution();

	viewer.onChange = (change) => {
		const s = viewer.settings;
		sync();
		syncResolution();
		syncTime();
		syncSpeed();
		syncClutterRange();
		syncDetailRange();
		syncMouseSpeed();
		syncSound(viewer);
		remember();
		notify({
			torch: () => `Torch ${onOff(s.torch)}`,
			clutter: () => `Grass and flowers ${onOff(s.clutter)}`,
			clutterRange: () => `Grass and flowers out to ${s.clutterRange} yd`,
			detailRange: () => `Details out to ${Math.round(s.detailRange * 100)}% of the usual distance`,
			mouseSpeed: () => `Mouse speed ${Math.round(s.mouseSpeed * 100)}%`,
			collision: () => (s.collision ? 'Collision on: walls and floors stop you' : 'Collision off: flying through walls'),
			side: () => `Name colours as the ${s.side === 'alliance' ? 'Alliance' : 'Horde'} sees them`,
			mapNames: () => `Dungeon and raid names ${onOff(s.mapNames)}`,
			minimap: () => `Minimap ${onOff(s.minimap)}`,
			cinematic: () => (s.cinematic ? 'Cinematic camera: turning glides after the mouse' : 'Cinematic camera off'),
			grading: () => `Colour grading ${onOff(s.grading)}`,
			shadows: () => `Shadows ${onOff(s.shadows)}`,
			fog: () => `Fog and sun shafts ${onOff(s.fog)}`,
			clearView: () => (s.clearView ? 'No fog: the view reaches every continent' : 'Fog back'),
			unlit: () => (s.unlit ? 'Flat, unlit view: every surface its texture’s own colour' : 'Lighting back'),
			creatures: () => `NPCs and monsters ${onOff(s.creatures)}`,
			gameObjects: () => `Objects ${onOff(s.gameObjects)}`,
			spiritHealers: () => `Spirit healers ${onOff(s.spiritHealers)}`,
			flySpeed: () => `Flying speed ${speedLabel(s.flySpeed)}`,
			smartSpeed: () => (s.smartSpeed ? 'Smart fly speed: faster the higher you are' : `Fixed fly speed: ${fixedSpeedLabel(s.fixedSpeed)}`),
			fixedSpeed: () => `Flying speed ${fixedSpeedLabel(s.fixedSpeed)}`,
			resolution: () => (parseResolution(s.resolution) ? `Viewer size ${s.resolution.replace('x', ' × ')}` : 'Viewer fills the window'),
			weather: () => ({ auto: 'Weather: each zone\'s own', dry: 'Weather: no rain or snow', off: 'Weather: always clear', rain: 'Weather: rain', snow: 'Weather: snow', sandstorm: 'Weather: sandstorm' }[s.weather]),
			flight: () => (viewer.onFlight ? 'Taking flight: Esc or moving gets you off' : 'Landed'),
			voyage: () => (viewer.onTransport ? 'All aboard: Esc or moving gets you off' : 'Got off'),
			walking: () => (viewer.walking ? `Walking: ${walkKey} to fly again` : 'Flying'),
			time: () => (viewer.timeIsLocal ? `Local time, ${clock(viewer.timeMinutes)}` : `Time of day ${clock(viewer.timeMinutes)}`),
			sound: () => `Music and sound ${onOff(viewer.soundOn ?? false)}`,
		}[change]());
	};

	// Clicking the coordinates copies a link that opens this view.
	$('hud-coords').addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(viewer.shareLink());
			notify('Link to this view copied');
		} catch {
			notify('Couldn’t copy: the browser didn’t allow it');
		}
	});
}

/** A slider in the menus for one of the distances, with its value beside it and a Reset button; returns its sync. */
function setUpRangeSlider(viewer: Viewer, id: string, range: {
	min: number; max: number; step: number; normal: number;
	get: (s: ViewSettings) => number;
	set: (value: number) => Partial<ViewSettings>;
	label: (value: number) => string;
}, remember: () => void): () => void {
	const slider = $<HTMLInputElement>(id);
	const out = $(`${id}-out`);
	const reset = $<HTMLButtonElement>(`${id}-reset`);
	slider.min = String(range.min);
	slider.max = String(range.max);
	slider.step = String(range.step);
	const sync = () => {
		const value = range.get(viewer.settings);
		slider.value = String(value);
		out.textContent = range.label(value);
		out.classList.toggle('shifted', value !== range.normal);
		reset.disabled = value === range.normal;
	};
	slider.addEventListener('input', () => {
		viewer.settings = range.set(Number(slider.value));
		sync();
		remember();
	});
	reset.addEventListener('click', () => {
		viewer.settings = range.set(range.normal);
		sync();
		remember();
	});
	sync();
	return sync;
}

function fillList(id: string, rows: [string, string][]): void {
	$(id).replaceChildren(...rows.flatMap(([k, v]) => {
		const dt = document.createElement('dt');
		dt.textContent = k;
		const dd = document.createElement('dd');
		dd.textContent = v;
		return [dt, dd];
	}));
}

// --- The minimap ---

function setUpMinimap(viewer: Viewer, arrow: HTMLCanvasElement | null): void {
	const minimap = new Minimap($('minimap'), storage, () => viewer.minimapView(), (mapId, x, y) => viewer.flyOver(mapId, x, y), arrow);
	$('minimap-in').addEventListener('click', () => minimap.zoomBy(-1));
	$('minimap-out').addEventListener('click', () => minimap.zoomBy(1));
}

// --- Travel: flight paths and the world map ---

/** The Travel menu: flight paths to show and take, and the world map (Tab). */
function setUpTravel(viewer: Viewer, arrow: HTMLCanvasElement | null): void {
	const shown = $<HTMLInputElement>('flights-shown');
	const from = $<HTMLSelectElement>('flight-from');
	const to = $<HTMLSelectElement>('flight-to');
	const speed = $<HTMLSelectElement>('flight-speed');
	const go = $<HTMLButtonElement>('flight-go');
	const stop = $<HTMLButtonElement>('flight-stop');
	const transport = $<HTMLSelectElement>('transport');
	const stone = $<HTMLSelectElement>('stone');
	const saved = readSaved<{ shown?: boolean; from?: number; to?: number; speed?: string; transport?: number; stone?: number }>(TRAVEL_KEY);
	shown.checked = saved.shown ?? false;
	speed.value = saved.speed ?? '1';
	viewer.flightPathsShown = shown.checked;
	const remember = () => save(TRAVEL_KEY, { shown: shown.checked, from: Number(from.value), to: Number(to.value), speed: speed.value, transport: Number(transport.value) || saved.transport, stone: Number(stone.value) || saved.stone });

	const fill = () => {
		const keep = [Number(from.value) || saved.from, Number(to.value) || saved.to];
		const masters = viewer.flightMasters;
		for (const [select, value] of [[from, keep[0]], [to, keep[1]]] as const) {
			select.replaceChildren(...masters.map((m) => new Option(m.name, String(m.id))));
			if (masters.some((m) => m.id === value)) select.value = String(value);
		}
		go.disabled = masters.length < 2;
	};
	viewer.onFlightsChange = fill;
	fill();
	shown.addEventListener('change', () => {
		viewer.flightPathsShown = shown.checked;
		remember();
	});
	for (const s of [from, to, speed]) s.addEventListener('change', remember);
	$('flight-nearest').addEventListener('click', () => {
		const m = viewer.nearestFlightMaster();
		if (m) from.value = String(m.id);
		else notify('No flight master on this map for this side');
		remember();
	});
	go.addEventListener('click', () => {
		const problem = viewer.takeFlight(Number(from.value), Number(to.value), Number(speed.value));
		if (problem) notify(problem);
		else ($('travel') as HTMLDetailsElement).open = false;
	});
	stop.addEventListener('click', () => viewer.stopFlight());
	hudFollowers.push(() => {
		stop.disabled = !viewer.onFlight;
	});

	// Boats and zeppelins: on board where one is now, or along for the ride.
	const transportStop = $<HTMLButtonElement>('transport-stop');
	const fillTransports = () => {
		const keep = Number(transport.value) || saved.transport;
		const list = [...viewer.transportList].sort((a, b) => a.name.localeCompare(b.name));
		transport.replaceChildren(...([['ship', 'Boats'], ['zeppelin', 'Zeppelins']] as const).map(([kind, label]) => {
			const group = document.createElement('optgroup');
			group.label = label;
			group.append(...list.filter((t) => t.kind === kind).map((t) => new Option(t.name, String(t.entry))));
			return group;
		}));
		if (list.some((t) => t.entry === keep)) transport.value = String(keep);
		for (const id of ['transport-goto', 'transport-ride']) $<HTMLButtonElement>(id).disabled = !list.length;
	};
	viewer.onTransportsChange = fillTransports;
	fillTransports();
	transport.addEventListener('change', remember);
	$('transport-goto').addEventListener('click', () => {
		const problem = viewer.goToTransport(Number(transport.value));
		if (problem) notify(problem);
	});
	$('transport-ride').addEventListener('click', () => {
		const problem = viewer.rideTransport(Number(transport.value));
		if (problem) notify(problem);
		else ($('travel') as HTMLDetailsElement).open = false;
	});
	transportStop.addEventListener('click', () => viewer.stopFlight());
	hudFollowers.push(() => {
		transportStop.disabled = !viewer.onTransport;
		$('transport-status').textContent = viewer.onTransport ? '' : viewer.transportStatus(Number(transport.value));
		$('dock-status').textContent = viewer.nearestDockStatus();
	});

	// Meeting stones: summoned to one, or straight into its dungeon.
	stone.replaceChildren(...([[0, 'Eastern Kingdoms'], [1, 'Kalimdor']] as const).map(([mapId, label]) => {
		const group = document.createElement('optgroup');
		group.label = label;
		group.append(...viewer.meetingStones.filter((s) => s.map === mapId).map((s) => new Option(stoneLabel(s), String(s.guid))));
		return group;
	}));
	if (viewer.meetingStone(saved.stone ?? 0)) stone.value = String(saved.stone);
	for (const id of ['stone-goto', 'stone-enter']) $<HTMLButtonElement>(id).disabled = !viewer.meetingStones.length;
	stone.addEventListener('change', remember);
	$('stone-goto').addEventListener('click', () => void meetingStoneAction(viewer.goToMeetingStone(Number(stone.value))));
	$('stone-enter').addEventListener('click', () => void meetingStoneAction(viewer.enterDungeon(Number(stone.value))));

	const map = new WorldMap($('worldmap'), $<HTMLCanvasElement>('worldmap-canvas'), storage, () => viewer.worldMapView(), (mapId, x, y) => viewer.flyOverWow(mapId, x, y), (mapId, x, y) => viewer.areaNameAt(mapId, x, y), arrow, {
		title: $('worldmap-title'),
		up: $<HTMLButtonElement>('worldmap-up'),
		count: $('worldmap-count'),
		all: $<HTMLInputElement>('worldmap-all'),
		forget: $<HTMLButtonElement>('worldmap-forget'),
		close: $<HTMLButtonElement>('worldmap-close'),
		hover: $('worldmap-hover'),
	});
	viewer.onExplore = (areas) => map.explore(areas);
	hudFollowers.push(() => map.update());
	$('worldmap-open').addEventListener('click', () => {
		($('travel') as HTMLDetailsElement).open = false;
		map.toggle();
	});
	window.addEventListener('keydown', (e) => {
		if (e.code !== 'Tab' || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
		e.preventDefault();
		map.toggle();
	});
}

const TRAVEL_KEY = 'mapExplorer.travel';

/** A meeting stone's dungeon and level range, as the stone's tooltip has it. */
function stoneLabel(s: MeetingStone): string {
	return `${s.dungeon} (${s.minLevel}–${s.maxLevel})`;
}

/** Runs a meeting stone's Go to or Enter, closing the menus once on the way, or saying why not. */
async function meetingStoneAction(action: Promise<string | null>): Promise<void> {
	const problem = await action;
	if (problem) notify(problem);
	else ($('travel') as HTMLDetailsElement).open = false;
}

// --- Walking ---

/** What the walking key (the one left of 1) is labelled on this keyboard. */
let walkKey = '`';

/**
 * Labels keys named by position (kbd data-key="Backquote", the KeyboardEvent code) with what they show on this keyboard
 * layout, where the browser can tell (§ on Nordic keyboards, ^ on German ones...).
 */
async function labelKeys(): Promise<void> {
	const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap(): Promise<Map<string, string>> } }).keyboard;
	let layout: Map<string, string> | undefined;
	try {
		layout = await keyboard?.getLayoutMap();
	} catch {
		// Not allowed here (a frame, an old browser): the US labels stand.
	}
	walkKey = layout?.get('Backquote') ?? walkKey;
	for (const kbd of document.querySelectorAll<HTMLElement>('kbd[data-key]')) {
		const label = layout?.get(kbd.dataset.key!);
		if (label) kbd.textContent = label;
	}
}
void labelKeys();

const WALK_KEY = 'mapExplorer.walker';

/** The Travel menu's switch between flying and walking, and the travel form that walks: race, sex, model, outfit and look, remembered. */
function setUpWalking(viewer: Viewer): void {
	const race = $<HTMLSelectElement>('walk-race');
	const sex = $<HTMLSelectElement>('walk-sex');
	const model = $<HTMLSelectElement>('walk-model');
	const outfit = $<HTMLSelectElement>('walk-outfit');
	const lookOut = $<HTMLOutputElement>('walk-look');
	outfit.replaceChildren(
		...Object.entries(CHARACTER_OUTFITS).map(([key, o]) => new Option(o.name, key)),
		new Option('NPC looks', ''),
	);
	const saved = readSaved<CharacterLook>(WALK_KEY);
	let look: CharacterLook = { ...viewer.look, ...saved };
	let races: CharacterRace[] = [];
	/** Looks for the race, sex and model chosen. */
	const lookCount = () => {
		const r = races.find((x) => x.race === look.race);
		return r ? r.sexes[look.sex][look.hd ? 'hd' : 'sd'] : 0;
	};
	const show = () => {
		race.value = String(look.race);
		sex.value = String(look.sex);
		model.value = look.hd ? 'hd' : 'sd';
		const r = races.find((x) => x.race === look.race);
		for (const option of sex.options) option.disabled = !r || !(r.sexes[Number(option.value)].sd || r.sexes[Number(option.value)].hd);
		for (const option of model.options) option.disabled = !r || !r.sexes[look.sex][option.value as 'sd' | 'hd'];
		outfit.value = look.outfit ?? '';
		const count = lookCount();
		// Wearing an outfit, the look buttons go back to the race's NPC looks.
		lookOut.value = look.outfit ? '–' : count ? `${look.look + 1} of ${count}` : '–';
		for (const id of ['walk-look-prev', 'walk-look-next']) $<HTMLButtonElement>(id).disabled = count < 2;
	};
	/** Settles on a race, sex and model that have looks, nearest the one asked for, then dresses the character. */
	const apply = (next: Partial<CharacterLook>) => {
		look = { ...look, ...next };
		// An outfit belongs to one race (guards are human): another race takes off the outfit.
		if (look.outfit && CHARACTER_OUTFITS[look.outfit]?.race !== look.race) look.outfit = null;
		const r = races.find((x) => x.race === look.race) ?? races[0];
		if (r) {
			look.race = r.race;
			if (!r.sexes[look.sex].sd && !r.sexes[look.sex].hd) look.sex = 1 - look.sex;
			if (!r.sexes[look.sex][look.hd ? 'hd' : 'sd']) look.hd = !look.hd;
			const count = lookCount();
			look.look = count ? ((look.look % count) + count) % count : 0;
		}
		save(WALK_KEY, look);
		show();
		void viewer.setLook(look);
	};
	viewer.characterRaces().then((list) => {
		races = list;
		picker.setRaces(list);
		race.replaceChildren(...list.map((r) => new Option(r.name, String(r.race))));
		apply({});
	}, (e) => {
		console.warn('Character races unavailable:', e);
		$('walk-character').hidden = true;
	});
	race.addEventListener('change', () => apply({ race: Number(race.value), look: 0 }));
	sex.addEventListener('change', () => apply({ sex: Number(sex.value), look: 0 }));
	model.addEventListener('change', () => apply({ hd: model.value === 'hd' }));
	outfit.addEventListener('change', () => {
		const chosen = (outfit.value || null) as CharacterOutfit | null;
		apply({ outfit: chosen, race: chosen ? CHARACTER_OUTFITS[chosen].race : look.race });
	});
	const picker = new FormPicker({
		root: $('forms'),
		grid: $('forms-grid'),
		heading: $('forms-heading'),
		scrollbar: $('forms-scrollbar'),
		count: $('forms-count'),
		race: $<HTMLSelectElement>('forms-race'),
		sex: $<HTMLSelectElement>('forms-sex'),
		model: $<HTMLSelectElement>('forms-model'),
		zoom: $<HTMLInputElement>('forms-zoom'),
		close: $<HTMLButtonElement>('forms-close'),
	}, () => viewer.portraits(), (chosen) => apply(chosen));
	$('forms-open').addEventListener('click', () => {
		($('travel') as HTMLDetailsElement).open = false;
		picker.open(look);
	});
	$('walk-look-prev').addEventListener('click', () => apply({ look: look.outfit ? look.look : look.look - 1, outfit: null }));
	$('walk-look-next').addEventListener('click', () => apply({ look: look.outfit ? look.look : look.look + 1, outfit: null }));

	const toggle = $<HTMLButtonElement>('walk-toggle');
	viewer.onNotice = notify;
	// Walking, the mouse is hidden only to turn: no crosshair then.
	document.addEventListener('pointerlockchange', () => {
		if (viewer.walking) $('crosshair').hidden = true;
	});
	const sync = () => {
		toggle.firstChild!.textContent = viewer.walking ? 'Fly again ' : 'Walk on the ground ';
		toggle.classList.toggle('primary', !viewer.walking);
	};
	toggle.addEventListener('click', () => {
		const problem = viewer.setWalking(!viewer.walking);
		if (problem) notify(problem);
		else ($('travel') as HTMLDetailsElement).open = false;
		sync();
	});
	hudFollowers.push(sync);
	sync();
}

const EMOTE_KEY = 'mapExplorer.emotes';
/** The number keys in the order of the Emotes menu's slots: 1 to 9, then 0. */
const EMOTE_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

/**
 * The Emotes menu and the number keys: walking, each key performs the emote put on it (1 to 9
 * and 0), whether the interface is shown or not, with Shift or Repeat over and over. Which emote
 * is on which key, and Repeat, are remembered.
 */
function setUpEmotes(viewer: Viewer): void {
	const saved = readSaved<{ keys: string[]; repeat: boolean }>(EMOTE_KEY);
	const byKey = new Map(EMOTES.map((e) => [e.key, e]));
	/** The emote on each number key ('' for none), in slot order. */
	let keys = EMOTE_DIGITS.map((_, i) => {
		const k = saved.keys?.[i];
		return k === '' || (k && byKey.has(k)) ? k : DEFAULT_EMOTE_KEYS[i];
	});
	const repeat = $<HTMLInputElement>('emote-repeat');
	repeat.checked = !!saved.repeat;
	const remember = () => save(EMOTE_KEY, { keys, repeat: repeat.checked });
	repeat.addEventListener('change', remember);

	const perform = (emote: Emote, over: boolean) => {
		const problem = viewer.emote(emote, over);
		if (problem) notify(problem);
		sync();
	};

	const selects = [...document.querySelectorAll<HTMLSelectElement>('.emote-slots select')];
	for (const select of selects) {
		select.replaceChildren(new Option('None', ''), ...EMOTES.map((e) => new Option(e.name, e.key)));
		select.addEventListener('change', () => {
			keys[Number(select.dataset.slot)] = select.value;
			remember();
			showKeys();
		});
	}
	for (const button of document.querySelectorAll<HTMLButtonElement>('.emote-slots button')) {
		button.addEventListener('click', () => {
			const emote = byKey.get(keys[Number(button.dataset.slot)]);
			if (emote) perform(emote, repeat.checked);
		});
	}
	$('emote-keys-reset').addEventListener('click', () => {
		keys = [...DEFAULT_EMOTE_KEYS];
		remember();
		showKeys();
	});
	$('emote-stop').addEventListener('click', () => {
		viewer.stopEmote();
		sync();
	});

	// Every emote, with the key it's on, to perform with a click.
	const list = $('emote-list');
	const buttons = new Map<string, HTMLButtonElement>();
	for (const emote of EMOTES) {
		const button = document.createElement('button');
		button.addEventListener('click', () => perform(emote, repeat.checked));
		buttons.set(emote.key, button);
		list.append(button);
	}

	/** The slots' choices and each emote's key, after a change. */
	function showKeys(): void {
		selects.forEach((select, i) => {
			select.value = keys[i];
			(select.nextElementSibling as HTMLButtonElement).disabled = !keys[i];
		});
		for (const emote of EMOTES) {
			const button = buttons.get(emote.key)!;
			const slot = keys.indexOf(emote.key);
			button.replaceChildren(emote.name);
			if (slot >= 0) {
				const kbd = document.createElement('kbd');
				kbd.textContent = $('emotes').querySelector<HTMLElement>(`kbd[data-key="Digit${EMOTE_DIGITS[slot]}"]`)?.textContent ?? EMOTE_DIGITS[slot];
				button.append(' ', kbd);
			}
		}
	}

	/** Marks the emote being performed. */
	function sync(): void {
		const playing = viewer.emoting?.key;
		for (const [key, button] of buttons) button.classList.toggle('primary', key === playing);
	}

	// On the number row or the numpad; the interface hidden or not. Flying, 1 and 2 go to the continents instead.
	window.addEventListener('keydown', (e) => {
		if (!viewer.walking || e.repeat || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
		const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code)?.[1];
		if (digit === undefined) return;
		e.preventDefault();
		const emote = byKey.get(keys[EMOTE_DIGITS.indexOf(digit)]);
		if (emote) perform(emote, repeat.checked || e.shiftKey);
		else notify(`No emote on ${digit}: choose one in the Emotes menu`);
	});

	showKeys();
	hudFollowers.push(sync);
	sync();
}

/** The tint's key under the Ground choice: what its colours mean. */
function showTintKey(viewer: Viewer): void {
	$('tint-key').replaceChildren(...viewer.tintKey.map(([color, label]) => {
		const span = document.createElement('span');
		span.style.setProperty('--key', color);
		span.textContent = label;
		return span;
	}));
}

// --- Going places ---

const MAP_GROUPS: [MapCategory, string][] = [
	['continent', 'Continents'],
	['dungeon', 'Dungeons'],
	['raid', 'Raids'],
	['battleground', 'Battlegrounds'],
	['other', 'Other maps'],
];
const MAP_KINDS: Record<MapCategory, string> = { continent: 'Continent', dungeon: 'Dungeon', raid: 'Raid', battleground: 'Battleground', other: 'Other map' };
/** Matches shown at most. */
const GOTO_LIMIT = 40;

interface Destination {
	name: string;
	/** What it is, or where it lies. */
	sub: string;
	/** Zones before maps before towns, among matches as good as each other. */
	order: number;
	category?: MapCategory;
	/** The name lower-cased, without accents or apostrophes, for matching. */
	key: string;
	go: () => Promise<boolean>;
}

const searchKey = (text: string) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ'’]/g, '');

/** How well a name matches: the start of it, the start of a word in it, anywhere in it, or not at all (-1). */
function matchScore(key: string, query: string): number {
	if (key.startsWith(query)) return 0;
	if (key.split(/[\s-]+/).some((word) => word.startsWith(query))) return 1;
	return key.includes(query) ? 2 : -1;
}

/**
 * Go to: a search over every zone, town and landmark, and every map in the install (many have
 * no way in from the world). Empty, it lists the maps by kind, as a way in to all of them.
 */
async function setUpGoTo(viewer: Viewer): Promise<void> {
	const menu = $<HTMLDetailsElement>('goto');
	const input = $<HTMLInputElement>('goto-query');
	const list = $('goto-results');
	const [maps, places] = await Promise.all([
		storage.listMaps().catch((e): MapListing[] => {
			console.warn('Map list unavailable:', e);
			return [];
		}),
		storage.loadPlaces().catch((e): Place[] => {
			console.warn('Zones and towns unavailable:', e);
			return [];
		}),
	]);
	const mapNames = new Map(maps.map((m) => [m.id, m.name]));
	const destination = (name: string, sub: string, order: number, go: () => Promise<boolean>, category?: MapCategory): Destination => ({ name, sub, order, category, key: searchKey(name), go });
	// Only places on maps in the install, and not a battleground's own zone (the map stands for it).
	const placesHere = places.filter((p) => mapNames.has(p.mapId) && !(p.kind === 'zone' && mapNames.get(p.mapId) === p.name));
	const destinations = [
		...placesHere.filter((p) => p.kind === 'zone').map((p) => destination(p.name, 'Zone', 0, () => viewer.goToPlace(p))),
		...maps.map((m) => destination(m.name, MAP_KINDS[m.category], 1, () => viewer.goToMap(m.id), m.category)),
		...placesHere.filter((p) => p.kind === 'place').map((p) => destination(p.name, p.zone ?? mapNames.get(p.mapId) ?? '', 2, () => viewer.goToPlace(p))),
	];

	let shown: Destination[] = [];
	let active = -1;

	const item = (d: Destination) => {
		const li = document.createElement('li');
		li.role = 'option';
		li.id = `goto-${shown.length}`;
		const name = document.createElement('span');
		name.textContent = d.name;
		const sub = document.createElement('span');
		sub.className = 'sub';
		sub.textContent = d.sub;
		li.append(name, sub);
		// Before the box loses focus.
		li.addEventListener('mousedown', (e) => {
			e.preventDefault();
			void pick(d);
		});
		shown.push(d);
		return li;
	};
	const note = (text: string, className: string) => {
		const li = document.createElement('li');
		li.className = className;
		li.textContent = text;
		return li;
	};
	const setActive = (index: number) => {
		active = index;
		list.querySelectorAll('[aria-selected]').forEach((li) => li.removeAttribute('aria-selected'));
		const li = index >= 0 ? $(`goto-${index}`) : null;
		li?.setAttribute('aria-selected', 'true');
		li?.scrollIntoView({ block: 'nearest' });
		if (li) input.setAttribute('aria-activedescendant', li.id);
		else input.removeAttribute('aria-activedescendant');
	};
	const render = () => {
		const query = searchKey(input.value.trim());
		shown = [];
		const rows: HTMLLIElement[] = [];
		if (!query) {
			for (const [category, label] of MAP_GROUPS) {
				const group = destinations.filter((d) => d.category === category);
				if (!group.length) continue;
				rows.push(note(label, 'group'), ...group.map(item));
			}
		} else {
			const matches = destinations
				.map((d) => ({ d, score: matchScore(d.key, query) }))
				.filter((m) => m.score >= 0)
				.sort((a, b) => a.score - b.score || a.d.order - b.d.order || a.d.name.length - b.d.name.length || a.d.name.localeCompare(b.d.name))
				.slice(0, GOTO_LIMIT);
			rows.push(...matches.map((m) => item(m.d)));
			if (!matches.length) rows.push(note('Nothing by that name', 'empty'));
		}
		list.replaceChildren(...rows);
		input.setAttribute('aria-expanded', 'true');
		setActive(query && shown.length ? 0 : -1);
	};
	const pick = async (d: Destination) => {
		menu.open = false;
		if (!(await d.go())) notify(`${d.name} isn’t in this install`);
	};

	// Opened, the box is ready to type in, listing every map; closed, it starts afresh.
	menu.addEventListener('toggle', () => {
		if (menu.open) {
			render();
			input.focus();
		} else {
			input.blur();
			input.value = '';
			input.setAttribute('aria-expanded', 'false');
			setActive(-1);
		}
	});
	// Ready for keys as soon as it's clicked, not after the toggle event, or the first few fly the camera.
	menu.querySelector('summary')!.addEventListener('click', (e) => {
		if (menu.open) return;
		e.preventDefault();
		menu.open = true;
		input.focus();
	});
	input.addEventListener('input', render);
	input.addEventListener('keydown', (e) => {
		if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
			e.preventDefault();
			if (shown.length) setActive((active + (e.code === 'ArrowDown' ? 1 : shown.length - 1 + (active < 0 ? 1 : 0))) % shown.length);
		} else if (e.code === 'Enter') {
			const d = shown[Math.max(active, 0)];
			if (d) void pick(d);
		} else if (e.code === 'Escape') {
			menu.open = false;
		}
	});
	window.addEventListener('keydown', (e) => {
		if (e.key !== '/' || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
		e.preventDefault();
		if (document.pointerLockElement) document.exitPointerLock();
		menu.open = true;
		input.focus();
	});
}

// --- Highlighting things on the ground ---

const HIGHLIGHT_KEY = 'mapExplorer.highlight';

/** The highlight panel: kinds to mark and a name to find, remembered between visits. */
function setUpHighlights(viewer: Viewer): void {
	const panel = $('highlight');
	const on = $<HTMLInputElement>('highlight-on');
	const query = $<HTMLInputElement>('highlight-query');
	const walkable = $<HTMLInputElement>('highlight-walkable');
	const walls = $<HTMLInputElement>('highlight-walls');
	const tint = $<HTMLSelectElement>('highlight-tint');
	const level = $<HTMLInputElement>('tint-level');
	const levelOut = $('tint-level-out');
	const rested = $<HTMLInputElement>('highlight-rested');
	const boxes = [...panel.querySelectorAll<HTMLInputElement>('#highlight-groups input')];
	const saved = readSaved<HighlightSettings>(HIGHLIGHT_KEY);
	on.checked = saved.on ?? false;
	query.value = saved.query ?? '';
	walkable.checked = saved.walkable ?? false;
	walls.checked = saved.walls ?? false;
	// Saved before the tints came in: the graveyards had a box of their own.
	tint.value = saved.tint ?? ((saved as { graveyards?: boolean }).graveyards ? 'graveyards' : '');
	level.value = String(saved.level ?? 20);
	rested.checked = saved.rested ?? false;
	for (const box of boxes) box.checked = saved.groups?.includes(box.value as HighlightGroup) ?? false;

	const apply = () => {
		const settings: HighlightSettings = {
			on: on.checked,
			groups: boxes.filter((b) => b.checked).map((b) => b.value as HighlightGroup),
			query: query.value,
			walkable: walkable.checked,
			walls: walls.checked,
			tint: tint.value as TintMode | '',
			level: Number(level.value),
			rested: rested.checked,
		};
		levelOut.textContent = level.value;
		panel.dataset.tint = settings.tint;
		panel.classList.toggle('off', !settings.on);
		panel.classList.toggle('walkable', settings.walkable);
		panel.classList.toggle('walls', settings.walls);
		viewer.setHighlights(settings);
		save(HIGHLIGHT_KEY, settings);
		showTintKey(viewer);
	};
	for (const box of [on, walkable, walls, rested, tint, ...boxes]) {
		box.addEventListener('change', () => {
			// Choosing a kind turns highlighting on.
			if (box !== on && (box instanceof HTMLSelectElement ? box.value : box.checked)) on.checked = true;
			apply();
		});
	}
	query.addEventListener('input', () => {
		if (query.value.trim()) on.checked = true;
		apply();
	});
	level.addEventListener('input', apply);
	query.addEventListener('keydown', (e) => {
		if (e.code === 'Enter') query.blur();
	});
	window.addEventListener('keydown', (e) => {
		if (e.code !== 'KeyH' || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
		on.checked = !on.checked;
		apply();
		notify(`Highlights ${onOff(on.checked)}`);
	});
	apply();
}

// --- Sound ---

/** The Sound panel's on/off box, which is greyed out until the music is read. */
function syncSound(viewer: Viewer): void {
	const box = $<HTMLInputElement>('sound-on');
	box.checked = viewer.soundOn ?? false;
	box.disabled = viewer.soundOn === null;
}

/** The Sound panel: music and sound on or off, and a slider per kind of sound, applied as they move. */
function setUpSound(viewer: Viewer): void {
	const panel = $('sound');
	for (const slider of panel.querySelectorAll<HTMLInputElement>('input[type=range]')) {
		const channel = slider.dataset.channel as VolumeChannel;
		const shown = slider.nextElementSibling as HTMLOutputElement;
		slider.value = String(Math.round(volumeSetting(channel) * 100));
		shown.value = `${slider.value}%`;
		slider.addEventListener('input', () => {
			setVolume(channel, Number(slider.value) / 100);
			shown.value = `${slider.value}%`;
		});
	}
	$('sound-on').addEventListener('change', (e) => {
		viewer.soundOn = (e.target as HTMLInputElement).checked;
	});
	// The music is read after the world opens.
	hudFollowers.push(() => syncSound(viewer));
}

// --- Help ---

const HELP_KEY = 'mapExplorer.helpSeen';

/** The list of controls: ? or F1, or the button at the right of the menus; shown once by itself on the first visit. */
function setUpHelp(): void {
	const help = $('help');
	const show = (on: boolean) => {
		help.hidden = !on;
		if (on && document.pointerLockElement) document.exitPointerLock();
	};
	$('help-hint').addEventListener('click', () => show(Boolean(help.hidden)));
	$('help-close').addEventListener('click', () => show(false));
	help.addEventListener('click', (e) => {
		if (e.target === help) show(false);
	});
	window.addEventListener('keydown', (e) => {
		if (isTyping(e)) return;
		if (e.key === '?' || e.code === 'F1') {
			e.preventDefault();
			show(Boolean(help.hidden));
		} else if (e.code === 'Escape') {
			show(false);
		}
	});
	let seen = true;
	try {
		seen = localStorage.getItem(HELP_KEY) === '1';
		localStorage.setItem(HELP_KEY, '1');
	} catch {
		// Storage blocked: not shown by itself, as it couldn't be remembered as seen.
	}
	if (!seen) show(true);
}

// --- Hiding the interface ---

// U, or Alt+Z as in the game: everything drawn over the world goes, for a clear view or
// screenshots. The NVIDIA overlay takes Alt+Z for itself where it's installed, hence U too.
window.addEventListener('keydown', (e) => {
	const toggle = e.altKey ? e.code === 'KeyZ' : e.code === 'KeyU' && !e.ctrlKey && !e.metaKey;
	if (!toggle || $('start').hidden === false || isTyping(e)) return;
	e.preventDefault();
	const hidden = document.body.classList.toggle('ui-hidden');
	notify(hidden ? 'Interface hidden: U brings it back' : 'Interface shown');
});

// --- Debug log ---

// F9 saves what the app recorded (freezes, loading, the WebGL calls that waited) to a file, for a bug report.
window.addEventListener('keydown', (e) => {
	if (e.code !== 'F9' || isTyping(e)) return;
	e.preventDefault();
	perf.save();
	notify('Debug log saved to your downloads');
});

// --- Screenshots ---

let shotStatusTimer = 0;

/** Screenshot progress (P); kept on screen even with the interface hidden, but never in the picture. */
function showShotStatus(text: string | null, done = false): void {
	const el = $('shot-status');
	clearTimeout(shotStatusTimer);
	el.hidden = !text;
	el.textContent = text ?? '';
	if (done) shotStatusTimer = window.setTimeout(() => (el.hidden = true), 5000);
}

// --- Clicked creature or object ---

document.addEventListener('pointerlockchange', () => {
	$('crosshair').hidden = !document.pointerLockElement;
});
$('info-close').addEventListener('click', () => ($('info').hidden = true));
window.addEventListener('keydown', (e) => {
	if (e.code === 'Escape' && !isTyping(e)) $('info').hidden = true;
});

/** Book text uses $B for line breaks and $N for the reader's name. */
function pageText(text: string): string {
	return text.replace(/\$[Bb]/g, '\n').replace(/\$[Nn]/g, 'traveler').replace(/\$[Cc]/g, 'adventurer');
}

/** The viewer, for the actions the info panel offers (a meeting stone's Go to and Enter). */
let infoViewer: Viewer | null = null;

function showInfo(info: SpawnInfo): void {
	const isNpc = info.type === 'npc';
	$('info-kind').textContent = [isNpc ? 'NPC' : 'Object', info.kind, info.rank].filter(Boolean).join(' · ');
	$('info-name').textContent = info.name;
	$('info-sub').textContent = info.subname ? `<${info.subname}>` : '';
	const facts: [string, string][] = [];
	if (info.level) facts.push(['Level', info.level]);
	const stone = !isNpc ? infoViewer?.meetingStone(info.guid) : null;
	if (stone) facts.push(['Dungeon', stone.dungeon], ['Levels', `${stone.minLevel}–${stone.maxLevel}`]);
	facts.push([isNpc ? 'NPC ID' : 'Object ID', String(info.entry)], ['Spawn', String(info.guid)]);
	fillList('info-facts', facts);

	const actions: HTMLButtonElement[] = [];
	if (stone && infoViewer) {
		const viewer = infoViewer;
		const enter = document.createElement('button');
		enter.className = 'primary';
		enter.textContent = `Enter ${stone.dungeon.replace(/^The /, '')}`;
		enter.addEventListener('click', () => void meetingStoneAction(viewer.enterDungeon(stone.guid)));
		actions.push(enter);
	}
	$('info-actions').replaceChildren(...actions);

	const pages = $('info-pages');
	pages.replaceChildren();
	(info.pages ?? []).forEach((text, i) => {
		if (i > 0) pages.append(document.createElement('hr'));
		pages.append(pageText(text));
	});

	// Wowhead uses the same creature/object template IDs; its tooltip script decorates these links.
	const path = `${isNpc ? 'npc' : 'object'}=${info.entry}`;
	const links = [
		['Wowhead Forever', `https://www.wowhead.com/forever/${path}`],
		['Wowhead Classic', `https://www.wowhead.com/classic/${path}`],
	].map(([label, href]) => {
		const a = document.createElement('a');
		a.href = href;
		a.target = '_blank';
		a.rel = 'noopener';
		a.textContent = label;
		return a;
	});
	$('info-links').replaceChildren(...links);
	$('info').hidden = false;
	$('info').scrollTop = 0;
	(window as unknown as { $WowheadPower?: { refreshLinks?: () => void } }).$WowheadPower?.refreshLinks?.();
}

let shownZone: string | null = null;
let shownSubzone: string | null = null;

/** Fades a line of zone text in, holds it and fades it out again, from the start. */
function fadeZoneLine(el: HTMLElement): void {
	el.classList.remove('show');
	void el.offsetWidth; // restart the animation
	el.classList.add('show');
}

/**
 * Zone text as the game's ZoneText.lua shows it: a new zone shows its name with the subzone
 * under it; within a zone only the subzone line shows, and leaving a subzone for the open zone
 * shows the zone's name there.
 */
function announceZone(zone: string | null, subzone: string | null): void {
	if (!zone || (zone === shownZone && subzone === shownSubzone)) return;
	const newZone = zone !== shownZone;
	shownZone = zone;
	shownSubzone = subzone;
	$('zone-name').textContent = zone;
	if (newZone) fadeZoneLine($('zone-name'));
	const sub = subzone ?? (newZone ? '' : zone);
	$('subzone-name').textContent = sub;
	if (sub) fadeZoneLine($('subzone-name'));
}

function showHud(info: HudInfo): void {
	announceZone(info.zone, info.subzone);
	$('highlight-status').textContent = info.highlights;
	// The minimap's zone line, as GetMinimapZoneText: the subzone if there is one.
	$('minimap-zone').textContent = info.subzone ?? info.zone ?? info.location;
	$('hud-location').textContent = info.zone ? [info.zone, info.subzone].filter(Boolean).join(' · ') : info.location;
	$('hud-coords').textContent = info.zone ? `${info.location} · ${info.coordinates}` : info.coordinates;
	fillList('hud-view', [
		['Time', info.time],
		['Altitude', `${info.altitude.toFixed(0)} yd above ground`],
		['Music', info.music],
		...(info.weather ? [['Weather', info.weather] as [string, string]] : []),
		...(info.flight ? [['Flight', info.flight] as [string, string]] : []),
		...(info.voyage ? [['Aboard', info.voyage] as [string, string]] : []),
	]);
	$('flight-status').textContent = info.flight || info.voyage;
	if (!$('hud-stats').hidden) {
		fillList('hud-stats', [
			['Speed', `${info.speed.toFixed(0)} yd/s`],
			['Detail', info.near],
			['Objects', info.objects],
			['Textures', info.textures],
			['FPS', info.fps.toFixed(0)],
		]);
	}
	for (const follow of hudFollowers) follow();
}
