import type { SpellText, TalentInfo, TalentTree } from '../explorer/spells';
import { racialAbility, type Ability } from '../game/classes';
import type { AsyncStorageApi } from '../worker/protocol';
import { cssImage, el, gameFrame, hideTip, line, quartered, tipAt, closeFrames } from './frames';
import { imageUrl, type Icons } from './icons';
import type { Viewer } from './viewer';

/**
 * The spellbook (P) and talent frame (N) of Adventure mode, drawn with the game's own frames:
 * the class's abilities and the race's (Forever's racials as the install has them), and the
 * class's talent trees to spend points in.
 */

export interface BookHooks {
	/** What an ability does, in the tooltip. */
	describe(a: Ability): string;
	/** Uses an ability, as from the action bar. */
	use(a: Ability): void;
	/** The racial abilities or talents changed: the action bar should follow. */
	changed(): void;
}

const ATTACK_ICON = 'inv_sword_04';
const GENERAL_ICON = 'inv_misc_book_09';
const CLASS_ICONS: Record<number, string> = { 1: 'inv_sword_27', 2: 'spell_holy_holybolt', 3: 'inv_weapon_bow_07', 4: 'ability_backstab', 5: 'spell_holy_wordfortitude', 7: 'spell_nature_bloodlust', 8: 'spell_frost_frostbolt02', 9: 'spell_shadow_deathcoil', 11: 'ability_druid_maul' };
const PER_PAGE = 12;
/** Talent buttons: left and top of the first, and the step between columns and rows (frame pixels). */
const TALENT_X = 42;
const TALENT_Y = 10;
const TALENT_DX = 70;
const TALENT_DY = 50;
const TALENT_SIZE = 37;

const FRAME_PIECES = {
	spellbook: ['interface/spellbook/ui-spellbookpanel-topleft.blp', 'interface/spellbook/ui-spellbookpanel-topright.blp', 'interface/spellbook/ui-spellbookpanel-botleft.blp', 'interface/spellbook/ui-spellbookpanel-botright.blp'],
	talents: ['interface/paperdollinfoframe/ui-character-general-topleft.blp', 'interface/paperdollinfoframe/ui-character-general-topright.blp', 'interface/paperdollinfoframe/ui-character-general-bottomleft.blp', 'interface/paperdollinfoframe/ui-character-general-bottomright.blp'],
};
const SINGLES = {
	tab: 'interface/spellbook/spellbook-skilllinetab.blp',
	rank: 'interface/talentframe/talentframe-rankborder.blp',
	arrows: 'interface/talentframe/ui-talentarrows.blp',
	next: 'interface/buttons/ui-spellbookicon-nextpage-up.blp',
	prev: 'interface/buttons/ui-spellbookicon-prevpage-up.blp',
	activeTab: 'interface/paperdollinfoframe/ui-character-activetab.blp',
	inactiveTab: 'interface/paperdollinfoframe/ui-character-inactivetab.blp',
};

