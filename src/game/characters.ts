import type { QuestSave } from './quests';
import type { CharacterLook } from '../viewer/character';

export interface CharacterSave {
	cls: number;
	level: number;
	xp: number;
	money: number;
	quests: QuestSave;
	learned?: string[];
	look?: CharacterLook;
}
export interface CharacterSlot { id: string; name: string; state: CharacterSave }
export interface SaveStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const KEY = 'mapExplorer.characters';
const LEGACY = 'mapExplorer.adventure';
const cleanName = (name: string) => [...name.replace(/[\p{C}]/gu, '').trim()].slice(0, 24).join('') || 'Adventurer';
const valid = (state: unknown): state is CharacterSave => !!state && typeof state === 'object' && Number.isInteger((state as CharacterSave).cls) && Number.isFinite((state as CharacterSave).level) && !!(state as CharacterSave).quests;
const initial = (): CharacterSave => ({ cls: 1, level: 1, xp: 0, money: 0, quests: { active: [], done: [], bag: {} } });

/** Separate persistent slots, with a non-destructive migration of the old single character. */
export class CharacterRoster {
	private slots: CharacterSlot[] = [];
	private active = '';
	constructor(private storage: SaveStorage | null) {
		try {
			const saved = JSON.parse(storage?.getItem(KEY) ?? 'null');
			if (saved?.version === 1 && Array.isArray(saved.slots)) {
				this.slots = saved.slots.filter((s: CharacterSlot) => typeof s.id === 'string' && typeof s.name === 'string' && valid(s.state));
				this.active = saved.active;
			}
		} catch { /* Keep an unreadable save untouched until a real save is made. */ }
		if (!this.slots.length) {
			let legacy: CharacterSave | null = null;
			try { const value = JSON.parse(storage?.getItem(LEGACY) ?? 'null'); if (valid(value)) legacy = value; } catch { /* New player. */ }
			this.slots = [{ id: 'original', name: 'Adventurer', state: legacy ?? initial() }];
		}
		if (!this.slots.some((s) => s.id === this.active)) this.active = this.slots[0].id;
	}
	get current(): CharacterSlot { return structuredClone(this.slots.find((s) => s.id === this.active)!); }
	list(): CharacterSlot[] { this.refresh(); return structuredClone(this.slots); }
	private refresh(): void {
		try {
			const other = JSON.parse(this.storage?.getItem(KEY) ?? 'null');
			if (other?.version !== 1 || !Array.isArray(other.slots)) return;
			for (const slot of other.slots as CharacterSlot[]) {
				if (slot.id === this.active || typeof slot.id !== 'string' || typeof slot.name !== 'string' || !valid(slot.state)) continue;
				const index = this.slots.findIndex((s) => s.id === slot.id);
				if (index < 0) this.slots.push(slot); else this.slots[index] = slot;
			}
		} catch { /* The current session is still available. */ }
	}
	private persist(): void {
		try { this.storage?.setItem(KEY, JSON.stringify({ version: 1, active: this.active, slots: this.slots })); } catch { /* Session remains playable if storage is unavailable or full. */ }
	}
	update(name: string, state: CharacterSave): void {
		this.refresh();
		const slot = this.slots.find((s) => s.id === this.active)!;
		slot.name = cleanName(name);
		slot.state = structuredClone(state);
		this.persist();
	}
	create(name: string, state: CharacterSave): string {
		this.refresh();
		const id = `character-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		this.slots.push({ id, name: cleanName(name), state: structuredClone(state) });
		this.active = id;
		this.persist();
		return id;
	}
	select(id: string): boolean {
		this.refresh();
		if (!this.slots.some((s) => s.id === id)) return false;
		this.active = id;
		this.persist();
		return true;
	}
}

export function characterStorage(): SaveStorage | null {
	try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
