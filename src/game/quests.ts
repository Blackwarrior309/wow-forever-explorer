import { raceBit } from './rules';

/** public/game/quests.json (tools/buildGame.ts): quest texts, objectives and who gives them. */
export interface QuestData {
	xp: number[];
	quests: Record<number, Quest>;
	/** Quest IDs started and ended by creatures (c) and game objects (o), by entry. */
	starts: { c: Record<number, number[]>; o: Record<number, number[]> };
	ends: { c: Record<number, number[]>; o: Record<number, number[]> };
	/** Quest items dropped by creatures (c) and found in game objects (o): [item, chance %]. */
	drops: { c: Record<number, [number, number][]>; o: Record<number, [number, number][]> };
	items: Record<number, string>;
	/** Names of creatures (c) and game objects (o) quests ask for. */
	names: { c: Record<number, string>; o: Record<number, string> };
}

export interface Quest {
	/** Title, details, objectives, offer-reward and request-items texts. */
	t: string; d: string; o: string; r: string; q: string;
	lv: number; min: number; races: number; prev: number; next: number; xp: number; money: number;
	/** [creature entry, count] to kill, [game object entry, count] to use, [item, count] to bring. */
	kill: [number, number][]; use: [number, number][]; items: [number, number][];
	rew: [number, number][]; choice: [number, number][];
	/** Texts that replace the objectives' own names, by objective. */
	ot: string[];
}

export type Giver = 'c' | 'o';

/** A quest taken: kills and uses so far, by objective. */
export interface Progress {
	id: number;
	kills: number[];
	uses: number[];
}

/** What's kept between visits. */
export interface QuestSave {
	active: Progress[];
	done: number[];
	/** Quest items carried: item -> count. */
	bag: Record<number, number>;
}

export interface Player {
	level: number;
	race: number;
}

/** What a quest giver shows over its head: '!' quests to take, '?' quests to hand in, '…' quests under way. */
export type Marker = '!' | '?' | '…' | null;

/** The most quests taken at once, as in the game. */
export const MAX_ACTIVE = 20;

/**
 * The player's quests: which can be taken, what has been done toward them, handing them in.
 * Pure state; the page saves snapshot() and shows the messages returned.
 */
export class QuestBook {
	private readonly active = new Map<number, Progress>();
	private readonly done = new Set<number>();
	private readonly bag = new Map<number, number>();

	constructor(readonly data: QuestData, save?: Partial<QuestSave>) {
		for (const p of save?.active ?? []) {
			const q = data.quests[p.id];
			if (q) this.active.set(p.id, { id: p.id, kills: q.kill.map((_, i) => p.kills?.[i] ?? 0), uses: q.use.map((_, i) => p.uses?.[i] ?? 0) });
		}
		for (const id of save?.done ?? []) this.done.add(id);
		for (const [item, count] of Object.entries(save?.bag ?? {})) if (count > 0) this.bag.set(Number(item), count);
	}

	snapshot(): QuestSave {
		return { active: [...this.active.values()], done: [...this.done], bag: Object.fromEntries(this.bag) };
	}

	quest(id: number): Quest | undefined {
		return this.data.quests[id];
	}

	get log(): number[] {
		return [...this.active.keys()];
	}

	isActive(id: number): boolean {
		return this.active.has(id);
	}

	isDone(id: number): boolean {
		return this.done.has(id);
	}

	/** Whether the player may take a quest now: level, side, the quest before it, not taken or done. */
	canTake(id: number, player: Player): boolean {
		const q = this.data.quests[id];
		if (!q || this.active.has(id) || this.done.has(id)) return false;
		if (player.level < q.min) return false;
		if (q.races && !(q.races & raceBit(player.race))) return false;
		if (q.prev > 0 && !this.done.has(q.prev)) return false;
		if (q.prev < 0 && !this.active.has(-q.prev) && !this.done.has(-q.prev)) return false;
		return true;
	}

	/** Quests this giver offers the player now. */
	offered(kind: Giver, entry: number, player: Player): number[] {
		return (this.data.starts[kind][entry] ?? []).filter((id) => this.canTake(id, player));
	}

	/** Taken quests this giver takes back: complete ones first. */
	handIns(kind: Giver, entry: number): number[] {
		return (this.data.ends[kind][entry] ?? []).filter((id) => this.active.has(id)).sort((a, b) => Number(this.complete(b)) - Number(this.complete(a)));
	}

	marker(kind: Giver, entry: number, player: Player): Marker {
		const back = this.handIns(kind, entry);
		if (back.some((id) => this.complete(id))) return '?';
		if (this.offered(kind, entry, player).length) return '!';
		return back.length ? '…' : null;
	}

	/** Whether a giver has anything for the player (offers or hand-ins). */
	hasBusiness(kind: Giver, entry: number, player: Player): boolean {
		return this.marker(kind, entry, player) !== null;
	}

	/** Takes a quest; the reason it can't, or null. */
	accept(id: number, player: Player): string | null {
		if (!this.canTake(id, player)) return 'You can’t take that quest now';
		if (this.active.size >= MAX_ACTIVE) return 'Your quest log is full';
		const q = this.data.quests[id];
		this.active.set(id, { id, kills: q.kill.map(() => 0), uses: q.use.map(() => 0) });
		return null;
	}

	abandon(id: number): void {
		this.active.delete(id);
	}

