import { CLASSES } from '../game/classes';
import { questText, type Giver } from '../game/quests';
import { money, questXp, sideOf } from '../game/rules';
import type { AsyncStorageApi } from '../worker/protocol';
import { isTyping } from './typing';
import type { Viewer } from './viewer';

/** The Adventure menu and the screen while playing it: frames, bars, quests (see adventure.ts). */

const ON_KEY = 'mapExplorer.adventureOn';
const MESSAGE_TIME = 4000;
/** Walking this far from a quest giver (yards) closes its dialog. */
const TALK_RANGE = 12;
const RACE_NAMES: Record<number, string> = { 1: 'Human', 2: 'Orc', 3: 'Dwarf', 4: 'Night Elf', 5: 'Undead', 6: 'Tauren', 7: 'Gnome', 8: 'Troll', 9: 'Goblin', 10: 'Blood Elf' };
const ATTACK_ICON = 'inv_sword_04';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	Object.assign(e, props);
	e.append(...children);
	return e;
}

function setBar(bar: Element, value: number, max: number, text = `${Math.round(value)} / ${Math.round(max)}`): void {
	(bar.querySelector('i') as HTMLElement).style.width = `${max > 0 ? Math.max(0, Math.min(100, (100 * value) / max)) : 0}%`;
	(bar.querySelector('b') as HTMLElement).textContent = text;
}

