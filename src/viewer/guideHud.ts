import type { WorldMapInfo } from '../explorer/worldMap';
import { GUIDE_CLASSES, GUIDE_RACES, parseGuides, route, zoneId, type Character, type RouteStep, type Waypoint } from '../game/guide';
import type { AsyncStorageApi } from '../worker/protocol';
import type { Viewer } from './viewer';

/**
 * A leveling guide followed in the world: the Guide menu loads the player's own guide file (kept
 * in this browser only), builds the route for their character and shows the step to do in a box
 * at the side, with an arrow and distance to its waypoint, a pillar of light standing there and
 * the way to it and the next steps' places laid on the ground.
 * In Adventure mode a step moves on by itself once its quests are taken, done or handed in.
 */

const STATE_KEY = 'mapExplorer.guide';
/** Close enough to a step's place (yards) for a step that's only travel to count as done. */
const ARRIVED = 8;
const CHECK_EVERY = 500;
/** How many steps ahead the way on the ground goes. */
const PATH_STEPS = 8;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** The guide file, kept in IndexedDB: too big for localStorage. */
function guideStore(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const open = indexedDB.open('mapExplorer.guide', 1);
		open.onupgradeneeded = () => open.result.createObjectStore('files');
		open.onsuccess = () => resolve(open.result);
		open.onerror = () => reject(open.error);
	});
}
async function keep(text: string): Promise<void> {
	const db = await guideStore();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction('files', 'readwrite');
		tx.objectStore('files').put(text, 'guide');
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}
async function kept(): Promise<string | null> {
	const db = await guideStore();
	return new Promise((resolve) => {
		const get = db.transaction('files').objectStore('files').get('guide');
		get.onsuccess = () => resolve(typeof get.result === 'string' ? get.result : null);
		get.onerror = () => resolve(null);
	});
}

interface Saved {
	race?: number;
	cls?: number;
	step?: number;
	auto?: boolean;
	shown?: boolean;
}
function read(): Saved {
	try {
		return JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') as Saved;
	} catch {
		return {};
	}
}
function write(s: Saved): void {
	try {
		localStorage.setItem(STATE_KEY, JSON.stringify(s));
	} catch {
		// Not remembered.
	}
}

/** Letters only, lower case: "Stormwind City", "StormwindClassic" and "stormwind" all compare alike. */
const simple = (name: string) => name.toLowerCase().replace(/classic$/i, '').replace(/[^a-z]/g, '');