	/** How far each objective has got: text and whether it's met. */
	objectives(id: number): { text: string; done: boolean }[] {
		const q = this.data.quests[id];
		const p = this.active.get(id);
		if (!q || !p) return [];
		const named = (i: number, name: string) => q.ot[i] || name;
		return [
			...q.kill.map(([entry, need], i) => ({ text: `${named(i, `${this.data.names.c[entry] || 'Creature'} slain`)}: ${Math.min(p.kills[i], need)}/${need}`, done: p.kills[i] >= need })),
			...q.use.map(([entry, need], i) => ({ text: `${named(q.kill.length + i, this.data.names.o[entry] || 'Object')}: ${Math.min(p.uses[i], need)}/${need}`, done: p.uses[i] >= need })),
			...q.items.map(([item, need]) => ({ text: `${this.data.items[item] || 'Item'}: ${Math.min(this.bag.get(item) ?? 0, need)}/${need}`, done: (this.bag.get(item) ?? 0) >= need })),
		];
	}

	complete(id: number): boolean {
		return this.objectives(id).every((o) => o.done);
	}

	/** A creature was killed by (or with) the player: kill credit and quest drops. Returns what to tell the player. */
	killed(entry: number, roll: () => number = Math.random): string[] {
		const said: string[] = [];
		for (const p of this.active.values()) {
			const q = this.data.quests[p.id];
			q.kill.forEach(([e, need], i) => {
				if (e !== entry || p.kills[i] >= need) return;
				p.kills[i]++;
				said.push(`${q.ot[i] || `${this.data.names.c[e] || 'Creature'} slain`}: ${p.kills[i]}/${need}`);
			});
		}
		return [...said, ...this.loot('c', entry, roll)];
	}

	/** A game object was used: use credit and what quest items it held. */
	used(entry: number, roll: () => number = Math.random): string[] {
		const said: string[] = [];
		for (const p of this.active.values()) {
			const q = this.data.quests[p.id];
			q.use.forEach(([e, need], i) => {
				if (e !== entry || p.uses[i] >= need) return;
				p.uses[i]++;
				said.push(`${q.ot[q.kill.length + i] || this.data.names.o[e] || 'Object'}: ${p.uses[i]}/${need}`);
			});
		}
		return [...said, ...this.loot('o', entry, roll)];
	}

	/** Whether using a game object would do anything for a quest under way (so it's worth clicking). */
	useful(entry: number): boolean {
		for (const p of this.active.values()) {
			const q = this.data.quests[p.id];
			if (q.use.some(([e, need], i) => e === entry && p.uses[i] < need)) return true;
		}
		return (this.data.drops.o[entry] ?? []).some(([item]) => this.wanted(item) > 0);
	}

	/** How many more of an item quests under way still need. */
	private wanted(item: number): number {
		let need = 0;
		for (const p of this.active.values()) for (const [i, n] of this.data.quests[p.id].items) if (i === item) need = Math.max(need, n);
		return need - (this.bag.get(item) ?? 0);
	}

	/** Rolls a source's quest drops the player still needs. */
	private loot(kind: Giver, entry: number, roll: () => number): string[] {
		const said: string[] = [];
		for (const [item, chance] of this.data.drops[kind][entry] ?? []) {
			if (this.wanted(item) <= 0 || roll() * 100 >= chance) continue;
			const count = (this.bag.get(item) ?? 0) + 1;
			this.bag.set(item, count);
			const need = count + this.wanted(item);
			said.push(`${this.data.items[item] || 'Item'}: ${count}/${need}`);
		}
		return said;
	}

	/**
	 * Hands a complete quest in: its items are given up and it's done. Returns its rewards (the
	 * experience before any reduction for level), or null if it isn't complete.
	 */
	turnIn(id: number, choice?: number): { xp: number; money: number; items: string[] } | null {
		const q = this.data.quests[id];
		if (!q || !this.active.has(id) || !this.complete(id)) return null;
		for (const [item, need] of q.items) {
			const left = (this.bag.get(item) ?? 0) - need;
			if (left > 0) this.bag.set(item, left);
			else this.bag.delete(item);
		}
		this.active.delete(id);
		this.done.add(id);
		const chosen = choice !== undefined ? q.choice[choice] : q.choice[0];
		const items = [...q.rew, ...(chosen ? [chosen] : [])].map(([item, n]) => `${this.data.items[item] || 'Item'}${n > 1 ? ` ×${n}` : ''}`);
		return { xp: q.xp || defaultXp(q.lv), money: q.money, items };
	}
}

/** Quests without a set reward get vanilla's rough one for their level. */
function defaultXp(level: number): number {
	return Math.round(Math.max(1, level) * 40 + 50);
}

/**
 * Quest text with the client's codes filled in: $N name, $C class, $R race, $B line break,
 * $Gmale:female; by sex. Line breaks become \n.
 */
export function questText(text: string, who: { name: string; className: string; raceName: string; female: boolean }): string {
	return text
		.replace(/\$[Bb]/g, '\n')
		.replace(/\$[Gg]\s*([^:;]*):([^;]*);/g, (_, male: string, female: string) => (who.female ? female : male).trim())
		.replace(/\$[Nn]/g, who.name)
		.replace(/\$[Cc]/g, who.className)
		.replace(/\$[Rr]/g, who.raceName);
}