export function setUpAdventure(viewer: Viewer, storage: AsyncStorageApi): void {
	const adventure = viewer.adventure;
	if (!adventure) return;
	const on = $<HTMLInputElement>('adventure-on');
	const classSelect = $<HTMLSelectElement>('adventure-class');
	const hud = $('adventure-hud');
	const dialog = $('quest-dialog');
	const messages = $('adventure-messages');
	const floats = $('floats');
	const bar = $('action-bar');

	// --- The menu ---
	classSelect.replaceChildren(...CLASSES.map((c) => new Option(c.name, String(c.id))));
	classSelect.value = String(adventure.cls.id);
	classSelect.addEventListener('change', () => {
		const cls = Number(classSelect.value);
		if (cls === adventure.cls.id) return;
		if (adventure.level > 1 || (adventure.quests?.log.length ?? 0) > 0) {
			if (!confirm(`Start a new ${classSelect.selectedOptions[0].text} at level 1? Your level ${adventure.level} ${adventure.cls.name} and its quests are lost.`)) {
				classSelect.value = String(adventure.cls.id);
				return;
			}
		}
		adventure.newCharacter(cls);
	});
	$('adventure-new').addEventListener('click', () => {
		if (confirm('Start again at level 1 without quests? This character is lost.')) adventure.newCharacter(Number(classSelect.value));
	});
	try {
		on.checked = localStorage.getItem(ON_KEY) === '1';
	} catch {
		// Off.
	}
	const apply = () => {
		adventure.setEnabled(on.checked);
		try {
			localStorage.setItem(ON_KEY, on.checked ? '1' : '0');
		} catch {
			// Not remembered.
		}
	};
	on.addEventListener('change', apply);
	apply();
	try {
		const together = JSON.parse(localStorage.getItem('mapExplorer.together') ?? '{}') as { name?: string };
		if (typeof together.name === 'string' && together.name) adventure.name = together.name;
	} catch {
		// Adventurer.
	}

	// --- Messages ---
	adventure.onMessage = (text, error) => {
		const line = el('div', { textContent: text, className: error ? 'error' : '' });
		messages.append(line);
		while (messages.children.length > 4) messages.firstElementChild!.remove();
		setTimeout(() => (line.style.opacity = '0'), MESSAGE_TIME - 600);
		setTimeout(() => line.remove(), MESSAGE_TIME);
	};

	// --- Action bar ---
	const icons = new Map<string, string>();
	const loadIcons = async () => {
		const names = [ATTACK_ICON, ...adventure.abilities.map((a) => a.icon)].filter((n) => !icons.has(n));
		if (!names.length) return;
		const images = await storage.loadInterfaceImages(names.map((n) => `interface/icons/${n}.blp`));
		names.forEach((n, i) => {
			const image = images[i];
			if (!image) return icons.set(n, '');
			const canvas = el('canvas', { width: image.width, height: image.height });
			const rgba = new Uint8ClampedArray(image.rgba);
			// Icons are opaque; their files carry no alpha (read as 0).
			for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
			canvas.getContext('2d')!.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
			icons.set(n, canvas.toDataURL());
		});
		buildBar();
	};
	let slots: { button: HTMLButtonElement; cooldown: HTMLElement; ability: (typeof adventure.abilities)[number] | null }[] = [];
	const buildBar = () => {
		const entries = [null, ...adventure.abilities];
		slots = entries.map((ability, i) => {
			const name = ability?.name ?? 'Attack';
			const icon = icons.get(ability?.icon ?? ATTACK_ICON);
			const cooldown = el('span', { className: 'cooldown', hidden: true });
			const button = el('button', { title: ability ? `${name} (level ${ability.level})` : 'Attack: start or stop hitting your target' }, el('span', { className: 'key', textContent: String(i + 1) }), cooldown);
			if (icon) button.style.backgroundImage = `url(${icon})`;
			else button.append(el('span', { className: 'label', textContent: name }));
			button.addEventListener('click', () => adventure.use(i));
			return { button, cooldown, ability };
		});
		bar.replaceChildren(...slots.map((s) => s.button));
	};

	// --- Keys: in capture, ahead of the emotes on the number keys and the world map on Tab ---
	window.addEventListener('keydown', (e) => {
		if (!adventure.enabled || !viewer.walking || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
		const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
		if (digit && !e.shiftKey) {
			e.preventDefault();
			e.stopImmediatePropagation();
			if (!e.repeat) adventure.use(Number(digit) - 1);
		} else if (e.code === 'Tab') {
			e.preventDefault();
			e.stopImmediatePropagation();
			adventure.tabTarget();
		} else if (e.code === 'Escape' && !dialog.hidden) {
			dialog.hidden = true;
		}
	}, { capture: true });

	$('release').addEventListener('click', () => adventure.release());

	// --- Quests: the dialog with a giver ---
	let talking: { kind: Giver; entry: number; at: { x: number; z: number } } | null = null;
	const who = () => ({ name: adventure.name, className: adventure.cls.name, raceName: RACE_NAMES[viewer.look.race] ?? 'Adventurer', female: viewer.look.sex === 1 });
	const text = (t: string) => questText(t, who());
	const rewards = (id: number, choose: boolean): HTMLElement[] => {
		const q = adventure.quests!.quest(id)!;
		const data = adventure.quests!.data;
		const out: HTMLElement[] = [];
		const xp = questXp(q.xp || 0, q.lv, adventure.level);
		if (q.choice.length) {
			out.push(el('h3', { textContent: choose ? 'Choose your reward' : 'You will be able to choose one of these' }));
			q.choice.forEach(([item, n], i) => {
				const label = `${data.items[item] ?? 'Item'}${n > 1 ? ` ×${n}` : ''}`;
				if (!choose) return void out.push(el('div', { textContent: label }));
				const radio = el('input', { type: 'radio', name: 'quest-choice', value: String(i), checked: i === 0 });
				out.push(el('label', {}, radio, ` ${label}`));
			});
		}
		const fixed = q.rew.map(([item, n]) => `${data.items[item] ?? 'Item'}${n > 1 ? ` ×${n}` : ''}`);
		if (fixed.length || q.money || xp) {
			out.push(el('h3', { textContent: 'You will receive' }));
			for (const f of fixed) out.push(el('div', { textContent: f }));
			if (q.money) out.push(el('div', { textContent: money(q.money) }));
			if (xp) out.push(el('div', { textContent: `${xp} experience` }));
		}
		return out;
	};
	const show = (title: string, body: HTMLElement[], buttons: HTMLButtonElement[]) => {
		$('quest-title').textContent = title;
		$('quest-body').replaceChildren(...body);
		$('quest-buttons').replaceChildren(...buttons);
		dialog.hidden = false;
	};
	const button = (label: string, action: () => void, primary = false) => {
		const b = el('button', { textContent: label, className: primary ? 'primary' : '' });
		b.addEventListener('click', action);
		return b;
	};
	const showList = (kind: Giver, entry: number, name: string) => {
		const book = adventure.quests;
		if (!book) return;
		const offered = book.offered(kind, entry, adventure.player);
		const back = book.handIns(kind, entry);
		const all = [...back.map((id) => ({ id, mark: book.complete(id) ? '?' : '…' })), ...offered.map((id) => ({ id, mark: '!' }))];
		if (all.length === 1) return open(all[0].id, kind, entry, name);
		show(name, [el('div', { className: 'quest-list' }, ...all.map(({ id, mark }) => button(`${mark === '…' ? '?' : mark} ${book.quest(id)?.t}`, () => open(id, kind, entry, name))))], [button('Goodbye', close)]);
	};
	const open = (id: number, kind: Giver, entry: number, name: string) => {
		const book = adventure.quests!;
		const q = book.quest(id)!;
		const back = () => showList(kind, entry, name);
		if (!book.isActive(id)) {
			return show(q.t, [el('p', { textContent: text(q.d) }), el('h3', { textContent: 'Quest objectives' }), el('p', { textContent: text(q.o) }), ...rewards(id, false)], [
				button('Accept', () => {
					adventure.accept(id);
					back();
				}, true),
				button('Decline', close),
			]);
		}
		if (!book.complete(id)) {
			const objectives = book.objectives(id).map((o) => el('div', { textContent: o.text, className: o.done ? 'muted' : '' }));
			return show(q.t, [el('p', { textContent: text(q.q || 'You haven’t finished yet.') }), ...objectives], [button('Goodbye', close)]);
		}
		show(q.t, [el('p', { textContent: text(q.r || q.q || 'Well done.') }), ...rewards(id, true)], [
			button('Complete quest', () => {
				const chosen = dialog.querySelector<HTMLInputElement>('input[name="quest-choice"]:checked');
				adventure.turnIn(id, chosen ? Number(chosen.value) : undefined);
				if (adventure.quests?.hasBusiness(kind, entry, adventure.player)) back();
				else close();
			}, true),
		]);
	};
	const close = () => {
		dialog.hidden = true;
		talking = null;
	};
	$('quest-close').addEventListener('click', close);
	adventure.onTalk = (kind, entry, name) => {
		const p = viewer.walkerPosition;
		talking = { kind, entry, at: { x: p.x, z: p.z } };
		showList(kind, entry, name);
	};

	// --- The quest log (menu) and tracker ---
	const showLog = () => {
		const book = adventure.quests;
		const log = $('quest-log');
		const tracker = $('quest-tracker');
		if (!book) {
			log.replaceChildren(el('li', { className: 'muted', textContent: adventure.enabled ? 'Loading…' : 'Turn Adventure on to see quests' }));
			tracker.replaceChildren();
			return;
		}
		const ids = book.log;
		log.replaceChildren(...(ids.length ? ids.map((id) => {
			const q = book.quest(id)!;
			const abandon = button('Abandon', () => adventure.abandon(id));
			return el('li', {}, el('strong', { textContent: `[${q.lv}] ${q.t}${book.complete(id) ? ' (complete)' : ''}` }), abandon, ...book.objectives(id).map((o) => el('div', { className: o.done ? 'muted' : '', textContent: o.text })));
		}) : [el('li', { className: 'muted', textContent: 'No quests yet: look for ! over people.' })]));
		tracker.replaceChildren(...ids.slice(0, 6).map((id) => {
			const q = book.quest(id)!;
			const done = book.complete(id);
			return el('div', {}, el('h4', { textContent: q.t }), ...(done ? [el('div', { className: 'done', textContent: 'Complete: hand it in' })] : book.objectives(id).filter((o) => !o.done).map((o) => el('div', { textContent: `- ${o.text}` }))));
		}));
		$('adventure-summary').textContent = `${adventure.name}: level ${adventure.level} ${adventure.cls.name} · ${money(adventure.money)}`;
	};
	adventure.onChange = () => {
		classSelect.value = String(adventure.cls.id);
		buildBar();
		void loadIcons();
		showLog();
	};
	adventure.onChange();

	// --- Every frame: the frames, bars, cooldowns, floating numbers ---
	const player = $('player-frame');
	const target = $('target-frame');
	const castBar = $('cast-bar');
	const floatSpans: HTMLSpanElement[] = [];
	const frame = () => {
		requestAnimationFrame(frame);
		const shown = adventure.enabled && viewer.walking;
		hud.hidden = !shown;
		if (!shown) {
			if (!dialog.hidden && !adventure.enabled) close();
			return;
		}
		player.querySelector('.unit-name')!.textContent = adventure.name;
		player.querySelector('.unit-level')!.textContent = String(adventure.level);
		setBar(player.querySelector('.health')!, adventure.hp, adventure.maxHp, `${Math.round(adventure.hp)} / ${adventure.maxHp}${adventure.shield ? ` (+${Math.round(adventure.shield)})` : ''}`);
		const power = player.querySelector('.power')!;
		power.className = `bar power ${adventure.cls.resource}`;
		setBar(power, adventure.power, adventure.maxPower);
		setBar($('xp-bar'), adventure.xp, adventure.xpNeeded, adventure.level >= 60 ? 'Level 60' : `XP ${adventure.xp} / ${adventure.xpNeeded}`);
		const t = adventure.targetInfo();
		target.hidden = !t;
		if (t) {
			const reaction = t.info.reaction?.[sideOf(viewer.look.race)] ?? 'neutral';
			target.className = `unit-frame ${reaction}`;
			target.querySelector('.unit-name')!.textContent = t.info.name;
			target.querySelector('.unit-level')!.textContent = t.level;
			setBar(target.querySelector('.health')!, t.hp, t.maxHp, t.dead ? 'Dead' : `${Math.round((100 * t.hp) / t.maxHp)}%`);
		}
		const cast = adventure.cast;
		castBar.hidden = !cast;
		if (cast) setBar(castBar, adventure.time - cast.start, cast.end - cast.start, cast.ability.name);
		$('death-box').hidden = adventure.alive;
		for (const [i, s] of slots.entries()) {
			s.button.classList.toggle('active', i === 0 && adventure.autoAttack);
			s.button.classList.toggle('locked', !!s.ability && s.ability.level > adventure.level);
			const left = s.ability ? adventure.cooldownLeft(s.ability) : 0;
			s.cooldown.hidden = left <= 0.05;
			s.cooldown.textContent = left > 1.5 ? String(Math.ceil(left)) : '';
		}
		// Floating numbers rise and fade over what was hit.
		adventure.floats.forEach((f, i) => {
			const span = (floatSpans[i] ??= floats.appendChild(el('span')));
			const at = viewer.screenPosition(f.at);
			span.hidden = !at;
			if (!at) return;
			span.textContent = f.text;
			span.style.color = f.color;
			span.style.left = `${at.x}px`;
			span.style.top = `${at.y - f.age * 40}px`;
			span.style.opacity = String(Math.max(0, 1 - f.age / 1.4));
		});
		for (let i = adventure.floats.length; i < floatSpans.length; i++) floatSpans[i].hidden = true;
		// Walked off: the giver's dialog closes.
		if (talking) {
			const p = viewer.walkerPosition;
			if (Math.hypot(p.x - talking.at.x, p.z - talking.at.z) > TALK_RANGE) close();
		}
	};
	requestAnimationFrame(frame);
}
