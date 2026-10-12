import type { SourceInit } from '../worker/protocol';
import type { ViewSpot } from './viewer';

/**
 * Quick switching (an option in the Game version menu): the page holds each game version's
 * viewer in a frame of its own (see switchHost.ts), the one switched away from kept loaded out
 * of sight, so switching back and forth keeps the view and needs no reload. Off, the page is the
 * viewer itself and a switch reloads it.
 */
const QUICK_KEY = 'mapExplorer.quickSwitch';

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

export function productName(product: string): string {
	return PRODUCT_NAMES[product] ?? product;
}

export function quickSwitching(): boolean {
	try {
		return localStorage.getItem(QUICK_KEY) === '1';
	} catch {
		return false;
	}
}

/** Where how many versions quick switching keeps is remembered (see keptVersions). */
export const KEPT_VERSIONS_KEY = 'mapExplorer.quickSwitchKeep';
/** Most versions quick switching keeps loaded out of sight: each holds a whole world. */
export const MAX_KEPT = 3;

/** How many versions quick switching keeps loaded out of sight, besides the one shown: 1 to MAX_KEPT. */
export function keptVersions(): number {
	try {
		const n = Number(localStorage.getItem(KEPT_VERSIONS_KEY));
		return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_KEPT) : 1;
	} catch {
		return 1;
	}
}

export function setKeptVersions(n: number): void {
	try {
		localStorage.setItem(KEPT_VERSIONS_KEY, String(n));
	} catch {
		// Not remembered: one.
	}
}

export function setQuickSwitching(on: boolean): void {
	try {
		localStorage.setItem(QUICK_KEY, on ? '1' : '0');
	} catch {
		// Not remembered: off.
	}
}

/**
 * What a switch to another game version carries over: exactly what was in view, on foot or
 * flying, a time of day moved from the local time, and (switching in place) the movement keys
 * held down.
 */
export interface SwitchState {
	view: ViewSpot | null;
	time: number | null;
	keys?: string[];
	/** Chosen in the Game version menu (not with a shortcut): the next viewer opens it again. */
	menu?: boolean;
	/** The mouse was captured for looking around (switching in place). */
	captured?: boolean;
}

/** What the host asks of a viewer frame it made for a switch. */
export interface SwitchRequest {
	product: string;
	source: SourceInit;
	state: SwitchState;
}

/** A viewer frame, as the host drives it once it has loaded. */
export interface ViewerSession {
	product: string;
	/** What's in view now, for the next viewer to show. */
	state(): SwitchState;
	/** Moves to what another viewer showed (one kept loaded, brought back). */
	show(state: SwitchState): Promise<void>;
	/** Out of sight: stops drawing and sound, lets go of the mouse; settled once the mouse is free. */
	pause(): Promise<void>;
	/** Shown: draws and is heard again, the movement keys still held carried on, the mouse captured again if it was. */
	activate(keys: string[], captured: boolean): void;
}

/** The page holding the viewer frames (see switchHost.ts), as a frame reaches it. */
export interface SessionHost {
	/** Set for a frame the host made for a switch: the version to open and where. */
	request(child: Window): SwitchRequest | undefined;
	/** A frame's viewer has loaded (for a switch, the ground in view too). */
	ready(child: Window, session: ViewerSession): void;
	/** A frame made for a switch couldn't start. */
	failed(child: Window, reason: string): void;
	/** A loading step of a frame made for a switch. */
	progress(child: Window, text: string): void;
	/** The frame shown asks for another version, with what's in view now. */
	switchProduct(child: Window, product: string, source: SourceInit, state: SwitchState): void;
	/** The view in the frame shown, for the page's address. */
	hash(child: Window, hash: string): void;
}

declare global {
	interface Window {
		mapExplorerHost?: SessionHost;
	}
}

/** The host page, when this page is a viewer frame inside it. */
export function sessionHost(): SessionHost | undefined {
	try {
		return window.parent === window ? undefined : window.parent.mapExplorerHost;
	} catch {
		// Another site's page: not ours.
		return undefined;
	}
}