export function setUpGuide(viewer: Viewer, storage: AsyncStorageApi): void {
	const box = $('guide-box');
	const file = $<HTMLInputElement>('guide-file');
	const status = $('guide-status');
	const raceSelect = $<HTMLSelectElement>('guide-race');
	const classSelect = $<HTMLSelectElement>('guide-class');
	const guideSelect = $<HTMLSelectElement>('guide-section');
	const auto = $<HTMLInputElement>('guide-auto');
	const shown = $<HTMLInputElement>('guide-shown');
	const saved = read();
	raceSelect.replaceChildren(...Object.entries(GUIDE_RACES).map(([id, name]) => new Option(name.replace(/([a-z])([A-Z])/g, '$1 $2'), id)));
	classSelect.replaceChildren(...Object.entries(GUIDE_CLASSES).map(([id, name]) => new Option(name, id)));
	// The Adventure character's race and class, unless chosen here before.
	raceSelect.value = String(saved.race ?? viewer.look.race);
	classSelect.value = String(saved.cls ?? viewer.adventure?.cls.id ?? 11);
	auto.checked = saved.auto ?? true;
	shown.checked = saved.shown ?? true;

	let text: string | null = null;
	let steps: RouteStep[] = [];
	let names: string[] = [];
	let index = saved.step ?? 0;
	let maps: Promise<WorldMapInfo[]> | null = null;
	/** Where the step's waypoint is, in WoW coordinates on its map, once worked out. */
	let target: { mapId: number; x: number; y: number } | null = null;

	const save = () => write({ race: Number(raceSelect.value), cls: Number(classSelect.value), step: index, auto: auto.checked, shown: shown.checked });
	const character = (): Character => ({ faction: [2, 5, 6, 8, 9, 10].includes(Number(raceSelect.value)) ? 'Horde' : 'Alliance', race: GUIDE_RACES[Number(raceSelect.value)], cls: GUIDE_CLASSES[Number(classSelect.value)] });

	/** A waypoint in WoW coordinates on its map: straight from world ones, else through the zone's map. */
	const locate = async (w: Waypoint): Promise<{ mapId: number; x: number; y: number } | null> => {
		maps ??= storage.loadWorldMaps([0, 1]);
		const list = await maps;
		if ('ui' in w) {
			const m = list.find((info) => info.id === w.ui);
			const mapId = m?.assignments[0]?.mapId ?? (w.ui >= 1411 && w.ui <= 1417 ? 1 : 0);
			return { mapId, x: w.x, y: w.y };
		}
		const id = zoneId(w.zone);
		const want = simple(w.zone);
		const m = list.find((info) => info.id === id) ?? list.find((info) => simple(info.name) === want);
		if (!m) return null;
		const u = w.px / 100, v = w.py / 100;
		for (const a of m.assignments) {
			if (u < a.uiMin[0] || u > a.uiMax[0] || v < a.uiMin[1] || v > a.uiMax[1]) continue;
			const fu = (u - a.uiMin[0]) / (a.uiMax[0] - a.uiMin[0]);
			const fv = (v - a.uiMin[1]) / (a.uiMax[1] - a.uiMin[1]);
			return { mapId: a.mapId, x: a.max[0] - fv * (a.max[0] - a.min[0]), y: a.max[1] - fu * (a.max[1] - a.min[1]) };
		}
		return null;
	};

	const build = () => {
		if (!text) return;
		const r = route(parseGuides(text), character());
		steps = r.steps;
		names = r.names;
		index = Math.min(index, Math.max(0, steps.length - 1));
		guideSelect.replaceChildren(...names.map((n) => new Option(n, n)));
		status.textContent = steps.length ? `${names.length} guides, ${steps.length} steps for a ${raceSelect.selectedOptions[0]?.text} ${classSelect.selectedOptions[0]?.text}.` : 'No guide in that file fits this character.';
		show();
	};

	const show = () => {
		const step = steps[index];
		box.hidden = !step || !shown.checked;
		save();
		if (!step) {
			void viewer.setWaypoint(null);
			void viewer.setGuidePath([]);
			return;
		}
		guideSelect.value = step.guide;
		$('guide-title').textContent = `${step.guide} · ${index + 1}/${steps.length}`;
		const lines = $('guide-lines');
		lines.replaceChildren(...step.text.map((line) => {
			const div = document.createElement('div');
			for (const seg of line) {
				const span = document.createElement('span');
				span.textContent = seg.text;
				if (seg.tone) span.className = `tone-${seg.tone.toLowerCase()}`;
				div.append(span);
			}
			return div;
		}));
		target = null;
		void viewer.setWaypoint(null);
		// The way: this step's waypoints and those of the steps after it, in order.
		const ahead = steps.slice(index, index + PATH_STEPS).flatMap((s) => s.goto);
		const asked = index;
		void Promise.all(ahead.map(locate)).then((spots) => {
			if (asked !== index) return;
			// Up to a place it can't find or on another continent.
			const end = spots.findIndex((s) => !s || s.mapId !== spots[0]?.mapId);
			void viewer.setGuidePath(spots.slice(0, end < 0 ? spots.length : end) as { mapId: number; x: number; y: number }[]);
		});
		const last = step.goto.at(-1);
		if (last) {
			void locate(last).then((spot) => {
				if (asked !== index || !spot) return;
				target = spot;
				void viewer.setWaypoint(spot);
			});
		}
	};

	const go = (to: number) => {
		index = Math.max(0, Math.min(steps.length - 1, to));
		show();
	};

	// --- Loading the file ---
	file.addEventListener('change', async () => {
		const f = file.files?.[0];
		if (!f) return;
		text = await f.text();
		index = 0;
		build();
		void keep(text).catch(() => (status.textContent += ' (Not kept: this browser refused to store it.)'));
	});
	void kept().then((t) => {
		if (!t) return;
		text = t;
		build();
	}).catch(() => {});

	for (const select of [raceSelect, classSelect]) select.addEventListener('change', () => {
		index = 0;
		build();
	});
	guideSelect.addEventListener('change', () => go(steps.findIndex((s) => s.guide === guideSelect.value)));
	auto.addEventListener('change', save);
	shown.addEventListener('change', show);
	for (const id of ['guide-prev', 'guide-box-prev']) $(id).addEventListener('click', () => go(index - 1));
	for (const id of ['guide-next', 'guide-box-next']) $(id).addEventListener('click', () => go(index + 1));
	$('guide-fly').addEventListener('click', () => {
		if (!target) return;
		if (viewer.walking) viewer.setWalking(false);
		viewer.flyOverWow(target.mapId, target.x, target.y);
	});

	// --- Every frame: the arrow and distance; now and then: has the step been done? ---
	const arrow = $('guide-arrow');
	const distance = $('guide-distance');
	let lastCheck = 0;
	const frame = (now: number) => {
		requestAnimationFrame(frame);
		if (box.hidden) return;
		const me = viewer.worldMapView();
		const there = target;
		if (!me || !there || me.mapId !== there.mapId) {
			arrow.hidden = true;
			distance.textContent = there && me ? 'On another continent' : '';
			return;
		}
		const dx = there.x - me.x, dy = there.y - me.y;
		const yards = Math.hypot(dx, dy);
		// WoW orientation of the way there (0 north, turning west), less the way the player faces.
		const turn = Math.atan2(dy, dx) - me.facing;
		arrow.hidden = false;
		arrow.style.transform = `rotate(${-turn}rad)`;
		distance.textContent = `${Math.round(yards)} yd`;
		if (now - lastCheck < CHECK_EVERY || !auto.checked) return;
		lastCheck = now;
		if (done(steps[index], yards)) go(index + 1);
	};
	requestAnimationFrame(frame);

	/** Whether the player has done what a step asks, as far as this page can tell. */
	const done = (step: RouteStep | undefined, yards: number): boolean => {
		if (!step) return false;
		const book = viewer.adventure?.enabled ? viewer.adventure.quests : null;
		const quests = step.accept.length + step.turnin.length + step.complete.length;
		if (quests && book) {
			const known = (id: number) => !!book.quest(id);
			return step.accept.every((id) => !known(id) || book.isActive(id) || book.isDone(id))
				&& step.turnin.every((id) => !known(id) || book.isDone(id))
				&& step.complete.every((id) => !known(id) || book.isDone(id) || (book.isActive(id) && book.complete(id)))
				&& [...step.accept, ...step.turnin, ...step.complete].some(known);
		}
		// Only travel: done on arrival.
		return !quests && step.goto.length > 0 && viewer.walking && yards <= ARRIVED;
	};
}
