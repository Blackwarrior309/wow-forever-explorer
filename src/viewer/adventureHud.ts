import { CLASSES, type Ability } from '../game/classes';
import { questText, type Giver } from '../game/quests';
import { money, questXp, sideOf, weaponDamage } from '../game/rules';
import type { AsyncStorageApi } from '../worker/protocol';
import { setUpBooks } from './bookHud';
import { Icons } from './icons';
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
	window.addEventListener('pagehide', () => adventure.save());
	const icons = new Icons(storage);
	const books = setUpBooks(viewer, storage, icons, {
		describe: (a) => describe(a),
		use: (a) => {
			if (!adventure.enabled || !viewer.walking) return adventure.onMessage('Turn Adventure on and walk on the ground first', true);
			adventure.use(adventure.abilities.indexOf(a) + 1);
		},
		changed: () => adventure.onChange(),
	});
	$('spellbook-open').onclick = () => books.toggleSpellbook();
	$('talents-open').onclick = () => books.toggleTalents();
	const trainer = el('section', { id: 'trainer-dialog', className: 'panel adventure-window', hidden: true, role: 'dialog' });
	trainer.setAttribute('aria-label', 'Class trainer');
	const trainerTitle = el('h2');
	const trainerClose = el('button', { textContent: '×', title: 'Close trainer', className: 'plain' });
	trainerClose.setAttribute('aria-label', 'Close trainer');
	trainerClose.onclick = () => { trainer.hidden = true; };
	const trainerList = el('div');
	trainer.append(el('div', { className: 'quest-head' }, trainerTitle, trainerClose), trainerList);
	document.body.append(trainer);
	let trainerKey: string | null = null;
	const renderTrainer = () => {
		if (!trainerKey || trainer.hidden) return;
		const key = trainerKey;
		const problem = adventure.trainerProblem(key);
		trainerList.replaceChildren(el('p', { textContent: problem || `${adventure.cls.name} training · You have ${money(adventure.money)}. Training costs are simplified for Adventure.` }));
		if (problem) return;
		for (const ability of adventure.cls.abilities) {
			const why = adventure.trainingProblem(key, ability);
			const learn = el('button', { textContent: adventure.knows(ability) ? 'Learned' : `Learn · ${money(adventure.trainingCost(ability))}`, disabled: !!why, title: why || `Learn ${ability.name}` });
			learn.onclick = () => { adventure.train(key, ability.id); renderTrainer(); };
			trainerList.append(el('article', { className: 'spell-row' }, el('div', {}, el('strong', { textContent: ability.name }), el('small', { textContent: why || `Requires level ${ability.level}` })), learn));
		}
		const info = adventure.targetInfo(key)?.info;
		if (info && adventure.quests?.hasBusiness('c', info.entry, adventure.player)) {
			const quests = el('button', { textContent: 'Quests' });
			quests.onclick = () => { trainer.hidden = true; adventure.onTalk('c', info.entry, info.name); };
			trainerList.append(quests);
		}
	};
	adventure.onTrainer = (key, name) => { trainerKey = key; trainerTitle.textContent = name; books.close(); dialog.hidden = true; trainer.hidden = false; renderTrainer(); };

	// --- The menu ---
	classSelect.replaceChildren(...CLASSES.map((c) => new Option(c.name, String(c.id))));
	classSelect.value = String(adventure.cls.id);
	const characterSelect = $<HTMLSelectElement>('character-select');
	const characterName = $<HTMLInputElement>('character-name');
	characterSelect.addEventListener('change', () => {
		if (!adventure.selectCharacter(characterSelect.value)) characterSelect.value = adventure.characterId;
		trainer.hidden = dialog.hidden = true;
	});
	$('adventure-new').addEventListener('click', () => {
		if (!characterName.value.trim()) return adventure.onMessage('Enter a character name first', true);
		adventure.newCharacter(Number(classSelect.value), characterName.value);
		trainer.hidden = dialog.hidden = true;
	});
	$('character-rename').onclick = () => {
		if (!characterName.value.trim()) return adventure.onMessage('Enter a character name first', true);
		adventure.name = [...characterName.value.replace(/[\p{C}]/gu, '').trim()].slice(0, 24).join('');
		adventure.save(); adventure.onChange();
	};
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

	// --- Messages ---
	adventure.onMessage = (text, error) => {
		const line = el('div', { textContent: text, className: error ? 'error' : '' });
		messages.append(line);
		while (messages.children.length > 4) messages.firstElementChild!.remove();
		setTimeout(() => (line.style.opacity = '0'), MESSAGE_TIME - 600);
		setTimeout(() => line.remove(), MESSAGE_TIME);
	};

	// --- Action bar ---
	const loadIcons = () => icons.load([ATTACK_ICON, ...adventure.abilities.map((a) => a.icon)]).then(buildBar);
	// The bar holds Attack and the abilities learned, in the class's order; the number keys follow it.
	let slots: { button: HTMLButtonElement; cooldown: HTMLElement; ability: Ability | null }[] = [];
	const onBar = () => adventure.abilities.filter((a) => adventure.knows(a) && a.level <= adventure.level);
	const useSlot = (i: number) => {
		const slot = slots[i];
		if (slot) adventure.use(slot.ability ? adventure.abilities.indexOf(slot.ability) + 1 : 0);
	};
	const tip = $('spell-tooltip');
	const row = (left: string, right = '') => el('div', { className: 'row' }, el('span', { textContent: left }), el('span', { textContent: right }));
	/** What an ability does, with the numbers at the player's level. */
	const describe = (a: Ability): string => {
		const swing = weaponDamage(adventure.level);
		const range = (m: number) => `${Math.round(swing * m * 0.9)} to ${Math.round(swing * m * 1.1)}`;
		const who = a.aoe ? `all enemies within ${a.aoe} yards` : 'the target';
		const parts: string[] = [];
		if (a.damage) parts.push(`Deals ${range(a.damage)} damage to ${who}${a.drain ? ', healing you for as much' : ''}.`);
		if (a.dot) parts.push(`${a.damage ? 'Then causes' : 'Causes'} ${Math.round(swing * a.dot.total)} damage over ${a.dot.duration} sec.`);
		if (a.stun) parts.push(`Stuns ${who} for ${a.stun} sec.`);
		if (a.heal) parts.push(`Heals you for ${Math.round(adventure.maxHp * a.heal)}.`);
		if (a.hot) parts.push(`Heals you for ${Math.round(adventure.maxHp * a.hot.total)} over ${a.hot.duration} sec.`);
		if (a.shield) parts.push(`Absorbs ${Math.round(adventure.maxHp * a.shield)} damage.`);
		if (a.buff) parts.push(`Increases your damage by ${Math.round(a.buff.damage * 100)}% for ${a.buff.duration >= 60 ? `${a.buff.duration / 60} min` : `${a.buff.duration} sec`}.`);
		if (a.execute) parts.push(`Only usable on enemies with less than ${Math.round(a.execute * 100)}% health.`);
		return parts.join(' ');
	};
	const showTip = (a: Ability | null) => {
		if (!a) {
			tip.replaceChildren(el('div', { className: 'title', textContent: 'Attack' }), el('div', { className: 'desc', textContent: 'Starts or stops attacking your target with your weapon.' }));
		} else {
			const r = adventure.cls.resource;
			const cost = r === 'mana' ? `${Math.round(a.cost * adventure.maxPower)} Mana` : `${a.cost} ${r === 'rage' ? 'Rage' : 'Energy'}`;
			const reach = a.kind === 'melee' ? 'Melee Range' : a.kind === 'ranged' ? `${a.range ?? 30} yd range` : '';
			const lines = [el('div', { className: 'title', textContent: a.name }), row(cost, reach), row(a.cast ? `${a.cast} sec cast` : 'Instant', a.cooldown ? `${a.cooldown} sec cooldown` : '')];
			if (a.level > adventure.level) lines.push(el('div', { className: 'need', textContent: `Requires Level ${a.level}` }));
			else if (!adventure.knows(a)) lines.push(el('div', { className: 'need', textContent: 'Not learned: visit your class trainer' }));
			lines.push(el('div', { className: 'desc', textContent: a.text || describe(a) }));
			tip.replaceChildren(...lines);
		}
		tip.hidden = false;
	};
	const buildBar = () => {
		const entries = [null, ...onBar()];
		slots = entries.map((ability, i) => {
			const name = ability?.name ?? 'Attack';
			const icon = icons.get(ability?.icon ?? ATTACK_ICON);
			const cooldown = el('span', { className: 'cooldown', hidden: true });
			const button = el('button', { ariaLabel: name }, el('span', { className: 'glow' }), el('span', { className: 'key', textContent: i < 9 ? String(i + 1) : '' }), cooldown);
			if (icon) button.style.backgroundImage = `url(${icon})`;
			else button.append(el('span', { className: 'label', textContent: name }));
			button.addEventListener('click', () => useSlot(i));
			button.addEventListener('mouseenter', () => showTip(ability));
			button.addEventListener('mouseleave', () => (tip.hidden = true));
			return { button, cooldown, ability };
		});
		bar.replaceChildren(...slots.map((s) => s.button));
		tip.hidden = true;
	};

	// --- Keys: in capture, ahead of the emotes on the number keys and the world map on Tab ---
	window.addEventListener('keydown', (e) => {
		if (e.code === 'Escape' && !isTyping(e) && (!trainer.hidden || books.close())) { trainer.hidden = true; e.stopImmediatePropagation(); return; }
		if (adventure.enabled && (e.code === 'KeyP' || e.code === 'KeyN') && !isTyping(e) && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault(); e.stopImmediatePropagation();
			if (!e.repeat) (e.code === 'KeyP' ? books.toggleSpellbook() : books.toggleTalents());
			return;
		}
		if (!adventure.enabled || !viewer.walking || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
		const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
		if (digit && !e.shiftKey) {
			e.preventDefault();
			e.stopImmediatePropagation();
			if (!e.repeat) useSlot(Number(digit) - 1);
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
		characterSelect.replaceChildren(...adventure.characters.map((s) => new Option(`${s.name} · ${CLASSES.find((c) => c.id === s.state.cls)?.name ?? 'Warrior'} · ${s.state.level}`, s.id)));
		characterSelect.value = adventure.characterId;
		buildBar();
		void loadIcons();
		showLog();
		books.refresh();
		renderTrainer();
	};
	adventure.onChange();

	// --- Every frame: the frames, bars, cooldowns, floating numbers ---
	const player = $('player-frame');
	const target = $('target-frame');
	const castBar = $('cast-bar');
	const playerAuras = player.querySelector<HTMLElement>('.auras')!;
	const targetAuras = target.querySelector<HTMLElement>('.auras')!;
	/** Buff and debuff icons with the time they have left, reusing the elements from the last frame. */
	const showAuras = (row: HTMLElement, auras: ReturnType<typeof adventure.auras>) => {
		while (row.children.length > auras.length) row.lastElementChild!.remove();
		auras.forEach((a, i) => {
			let cell = row.children[i] as HTMLElement | undefined;
			if (!cell) row.append((cell = el('div', { className: 'aura' }, el('span'))));
			const icon = icons.get(a.ability.icon);
			cell.style.backgroundImage = icon ? `url(${icon})` : '';
			cell.classList.toggle('debuff', a.debuff);
			cell.title = `${a.ability.name}${Number.isFinite(a.left) ? ` · ${Math.ceil(a.left)} sec` : ''}`;
			const left = a.left;
			// Blinks in its last seconds, as the game's buffs do.
			cell.classList.toggle('ending', Number.isFinite(left) && left < 5);
			cell.firstElementChild!.textContent = !Number.isFinite(left) ? '' : left >= 60 ? `${Math.ceil(left / 60)} m` : `${Math.ceil(left)} s`;
		});
	};
	const playerPortrait = player.querySelector<HTMLImageElement>('.portrait')!;
	const targetPortrait = target.querySelector<HTMLImageElement>('.portrait')!;
	// Drawn once per look and kept: a 3D portrait takes a moment.
	const PORTRAIT_SIZE = 128;
	const pictures = new Map<string, Promise<string>>();
	const portrait = (img: HTMLImageElement, key: string, draw: () => Promise<Blob | null>) => {
		if (img.dataset.key === key) return;
		img.dataset.key = key;
		if (!pictures.has(key)) pictures.set(key, draw().then((b) => (b ? URL.createObjectURL(b) : '')).catch(() => ''));
		void pictures.get(key)!.then((url) => {
			if (img.dataset.key === key) img.src = url || '';
			img.style.visibility = url ? '' : 'hidden';
		});
	};
	const floatSpans: HTMLSpanElement[] = [];
	const frame = () => {
		requestAnimationFrame(frame);
		const shown = adventure.enabled && viewer.walking;
		if (!trainer.hidden && trainerKey && adventure.trainerProblem(trainerKey)) trainer.hidden = true;
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
			const rank = t.info.rank === 'Rare' ? 'rare' : t.info.rank ? 'elite' : '';
			target.className = `unit-frame ${reaction} ${rank} ${t.dead ? 'dead' : ''}`;
			target.querySelector('.unit-name')!.textContent = t.info.name;
			target.querySelector('.unit-level')!.textContent = t.info.rank === 'Boss' ? '??' : t.level;
			setBar(target.querySelector('.health')!, t.hp, t.maxHp, t.dead ? 'Dead' : `${Math.round((100 * t.hp) / t.maxHp)}%`);
			setBar(target.querySelector('.power')!, 0, 1, '');
			const look = adventure.targetLook();
			if (look) portrait(targetPortrait, `c${look.displayId}:${look.variant ?? ''}`, () => viewer.portraits().drawCreature(look.displayId, look.variant, PORTRAIT_SIZE, PORTRAIT_SIZE));
		}
		showAuras(playerAuras, adventure.auras('player'));
		showAuras(targetAuras, t && adventure.target ? adventure.auras(adventure.target) : []);
		portrait(playerPortrait, `p${JSON.stringify(viewer.look)}`, () => viewer.portraits().draw(viewer.look, PORTRAIT_SIZE, PORTRAIT_SIZE, true));
		const cast = adventure.cast;
		castBar.hidden = !cast;
		if (cast) {
			const done = Math.min(1, (adventure.time - cast.start) / (cast.end - cast.start));
			setBar(castBar, done, 1, cast.ability.name);
			castBar.style.setProperty('--progress', `${done * 100}%`);
		}
		$('death-box').hidden = adventure.alive;
		for (const [i, s] of slots.entries()) {
			s.button.classList.toggle('active', i === 0 && adventure.autoAttack);
			const why = s.ability ? adventure.problem(s.ability) : null;
			s.button.classList.toggle('nopower', !!why?.startsWith('Not enough'));
			s.button.classList.toggle('range', why === 'Out of range');
			const a = s.ability;
			const left = a ? adventure.cooldownLeft(a) : 0;
			s.cooldown.hidden = left <= 0.05;
			// The sweep runs over the ability's own cooldown, or the global one.
			s.cooldown.style.setProperty('--left', String(a ? Math.min(1, left / Math.max(a.cooldown ?? 0, 1.5)) : 0));
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
