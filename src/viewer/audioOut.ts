/**
 * Where every sound plays out: one Web Audio context, each sound through its own gain node.
 * Safari ignores an audio element's volume (it is read-only on WebKit), so levels are set on
 * the gain node; without Web Audio, or before the page is allowed to start it, they fall back
 * to the element's volume.
 */

let context: AudioContext | null = null;
try {
	context = new AudioContext();
} catch {
	// No Web Audio: element volumes only.
}

/** Whether this page may be heard: a viewer kept loaded out of sight isn't (see setHeard). */
let heard = true;
/** Every sound playing, so it can be silenced with the page. */
const playing = new Set<HTMLAudioElement>();

// The browser keeps the context suspended until the page is clicked or a key is pressed.
const resume = () => {
	if (heard) void context?.resume();
};
window.addEventListener('pointerdown', resume);
window.addEventListener('keydown', resume);

const gains = new WeakMap<HTMLAudioElement, GainNode>();
/** The level last asked for: WebKit reads an element's volume back as 1 whatever was set. */
const levels = new WeakMap<HTMLAudioElement, number>();
/** Sounds made while the context was suspended, routed once it runs, with where they go. */
const waiting = new Map<HTMLAudioElement, AudioNode | undefined>();

context?.addEventListener('statechange', () => {
	if (context?.state !== 'running') return;
	for (const [audio, output] of waiting) {
		// Stopped meanwhile: nothing to route.
		if (audio.hasAttribute('src') && !audio.ended) route(audio, output);
	}
	waiting.clear();
});

function route(audio: HTMLAudioElement, output: AudioNode | undefined): void {
	const gain = context!.createGain();
	gain.gain.value = levels.get(audio) ?? 0;
	audio.volume = 1;
	context!.createMediaElementSource(audio).connect(gain).connect(output ?? context!.destination);
	gains.set(audio, gain);
	// One-off sounds let go of their nodes once done.
	audio.addEventListener('ended', () => {
		if (!audio.loop) gain.disconnect();
	});
}

/**
 * Lets the page be heard or silences it, sounds that play on their own (before the context
 * runs) too: off for a viewer loading or kept out of sight for quick switching.
 */
export function setHeard(on: boolean): void {
	heard = on;
	for (const audio of playing) audio.muted = !on;
	if (on) resume();
	else void context?.suspend();
}

/** The shared context, or null without Web Audio. */
export function audioContext(): AudioContext | null {
	return context;
}

/**
 * A new audio element playing url, silent until setLevel is called, through a gain node into
 * output (the speakers by default). While the context is suspended it plays on its own (routed,
 * it would be silent) and is routed once the context runs.
 */
export function newAudio(url: string, output?: AudioNode): HTMLAudioElement {
	const audio = new Audio(url);
	audio.volume = 0;
	audio.muted = !heard;
	playing.add(audio);
	audio.addEventListener('ended', () => {
		if (!audio.loop) playing.delete(audio);
	});
	if (context?.state === 'running') route(audio, output);
	else if (context) waiting.set(audio, output);
	return audio;
}

/** How loud a sound from newAudio plays, 0-1. */
export function setLevel(audio: HTMLAudioElement, level: number): void {
	level = Math.min(1, Math.max(0, level));
	levels.set(audio, level);
	const gain = gains.get(audio);
	if (gain) gain.gain.value = level;
	else audio.volume = level;
}

/** Stops a sound from newAudio for good and lets go of its file and nodes. */
export function stopAudio(audio: HTMLAudioElement): void {
	audio.pause();
	audio.removeAttribute('src');
	gains.get(audio)?.disconnect();
	waiting.delete(audio);
	playing.delete(audio);
}
