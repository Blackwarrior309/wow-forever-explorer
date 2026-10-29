/**
 * An emote the travel form can perform: the AnimationData sequence it plays, and how. Most play
 * once and go back to standing; some loop until stopped (dance); and some are a pose taken up
 * and held (sit, kneel, sleep), with sequences for getting down into it and back up.
 */
export interface Emote {
	/** Remembered in the hotkeys; never changes. */
	key: string;
	name: string;
	/** The sequence played (held, for a pose). */
	play: number;
	/** Loops until stopped rather than playing once. */
	loop?: boolean;
	/** For a pose: the sequences getting into it and out of it. */
	down?: number;
	up?: number;
	/** Played once and then held on its last frame until stopped (dying). */
	hold?: boolean;
}

/** Every emote, in the order they're listed. The race models all have these sequences built in. */
export const EMOTES: Emote[] = [
	{ key: 'wave', name: 'Wave', play: 67 },
	{ key: 'bow', name: 'Bow', play: 66 },
	{ key: 'cheer', name: 'Cheer', play: 68 },
	{ key: 'dance', name: 'Dance', play: 69, loop: true },
	{ key: 'laugh', name: 'Laugh', play: 70 },
	{ key: 'point', name: 'Point', play: 84 },
	{ key: 'salute', name: 'Salute', play: 113 },
	{ key: 'applaud', name: 'Applaud', play: 80 },
	{ key: 'sit', name: 'Sit', play: 97, down: 96, up: 98 },
	{ key: 'sleep', name: 'Sleep', play: 100, down: 99, up: 101 },
	{ key: 'kneel', name: 'Kneel', play: 115, down: 114, up: 116 },
	{ key: 'flex', name: 'Flex', play: 82 },
	{ key: 'roar', name: 'Roar', play: 74 },
	{ key: 'shout', name: 'Shout', play: 81 },
	{ key: 'talk', name: 'Talk', play: 60 },
	{ key: 'exclaim', name: 'Exclaim', play: 64 },
	{ key: 'question', name: 'Question', play: 65 },
	{ key: 'kiss', name: 'Kiss', play: 76 },
	{ key: 'cry', name: 'Cry', play: 77 },
	{ key: 'shy', name: 'Shy', play: 83 },
	{ key: 'beg', name: 'Beg', play: 79 },
	{ key: 'rude', name: 'Rude', play: 73 },
	{ key: 'chicken', name: 'Chicken', play: 78 },
	{ key: 'work', name: 'Work', play: 62, loop: true },
];

/**
 * What fighting plays, through the same machinery as the emotes (see adventure.ts); not on the
 * Emotes menu. A model lacking an attack plays the next one listed.
 */
export const ACTIONS = {
	attack: [17, 16, 18].map((play) => ({ key: 'attack', name: 'Attack', play })),
	cast: { key: 'cast', name: 'Cast', play: 53 },
	precast: { key: 'precast', name: 'Casting', play: 51, loop: true },
	wound: { key: 'wound', name: 'Wound', play: 9 },
	death: { key: 'death', name: 'Death', play: 1, hold: true },
} satisfies Record<string, Emote | Emote[]>;

/** Every action's sequence, sampled with the emotes'. */
export const ACTION_CLIPS: number[] = Object.values(ACTIONS).flat().map((e) => e.play);

/** Every sequence the emotes play, for the travel form to sample. */
export const EMOTE_CLIPS: number[] = [...new Set(EMOTES.flatMap((e) => [e.play, e.down, e.up].filter((id): id is number => id !== undefined)))];

/** The emotes on the number keys 1 to 9 and 0 to begin with. */
export const DEFAULT_EMOTE_KEYS: string[] = ['wave', 'bow', 'cheer', 'dance', 'laugh', 'point', 'salute', 'applaud', 'sit', 'sleep'];

/** A pose taken up and held, rather than an emote that plays. */
export const isPose = (e: Emote): boolean => e.down !== undefined || e.up !== undefined;
