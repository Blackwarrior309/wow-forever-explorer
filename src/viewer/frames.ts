import type { AsyncStorageApi } from '../worker/protocol';

/**
 * What the game-style windows share (spellbook, talents, character, bags, quest log, social):
 * a frame with the portrait ring, title and close button, a tooltip that follows the mouse, and
 * the open ones laid out side by side from the left, as the game does.
 */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	Object.assign(e, props);
	e.append(...children);
	return e;
}

/** Four corner pieces of a frame drawn as one picture: top left, top right, bottom left, bottom right. */
export async function quartered(storage: AsyncStorageApi, paths: string[]): Promise<string> {
	const [tl, tr, bl, br] = await storage.loadInterfaceImages(paths);
	if (!tl || !tr || !bl || !br) return '';
	const canvas = el('canvas', { width: tl.width + tr.width, height: tl.height + bl.height });
	const g = canvas.getContext('2d')!;
	const put = (image: typeof tl, x: number, y: number) => g.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height), x, y);
	put(tl, 0, 0);
	put(tr, tl.width, 0);
	put(bl, 0, tl.height);
	put(br, bl.width, tl.height);
	return canvas.toDataURL();
}

/** Sets a picture as the CSS variable --book-<name> (for the stylesheet's .wow-books rules). */
export const cssImage = (name: string, url: string) => url && document.body.style.setProperty(`--book-${name}`, `url(${url})`);

let tip: HTMLElement | null = null;

/** Shows the tooltip by the mouse with these lines. */
export function tipAt(e: MouseEvent, lines: HTMLElement[]): void {
	if (!tip) document.body.append((tip = el('div', { className: 'book-tip', hidden: true })));
	tip.replaceChildren(...lines);
	tip.hidden = false;
	tip.style.left = `${Math.min(e.clientX + 18, innerWidth - tip.offsetWidth - 8)}px`;
	tip.style.top = `${Math.min(e.clientY + 18, innerHeight - tip.offsetHeight - 8)}px`;
}

export function hideTip(): void {
	if (tip) tip.hidden = true;
}

export const line = (className: string, textContent: string) => el('div', { className, textContent });

/** Frames side by side from the left in the order they were opened (frame pixels apart). */
const FRAME_STEP = 360;
const frames: HTMLElement[] = [];
let opened = 0;

function arrange(): void {
	const open = frames.filter((f) => !f.hidden).sort((a, b) => Number(a.dataset.opened) - Number(b.dataset.opened));
	open.forEach((f, i) => (f.style.left = `${16 + i * FRAME_STEP}px`));
}

/** A game-style window, hidden; its contents go in section. */
export function gameFrame(id: string, title: string): { section: HTMLElement; portrait: HTMLElement; heading: HTMLElement } {
	const section = el('section', { id, className: 'book-frame', hidden: true, role: 'dialog' });
	section.setAttribute('aria-label', title);
	const portrait = el('div', { className: 'book-portrait' });
	const heading = el('div', { className: 'book-title', textContent: title });
	const close = el('button', { className: 'book-close', textContent: '×', title: `Close ${title.toLowerCase()}` });
	close.onclick = () => {
		section.hidden = true;
		hideTip();
	};
	section.append(portrait, heading, close);
	section.addEventListener('contextmenu', (e) => e.preventDefault());
	document.body.append(section);
	frames.push(section);
	new MutationObserver(() => {
		if (!section.hidden) section.dataset.opened = String(++opened);
		arrange();
	}).observe(section, { attributes: true, attributeFilter: ['hidden'] });
	return { section, portrait, heading };
}

/** Closes every game-style window; false if none was open. */
export function closeFrames(): boolean {
	const open = frames.some((f) => !f.hidden);
	for (const f of frames) f.hidden = true;
	hideTip();
	return open;
}
