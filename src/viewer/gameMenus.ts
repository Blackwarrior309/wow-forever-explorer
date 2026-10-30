import { questText } from '../game/quests';
import { weaponDamage } from '../game/rules';
import type { AsyncStorageApi } from '../worker/protocol';
import { cssImage, el, gameFrame, hideTip, line, quartered, tipAt } from './frames';
import { imageUrl, type Icons } from './icons';
import type { Viewer } from './viewer';

/**
 * The rest of the game's interface for Adventure mode: the micro menu and bag bar at the bottom
 * right, and the character, backpack, quest log and social windows they open, in the game's
 * own frames (Interface/PaperDollInfoFrame, ContainerFrame, QuestFrame, FriendsFrame).
 */

export interface MenuHooks {
	toggleSpellbook(): void;
	toggleTalents(): void;
}

const RACE_NAMES: Record<number, string> = { 1: 'Human', 2: 'Orc', 3: 'Dwarf', 4: 'Night Elf', 5: 'Undead', 6: 'Tauren', 7: 'Gnome', 8: 'Troll', 9: 'Goblin', 10: 'Blood Elf' };
const CLASS_NAMES: Record<number, string> = { 1: 'Warrior', 2: 'Paladin', 3: 'Hunter', 4: 'Rogue', 5: 'Priest', 7: 'Shaman', 8: 'Mage', 9: 'Warlock', 11: 'Druid' };
/** Class colours, as the game shows names in. */
export const CLASS_COLORS: Record<number, string> = { 1: '#c69b6d', 2: '#f48cba', 3: '#aad372', 4: '#fff468', 5: '#ffffff', 7: '#0070dd', 8: '#3fc7eb', 9: '#8788ee', 11: '#ff7c0a' };
const QUEST_MAX = 20;
const BAG_SLOTS = 16;

const B = 'interface/buttons/';
const MICRO = {
	character: `${B}ui-microbuttoncharacter-up.blp`,
	spellbook: `${B}ui-microbutton-spellbook-up.blp`,
	talents: `${B}ui-microbutton-talents-up.blp`,
	quest: `${B}ui-microbutton-quest-up.blp`,
	socials: `${B}ui-microbutton-socials-up.blp`,
	world: `${B}ui-microbutton-world-up.blp`,
	help: `${B}ui-microbutton-help-up.blp`,
	backpack: `${B}button-backpack-up.blp`,
	bagslot: 'interface/paperdoll/ui-paperdoll-slot-bag.blp',
	backpackframe: 'interface/containerframe/ui-backpackbackground.blp',
	gold: 'interface/moneyframe/ui-goldicon.blp',
	silver: 'interface/moneyframe/ui-silvericon.blp',
	copper: 'interface/moneyframe/ui-coppericon.blp',
};
/** The equipment slots, as the character frame lays them out: left column, right column, weapons. */
const SLOTS: [string, string][] = [
	['head', 'Head'], ['neck', 'Neck'], ['shoulder', 'Shoulder'], ['chest', 'Back'], ['chest', 'Chest'], ['shirt', 'Shirt'], ['tabard', 'Tabard'], ['wrists', 'Wrist'],
	['hands', 'Hands'], ['waist', 'Waist'], ['legs', 'Legs'], ['feet', 'Feet'], ['finger', 'Finger'], ['finger', 'Finger'], ['trinket', 'Trinket'], ['trinket', 'Trinket'],
	['mainhand', 'Main Hand'], ['secondaryhand', 'Off Hand'], ['ranged', 'Ranged'],
];