export function setUpBooks(viewer: Viewer, storage: AsyncStorageApi, icons: Icons, hooks: BookHooks) {
	const adventure = viewer.adventure!;
	// The frames' pictures, once; the frames still work (plainly drawn) without them.
	void quartered(storage, FRAME_PIECES.spellbook).then((u) => cssImage('spellbook', u));
	void quartered(storage, FRAME_PIECES.talents).then((u) => cssImage('talents', u));
	void storage.loadInterfaceImages(Object.values(SINGLES)).then((images) => {
		Object.keys(SINGLES).forEach((name, i) => images[i] && cssImage(name, imageUrl(images[i]!)));
		document.body.classList.add('wow-books');
	});

	const frame = gameFrame;

	// --- Racial abilities, from the game's data for the race and class ---
	let passives: SpellText[] = [];
	let racialKey = '';
	const loadRacials = () => {
		const key = `${adventure.player.race}:${adventure.cls.id}`;
		if (key === racialKey) return;
		racialKey = key;
		void storage.loadRacials(adventure.player.race, adventure.cls.id).then((list) => {
			if (key !== racialKey) return;
			adventure.racials = list.filter((s) => !s.passive).map(racialAbility);
			passives = list.filter((s) => s.passive);
			void icons.load([...adventure.racials.map((a) => a.icon), ...passives.map((s) => s.icon || 'inv_misc_questionmark')]).then(render);
			hooks.changed();
		}).catch((e) => console.warn('Racial abilities unreadable:', e));
	};

	// --- Talent trees, from the game's data for the class ---
	let talentClass = 0;
	const backgrounds = new Map<string, Promise<string>>();
	const loadTalents = () => {
		const cls = adventure.cls.id;
		if (cls === talentClass) return;
		talentClass = cls;
		adventure.talentTrees = [];
		void storage.loadTalents(cls).then((trees) => {
			if (cls !== talentClass) return;
			adventure.talentTrees = trees;
			tree = 0;
			void icons.load(trees.flatMap((t) => t.talents.map((tl) => tl.icon || 'inv_misc_questionmark'))).then(render);
			for (const t of trees) {
				const name = t.background.toLowerCase();
				if (!backgrounds.has(name)) backgrounds.set(name, quartered(storage, ['topleft', 'topright', 'bottomleft', 'bottomright'].map((p) => `interface/talentframe/${name}-${p}.blp`)).catch(() => ''));
				void backgrounds.get(name)!.then(render);
			}
			render();
		}).catch((e) => console.warn('Talents unreadable:', e));
	};

	// --- The spellbook ---
	const book = frame('spellbook-frame', 'Spellbook');
	const slots = el('div', { className: 'book-slots' });
	const pageText = el('div', { className: 'book-page' });
	const prev = el('button', { className: 'book-prev', title: 'Previous page' });
	const next = el('button', { className: 'book-next', title: 'Next page' });
	const tabs = el('div', { className: 'book-tabs' });
	book.section.append(slots, pageText, prev, next, tabs);
	let tab = 1;
	let page = 0;
	prev.onclick = () => { page--; renderBook(); };
	next.onclick = () => { page++; renderBook(); };

	type Entry = { ability: Ability | null; passive?: SpellText };
	const entries = (): Entry[] => tab === 0
		? [{ ability: null }, ...adventure.racials.map((ability) => ({ ability })), ...passives.map((passive) => ({ ability: null, passive }))]
		: adventure.cls.abilities.map((ability) => ({ ability }));

	const abilityTip = (e: MouseEvent, entry: Entry) => {
		const a = entry.ability;
		if (entry.passive) return tipAt(e, [line('title', entry.passive.name), line('sub', 'Passive · Racial'), line('desc', entry.passive.description)]);
		if (!a) return tipAt(e, [line('title', 'Attack'), line('desc', 'Starts or stops attacking your target with your weapon.')]);
		const lines = [line('title', a.name)];
		if (a.racial) lines.push(line('sub', 'Racial'));
		const extra = [a.cast ? `${a.cast} sec cast` : 'Instant', a.cooldown ? `${a.cooldown >= 60 ? `${a.cooldown / 60} min` : `${a.cooldown} sec`} cooldown` : ''].filter(Boolean).join(' · ');
		lines.push(line('sub', extra));
		if (a.level > adventure.level) lines.push(line('need', `Requires Level ${a.level}`));
		else if (!adventure.knows(a)) lines.push(line('need', 'Not learned: visit your class trainer'));
		lines.push(line('desc', a.text || hooks.describe(a)));
		tipAt(e, lines);
	};

	const renderBook = () => {
		if (book.section.hidden) return;
		book.portrait.style.backgroundImage = `url(${icons.get(tab ? (CLASS_ICONS[adventure.cls.id] ?? GENERAL_ICON) : GENERAL_ICON)})`;
		book.heading.textContent = tab ? `Spellbook · ${adventure.cls.name}` : 'Spellbook · General';
		const all = entries();
		const pages = Math.max(1, Math.ceil(all.length / PER_PAGE));
		page = Math.max(0, Math.min(pages - 1, page));
		prev.disabled = page === 0;
		next.disabled = page >= pages - 1;
		pageText.textContent = `Page ${page + 1}`;
		slots.replaceChildren(...all.slice(page * PER_PAGE, (page + 1) * PER_PAGE).map((entry, i) => {
			const a = entry.ability;
			const icon = entry.passive ? entry.passive.icon || 'inv_misc_questionmark' : (a?.icon ?? ATTACK_ICON);
			const usable = !entry.passive && (!a || (a.level <= adventure.level && adventure.knows(a)));
			const sub = entry.passive ? 'Passive' : !a ? '' : a.racial ? 'Racial' : a.level > adventure.level ? `Level ${a.level}` : adventure.knows(a) ? '' : 'Trainer';
			const slot = el('button', { className: `book-slot${usable ? '' : ' locked'}${entry.passive ? ' passive' : ''}` },
				el('span', { className: 'icon' }),
				el('span', { className: 'name', textContent: entry.passive?.name ?? a?.name ?? 'Attack' }),
				el('span', { className: 'sub', textContent: sub }));
			slot.style.left = `${36 + (i % 2) * 160}px`;
			slot.style.top = `${86 + Math.floor(i / 2) * 54}px`;
			(slot.firstElementChild as HTMLElement).style.backgroundImage = icons.get(icon) ? `url(${icons.get(icon)})` : '';
			slot.onclick = () => { if (!entry.passive) (a ? hooks.use(a) : adventure.use(0)); };
			slot.onmousemove = (e) => abilityTip(e, entry);
			slot.onmouseleave = hideTip;
			return slot;
		}));
		tabs.replaceChildren(...[GENERAL_ICON, CLASS_ICONS[adventure.cls.id] ?? GENERAL_ICON].map((icon, i) => {
			const b = el('button', { className: `book-tab${i === tab ? ' active' : ''}`, title: i ? adventure.cls.name : 'General' }, el('span'));
			(b.firstElementChild as HTMLElement).style.backgroundImage = icons.get(icon) ? `url(${icons.get(icon)})` : '';
			b.onclick = () => { tab = i; page = 0; renderBook(); };
			return b;
		}));
	};

	// --- The talent frame ---
	const talents = frame('talent-frame', 'Talents');
	const band = el('div', { className: 'talent-band' });
	const area = el('div', { className: 'talent-area' });
	const treeTabs = el('div', { className: 'talent-tabs' });
	const reset = el('button', { className: 'talent-reset', textContent: 'Reset', title: 'Take back every talent point' });
	reset.onclick = () => adventure.resetTalents();
	talents.section.append(band, area, treeTabs, reset);
	let tree = 0;

	const talentTip = (e: MouseEvent, t: TalentInfo) => {
		const rank = adventure.talents[t.id] ?? 0;
		const lines = [line('title', t.name), line('sub', `Rank ${rank}/${t.ranks.length}`)];
		if (rank) lines.push(line('desc', t.ranks[rank - 1] || '…'));
		if (rank < t.ranks.length) {
			const why = adventure.talentProblem(t.id);
			if (why && why !== 'No talent points left') lines.push(line('need', why));
			if (rank) lines.push(line('next', 'Next rank:'));
			lines.push(line('desc', t.ranks[rank] || '…'));
		}
		tipAt(e, lines);
	};

	const renderTalents = () => {
		if (talents.section.hidden) return;
		const trees = adventure.talentTrees;
		talents.portrait.style.backgroundImage = `url(${icons.get(CLASS_ICONS[adventure.cls.id] ?? GENERAL_ICON)})`;
		const t: TalentTree | undefined = trees[tree];
		band.replaceChildren(
			el('span', { textContent: t ? `${t.name}: ${adventure.spentIn(t)} points` : adventure.level < 10 ? 'Talents start at level 10' : 'Reading talents…' }),
			el('span', { className: 'left', textContent: `Talent points: ${adventure.talentPointsLeft}` }));
		reset.disabled = !adventure.talentsSpent;
		treeTabs.replaceChildren(...trees.map((tr, i) => {
			const b = el('button', { className: `talent-tab${i === tree ? ' active' : ''}`, textContent: tr.name });
			b.onclick = () => { tree = i; renderTalents(); };
			return b;
		}));
		area.replaceChildren();
		if (!t) return;
		void backgrounds.get(t.background.toLowerCase())?.then((url) => { if (trees[tree] === t) area.style.backgroundImage = url ? `url(${url})` : ''; });
		const at = (tl: TalentInfo) => ({ x: TALENT_X + tl.column * TALENT_DX, y: TALENT_Y + tl.tier * TALENT_DY });
		const half = TALENT_SIZE / 2;
		// Lines from a talent to those that need it, under the buttons.
		for (const tl of t.talents) {
			const need = tl.requires && t.talents.find((o) => o.id === tl.requires!.talent);
			if (!need) continue;
			const lit = (adventure.talents[need.id] ?? 0) >= tl.requires!.rank;
			const from = at(need), to = at(tl);
			const branch = (x: number, y: number, w: number, h: number) => area.append(el('i', { className: `talent-branch${lit ? ' lit' : ''}`, style: `left:${x}px;top:${y}px;width:${w}px;height:${h}px` }));
			const arrow = (x: number, y: number, dir: 'down' | 'right' | 'left') => area.append(el('i', { className: `talent-arrow ${dir}${lit ? ' lit' : ''}`, style: `left:${x}px;top:${y}px` }));
			if (from.x === to.x) {
				branch(from.x + half - 3, from.y + TALENT_SIZE, 6, to.y - from.y - TALENT_SIZE);
				arrow(to.x + half - 16, to.y - 22, 'down');
			} else if (from.y === to.y) {
				const right = to.x > from.x;
				branch(Math.min(from.x, to.x) + TALENT_SIZE, from.y + half - 3, Math.abs(to.x - from.x) - TALENT_SIZE, 6);
				arrow(right ? to.x - 22 : to.x + TALENT_SIZE - 10, to.y + half - 16, right ? 'right' : 'left');
			} else {
				// Across from the side of the one needed, then down to the one needing it.
				const right = to.x > from.x;
				const x0 = right ? from.x + TALENT_SIZE : to.x + half - 3;
				branch(x0, from.y + half - 3, right ? to.x + half + 3 - x0 : from.x - x0, 6);
				branch(to.x + half - 3, from.y + half - 3, 6, to.y - from.y - half + 3);
				arrow(to.x + half - 16, to.y - 22, 'down');
			}
		}
		for (const tl of t.talents) {
			const rank = adventure.talents[tl.id] ?? 0;
			const max = rank >= tl.ranks.length;
			// Open once its row and prerequisite are reached, points or no points.
			const why = adventure.talentProblem(tl.id);
			const open = rank > 0 || !why || why === 'No talent points left' || why.startsWith('Talents become');
			const button = el('button', { className: `talent${max ? ' max' : open ? ' open' : ' locked'}` }, el('span', { className: 'rank', textContent: `${rank}` }));
			const { x, y } = at(tl);
			button.style.left = `${x}px`;
			button.style.top = `${y}px`;
			const icon = icons.get(tl.icon || 'inv_misc_questionmark');
			if (icon) button.style.backgroundImage = `url(${icon})`;
			button.onclick = () => adventure.learnTalent(tl.id);
			button.onmousemove = (e) => talentTip(e, tl);
			button.onmouseleave = hideTip;
			area.append(button);
		}
	};

	const render = () => {
		renderBook();
		renderTalents();
	};

	return {
		/** Called whenever the character changed: loads what its race and class need, redraws. */
		refresh() {
			loadRacials();
			loadTalents();
			void icons.load([ATTACK_ICON, GENERAL_ICON, CLASS_ICONS[adventure.cls.id] ?? GENERAL_ICON]).then(render);
			render();
		},
		toggleSpellbook() {
			book.section.hidden = !book.section.hidden;
			hideTip();
			loadRacials();
			renderBook();
		},
		toggleTalents() {
			talents.section.hidden = !talents.section.hidden;
			hideTip();
			loadTalents();
			renderTalents();
		},
		/** Closes whichever is open; false if neither was. */
		close: closeFrames,
	};
}
