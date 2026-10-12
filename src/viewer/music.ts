import type { MusicData, MusicSet } from '../explorer/music';
import type { AsyncStorageApi } from '../worker/protocol';
import { audioContext, newAudio, setLevel, stopAudio } from './audioOut';
import { volume } from './volume';

/** Seconds to fade a track in or out. */
const FADE_IN = 2;
const FADE_OUT = 2.5;
/** How long (ms) a new place's music must stay wanted before switching, so skimming a border doesn't. */
const SETTLE = 1500;
/**
 * Quiet between tracks (ms). The game waits 3-5 minutes; flying about, that reads as broken,
 * so the gap here is shorter.
 */
const GAP: [number, number] = [15000, 45000];
/** Pause between an intro fanfare and the zone's own music. */
const AFTER_INTRO = 2000;
/** Music volume at full setting in the Sound panel. */
const VOLUME = 0.5;
/** Decoded tracks kept as object URLs. */
const URL_CACHE = 8;
const STORAGE_KEY = 'mapExplorer.music';
/** Low-pass cut-off (Hz) for music heard from under water. */
const MUFFLED = 600;
const CLEAR = 20000;

/** What should be playing: a ZoneMusic set and an intro (0 = none). */
export interface MusicTarget {
	set: number;
	intro: number;
}

interface Voice {
	audio: HTMLAudioElement;
	/** 1 while playing, 0 while fading out. */
	target: number;
	level: number;
}

/**
 * Zone music like the game's: a random track from the place's music set (day or night), quiet
 * spells between tracks, a fanfare on arriving where there is one, and crossfades between places.
 */
export class MusicPlayer {
	private enabledValue = readEnabled();
	private applied: MusicTarget = { set: 0, intro: 0 };
	private pending: MusicTarget | null = null;
	private pendingSince = 0;
	private readonly voices: Voice[] = [];
	private current: Voice | null = null;
	/** What the current track is, for the HUD. */
	private title = '';
	/** When the next track may start (ms), or Infinity while one plays or loads. */
	private nextAt = 0;
	private lastFile = 0;
	private token = 0;
	private readonly introPlayed = new Map<number, number>();
	private readonly urls = new Map<number, string>();
	/** Set when the browser refused to start audio before any user gesture. */
	private blocked = false;
	/** Files that must keep their URL (looping sounds), whatever the cache holds. */
	private readonly pinned = new Set<number>();
	/** Music runs through a low-pass filter, so it can sound muffled from under water. */
	private readonly filter: { context: AudioContext; node: BiquadFilterNode } | null = null;

	constructor(private readonly storage: AsyncStorageApi, readonly data: MusicData) {
		// Without Web Audio, music just isn't muffled.
		const context = audioContext();
		if (context) {
			const node = context.createBiquadFilter();
			node.type = 'lowpass';
			node.frequency.value = CLEAR;
			node.connect(context.destination);
			this.filter = { context, node };
		}
		const unblock = () => {
			if (!this.blocked) return;
			this.blocked = false;
			for (const v of this.voices) void v.audio.play().catch(() => (this.blocked = true));
		};
		window.addEventListener('pointerdown', unblock);
		window.addEventListener('keydown', unblock);
	}

	get enabled(): boolean {
		return this.enabledValue;
	}

	set enabled(on: boolean) {
		this.enabledValue = on;
		try {
			localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
		} catch {
			// Storage can be unavailable (private windows); the setting just isn't remembered.
		}
		if (on) {
			this.nextAt = 0;
		} else {
			this.token++;
			this.fadeOutCurrent();
		}
	}

	/** Muffles the music (from under water) or clears it, over a moment. */
	set muffled(on: boolean) {
		if (!this.filter) return;
		this.filter.node.frequency.setTargetAtTime(on ? MUFFLED : CLEAR, this.filter.context.currentTime, 0.12);
	}

	/** Shown in the HUD. */
	get status(): string {
		if (!this.enabledValue) return 'off';
		if (this.blocked) return 'click to start';
		const set = this.data.sets[this.applied.set];
		if (!set) return 'none here';
		return this.current ? this.title : `${set.name} (quiet)`;
	}

	/** Call every frame with where the camera is and whether it's night. */
	update(dt: number, now: number, want: MusicTarget, night: boolean): void {
		this.fade(dt);
		if (want.set !== this.applied.set || want.intro !== this.applied.intro) {
			if (!this.pending || this.pending.set !== want.set || this.pending.intro !== want.intro) {
				this.pending = want;
				this.pendingSince = now;
			}
			// The first place starts at once; later changes wait to settle.
			if ((this.applied.set === 0 && !this.current) || now - this.pendingSince > SETTLE) this.apply(want, now);
		} else {
			this.pending = null;
		}
		if (!this.enabledValue || now < this.nextAt) return;
		const set = this.data.sets[this.applied.set];
		if (!set) return;
		this.nextAt = Infinity;
		void this.play(pick(tracksFor(set, night), this.lastFile), set.name, () => now + randomBetween(GAP));
	}