export function setUpGameMenus(viewer: Viewer, storage: AsyncStorageApi, icons: Icons, hooks: MenuHooks) {
	const adventure = viewer.adventure!;
	const $ = (id: string) => document.getElementById(id)!;
	const P = 'interface/paperdollinfoframe/ui-character-charactertab-';
	void quartered(storage, [`${P}l1.blp`, `${P}r1.blp`, `${P}bottomleft.blp`, `${P}bottomright.blp`]).then((u) => cssImage('character', u));
	void quartered(storage, ['topleft', 'topright', 'botleft', 'botright'].map((p) => `interface/questframe/ui-questlog-${p}.blp`)).then((u) => cssImage('questlog', u));
	void quartered(storage, ['topleft', 'topright', 'botleft', 'botright'].map((p) => `interface/friendsframe/ui-friendsframe-${p}.blp`)).then((u) => cssImage('friends', u));
	void storage.loadInterfaceImages([...Object.values(MICRO), ...SLOTS.map(([s]) => `interface/paperdoll/ui-paperdoll-slot-${s}.blp`)]).then((images) => {
		Object.keys(MICRO).forEach((name, i) => images[i] && cssImage(`ui-${name}`, imageUrl(images[i]!)));
		SLOTS.forEach(([s], i) => {
			const image = images[Object.keys(MICRO).length + i];
			if (image) cssImage(`slot-${s}`, imageUrl(image));
		});
	});

	// --- The micro menu and bag bar, bottom right ---
	const hud = $('adventure-hud');
	const micro = el('div', { id: 'micro-menu' });
	const bags = el('div', { id: 'bag-bar' });
	hud.append(micro, bags);
	const microButton = (name: string, title: string, key: string, open: () => void) => {
		const b = el('button', { className: `micro micro-${name}`, title: `${title}${key ? ` (${key})` : ''}`, ariaLabel: title });
		b.onclick = open;
		micro.append(b);
		return b;
	};
	const characterButton = microButton('character', 'Character Info', 'C', () => toggle(character.section, renderCharacter));
	const microFace = el('img', { className: 'micro-face', alt: '' });
	characterButton.append(microFace);
	microButton('spellbook', 'Spellbook & Abilities', 'P', () => hooks.toggleSpellbook());
	microButton('talents', 'Talents', 'N', () => hooks.toggleTalents());
	microButton('quest', 'Quest Log', 'L', () => toggle(questLog.section, renderQuests));
	microButton('socials', 'Social', 'O', () => toggle(social.section, renderSocial));
	microButton('world', 'World Map', 'Tab', () => $('worldmap-open').click());
	microButton('help', 'Help', '?', () => $('help-hint').click());
	const backpackButton = el('button', { className: 'bag-slot backpack', title: 'Backpack (B)', ariaLabel: 'Backpack' });
	backpackButton.onclick = () => toggle(backpack, renderBag);
	bags.append(...[0, 1, 2, 3].map(() => el('span', { className: 'bag-slot empty', title: 'Empty bag slot' })), backpackButton);

	const toggle = (section: HTMLElement, render: () => void) => {
		section.hidden = !section.hidden;
		hideTip();
		if (!section.hidden) render();
	};

	// --- Character ---
	const character = gameFrame('character-frame', 'Character');
	const model = el('img', { className: 'paperdoll-model', alt: '' });
	const stats = el('div', { className: 'paperdoll-stats' });
	const slotCells = SLOTS.map(([texture, name], i) => {
		const cell = el('span', { className: 'paperdoll-slot', title: name });
		cell.style.setProperty('--slot', `var(--book-slot-${texture})`);
		const [x, y] = i < 8 ? [21, 74 + i * 41] : i < 16 ? [305, 74 + (i - 8) * 41] : [121 + (i - 16) * 42, 384];
		cell.style.left = `${x}px`;
		cell.style.top = `${y}px`;
		cell.onmousemove = (e) => tipAt(e, [line('title', name), line('sub', 'Empty')]);
		cell.onmouseleave = hideTip;
		return cell;
	});
	character.section.append(model, stats, ...slotCells);
	let modelKey = '';
	const renderCharacter = () => {
		if (character.section.hidden) return;
		const look = viewer.look;
		character.heading.textContent = adventure.name;
		character.portrait.style.backgroundImage = microFace.src ? `url(${microFace.src})` : '';
		const key = JSON.stringify(look);
		if (key !== modelKey) {
			modelKey = key;
			void viewer.portraits().draw(look, 464, 600).then((blob) => {
				if (blob && modelKey === key) model.src = URL.createObjectURL(blob);
			});
		}
		const r = adventure.cls.resource;
		const swing = Math.round(weaponDamage(adventure.level) * (1 + 0.01 * adventure.talentsSpent));
		const row = (label: string, value: string) => el('div', {}, el('span', { textContent: label }), el('b', { textContent: value }));
		stats.replaceChildren(
			el('div', { className: 'who', textContent: `Level ${adventure.level} ${RACE_NAMES[look.race] ?? ''} ${adventure.cls.name}` }),
			row('Health', `${Math.round(adventure.hp)} / ${adventure.maxHp}`),
			row(r === 'mana' ? 'Mana' : r === 'rage' ? 'Rage' : 'Energy', `${Math.round(adventure.power)} / ${adventure.maxPower}`),
			row('Damage', `${Math.round(swing * 0.85)} - ${Math.round(swing * 1.15)}`),
			row('Experience', adventure.level >= 60 ? 'Max' : `${adventure.xp} / ${adventure.xpNeeded}`),
			row('Talent points', `${adventure.talentsSpent} spent, ${adventure.talentPointsLeft} left`),
		);
	};

	// --- Backpack ---
	const backpack = el('section', { id: 'backpack-frame', className: 'bag-frame', hidden: true, role: 'dialog' });
	backpack.setAttribute('aria-label', 'Backpack');
	const bagTitle = el('div', { className: 'bag-title', textContent: 'Backpack' });
	const bagClose = el('button', { className: 'book-close', textContent: '×', title: 'Close backpack' });
	bagClose.onclick = () => { backpack.hidden = true; hideTip(); };
	const bagSlots = Array.from({ length: BAG_SLOTS }, (_, i) => {
		const cell = el('span', { className: 'bag-item' }, el('b'));
		cell.style.left = `${77 + (i % 4) * 41}px`;
		cell.style.top = `${64 + Math.floor(i / 4) * 41}px`;
		return cell;
	});
	const coins = el('div', { className: 'bag-money' });
	backpack.append(bagTitle, bagClose, ...bagSlots, coins);
	document.body.append(backpack);
	const itemIcons = new Map<number, number>();
	const renderBag = () => {
		if (backpack.hidden) return;
		const book = adventure.quests;
		const items = Object.entries(book?.snapshot().bag ?? {}).map(([id, count]) => [Number(id), count] as const).filter(([, n]) => n > 0);
		const missing = items.map(([id]) => id).filter((id) => !itemIcons.has(id));
		if (missing.length) {
			for (const id of missing) itemIcons.set(id, 0);
			void storage.loadItemIcons(missing).then((fdids) => {
				missing.forEach((id, i) => itemIcons.set(id, fdids[i]));
				return icons.load(fdids.filter(Boolean));
			}).then(renderBag);
		}
		bagSlots.forEach((cell, i) => {
			const item = items[i];
			const icon = item ? icons.get(itemIcons.get(item[0]) || 'inv_misc_questionmark') : '';
			cell.style.backgroundImage = icon ? `url(${icon})` : '';
			cell.classList.toggle('full', !!item);
			cell.firstElementChild!.textContent = item && item[1] > 1 ? String(item[1]) : '';
			cell.onmousemove = item ? (e) => tipAt(e, [line('title', book?.data.items[item[0]] ?? 'Item'), line('sub', 'Quest Item')]) : null;
			cell.onmouseleave = hideTip;
		});
		const m = adventure.money;
		const coin = (n: number, kind: string) => el('span', { className: `coin ${kind}`, textContent: String(n) });
		coins.replaceChildren(...[[Math.floor(m / 10000), 'gold'], [Math.floor((m % 10000) / 100), 'silver'], [m % 100, 'copper']].filter(([n], i) => n || i === 2).map(([n, k]) => coin(n as number, k as string)));
	};

	// --- Quest log ---
	const questLog = gameFrame('questlog-frame', 'Quest Log');
	const questCount = el('div', { className: 'quest-count' });
	const questList = el('div', { className: 'quest-list-frame' });
	const questDetail = el('div', { className: 'quest-detail' });
	const abandon = el('button', { className: 'quest-abandon', textContent: 'Abandon Quest' });
	questLog.section.append(questCount, questList, questDetail, abandon);
	let chosen = 0;
	const who = () => ({ name: adventure.name, className: adventure.cls.name, raceName: RACE_NAMES[viewer.look.race] ?? 'Adventurer', female: viewer.look.sex === 1 });
	abandon.onclick = () => { if (chosen) adventure.abandon(chosen); chosen = 0; renderQuests(); };
	const renderQuests = () => {
		if (questLog.section.hidden) return;
		questLog.portrait.style.backgroundImage = icons.get('inv_misc_book_08') ? `url(${icons.get('inv_misc_book_08')})` : '';
		const book = adventure.quests;
		const ids = book?.log ?? [];
		questCount.textContent = `${ids.length}/${QUEST_MAX}`;
		if (!ids.includes(chosen)) chosen = ids[0] ?? 0;
		questList.replaceChildren(...(ids.length ? ids.map((id) => {
			const q = book!.quest(id)!;
			const b = el('button', { className: `quest-entry${id === chosen ? ' chosen' : ''}`, textContent: `[${q.lv}] ${q.t}${book!.complete(id) ? ' (Complete)' : ''}` });
			b.style.color = q.lv >= adventure.level + 5 ? '#ff1a1a' : q.lv >= adventure.level + 3 ? '#ff8040' : q.lv >= adventure.level - 2 ? '#ffff00' : q.lv >= adventure.level - 8 ? '#40c040' : '#808080';
			b.onclick = () => { chosen = id; renderQuests(); };
			return b;
		}) : [el('div', { className: 'muted', textContent: book ? 'No quests yet: look for ! over people.' : 'Turn Adventure on to see quests' })]));
		abandon.disabled = !chosen;
		const q = chosen ? book?.quest(chosen) : undefined;
		questDetail.replaceChildren(...(q ? [
			el('h3', { textContent: q.t }),
			el('p', { textContent: questText(q.o, who()) }),
			...book!.objectives(chosen).map((o) => el('div', { className: o.done ? 'done' : '', textContent: `- ${o.text}` })),
			el('h3', { textContent: 'Description' }),
			el('p', { textContent: questText(q.d, who()) }),
		] : []));
	};

	// --- Social: the others in the room ---
	const social = gameFrame('social-frame', 'Social');
	const socialList = el('div', { className: 'social-list' });
	const socialNote = el('div', { className: 'social-note' });
	const together = el('button', { className: 'social-together', textContent: 'Together…', title: 'Join or leave a room' });
	together.onclick = () => { const d = $('together') as HTMLDetailsElement; d.open = true; };
	social.section.append(socialList, socialNote, together);
	let socialKey = '';
	const renderSocial = () => {
		if (social.section.hidden) return;
		// Rebuilt only when someone came, went or changed, so a button isn't swapped under the mouse.
		const key = JSON.stringify((viewer.remotePlayers?.list ?? []).map((p) => { const s = viewer.remotePlayers?.player(p.id)?.state; return [p.id, p.name, p.kind, s?.level, s?.cls]; }));
		if (key === socialKey && socialList.childElementCount) return;
		socialKey = key;
		social.portrait.style.backgroundImage = icons.get('inv_letter_02') ? `url(${icons.get('inv_letter_02')})` : '';
		const players = viewer.remotePlayers?.list ?? [];
		socialList.replaceChildren(...players.map((p) => {
			const s = viewer.remotePlayers?.player(p.id)?.state;
			const name = el('span', { className: 'name', textContent: p.name });
			if (s?.cls) name.style.color = CLASS_COLORS[s.cls] ?? '';
			const info = s && s.level ? `Level ${s.level} ${CLASS_NAMES[s.cls] ?? ''}` : p.kind === 'fly' ? 'Visitor' : 'Exploring';
			const go = el('button', { textContent: 'Teleport', title: `Go to ${p.name}` });
			go.onclick = () => viewer.teleportTo(p.id);
			return el('div', { className: 'social-row' }, name, el('span', { className: 'info', textContent: info }), go);
		}));
		socialNote.textContent = players.length ? `${players.length} in the room` : 'Nobody here: join a room with friends in the Together menu.';
	};

	// --- Keys, while playing on foot (in capture, ahead of the free camera's own keys) ---
	const KEYS: Record<string, () => void> = {
		KeyC: () => toggle(character.section, renderCharacter),
		KeyB: () => toggle(backpack, renderBag),
		KeyL: () => toggle(questLog.section, renderQuests),
		KeyO: () => toggle(social.section, renderSocial),
	};
	window.addEventListener('keydown', (e) => {
		const act = KEYS[e.code];
		if (!act || !adventure.enabled || !viewer.walking || e.ctrlKey || e.metaKey || e.altKey || (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]'))) return;
		e.preventDefault();
		e.stopImmediatePropagation();
		if (!e.repeat) act();
	}, { capture: true });

	// The character button's face, and the open windows kept up to date now and then.
	let faceKey = '';
	setInterval(() => {
		if (hud.hidden) return;
		const key = JSON.stringify(viewer.look);
		if (key !== faceKey) {
			faceKey = key;
			void viewer.portraits().draw(viewer.look, 64, 64, true).then((blob) => { if (blob) microFace.src = URL.createObjectURL(blob); });
		}
		renderCharacter();
		renderBag();
		renderSocial();
	}, 1000);
	void icons.load(['inv_misc_book_08', 'inv_letter_02']);

	return {
		/** Called whenever the character changed. */
		refresh() {
			renderCharacter();
			renderBag();
			renderQuests();
		},
		/** Closes the backpack too (the other windows close with the spellbook's). */
		close(): boolean {
			const open = !backpack.hidden;
			backpack.hidden = true;
			return open;
		},
	};
}