	private apply(want: MusicTarget, now: number): void {
		const setChanged = want.set !== this.applied.set;
		const introChanged = want.intro !== this.applied.intro;
		this.applied = want;
		this.pending = null;
		if (!this.enabledValue) return;
		const intro = this.data.intros[want.intro];
		const lastIntro = this.introPlayed.get(want.intro) ?? -Infinity;
		if (intro && introChanged && now - lastIntro > intro.minDelay * 60000) {
			this.introPlayed.set(want.intro, now);
			this.token++;
			this.fadeOutCurrent();
			this.nextAt = Infinity;
			void this.play(pick(intro.files, 0), intro.name, () => performance.now() + AFTER_INTRO);
		} else if (setChanged) {
			this.token++;
			this.fadeOutCurrent();
			// Straight into the new place's music.
			this.nextAt = now;
		}
	}

	/** Starts a track; when it ends, the next may start at the time `after` gives. */
	private async play(file: number, title: string, after: () => number): Promise<void> {
		if (!file) {
			this.nextAt = after();
			return;
		}
		const token = ++this.token;
		let url: string;
		try {
			url = await this.soundUrl(file);
		} catch (e) {
			console.warn(`Music ${file}:`, e);
			if (token === this.token) this.nextAt = after();
			return;
		}
		if (token !== this.token || !this.enabledValue) return;
		this.fadeOutCurrent();
		const audio = newAudio(url, this.filter?.node);
		const voice: Voice = { audio, target: 1, level: 0 };
		this.voices.push(voice);
		this.current = voice;
		this.title = title;
		this.lastFile = file;
		audio.addEventListener('ended', () => {
			if (this.current !== voice) return;
			this.current = null;
			this.nextAt = after();
		});
		audio.play().then(() => (this.blocked = false), () => (this.blocked = true));
	}

	/**
	 * An object URL for a sound file from the install (MP3 or Ogg). Recent ones are kept; pin
	 * keeps a file's URL for good, for sounds that loop.
	 */
	async soundUrl(file: number, pin = false): Promise<string> {
		if (pin) this.pinned.add(file);
		const cached = this.urls.get(file);
		if (cached) {
			this.urls.delete(file);
			this.urls.set(file, cached);
			return cached;
		}
		const bytes = await this.storage.loadSound(file);
		const ogg = bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53; // 'OggS'
		const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: ogg ? 'audio/ogg' : 'audio/mpeg' }));
		this.urls.set(file, url);
		if (this.urls.size > URL_CACHE) {
			const [oldest, oldUrl] = this.urls.entries().next().value!;
			// Still playing (or fading) tracks keep their URL.
			if (!this.pinned.has(oldest) && !this.voices.some((v) => v.audio.src === oldUrl)) {
				URL.revokeObjectURL(oldUrl);
				this.urls.delete(oldest);
			}
		}
		return url;
	}

	private fadeOutCurrent(): void {
		if (this.current) this.current.target = 0;
		this.current = null;
	}

	private fade(dt: number): void {
		for (let i = this.voices.length - 1; i >= 0; i--) {
			const v = this.voices[i];
			v.level = v.target > v.level ? Math.min(v.target, v.level + dt / FADE_IN) : Math.max(v.target, v.level - dt / FADE_OUT);
			setLevel(v.audio, v.level * v.level * VOLUME * volume('music'));
			if (v.target === 0 && v.level === 0) {
				stopAudio(v.audio);
				this.voices.splice(i, 1);
			}
		}
	}
}

/** Whether music and sound were last turned on (remembered between visits). */
export function readEnabled(): boolean {
	try {
		// Muted until turned on; after that the choice is remembered.
		return localStorage.getItem(STORAGE_KEY) === '1';
	} catch {
		return false;
	}
}

function tracksFor(set: MusicSet, night: boolean): number[] {
	const list = night ? set.night : set.day;
	return list.length ? list : night ? set.day : set.night;
}

/** A random entry, avoiding `last` when there's a choice. */
function pick(list: number[], last: number): number {
	const choices = list.length > 1 ? list.filter((f) => f !== last) : list;
	return choices[Math.floor(Math.random() * choices.length)] ?? 0;
}

const randomBetween = ([a, b]: [number, number]) => a + Math.random() * (b - a);
