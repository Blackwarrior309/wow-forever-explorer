import { KEPT_VERSIONS_KEY, keptVersions, productName, type SessionHost, type SwitchRequest, type ViewerSession } from './session';

/** ms a version may take to open before the switch is given up, the view left as it was. */
const SWITCH_TIMEOUT = 180_000;
/** ms a message that the switch didn't happen stays up. */
const MESSAGE_TIME = 6000;

/** A viewer frame: the page itself, opened with ?viewer (see entry.ts). */
interface Frame {
	element: HTMLIFrameElement;
	/** The version it shows, once known. */
	product: string | null;
	/** Set once it has loaded. */
	session: ViewerSession | null;
	/** For a frame made for a switch: what to open and where. */
	request?: SwitchRequest;
}

/**
 * Quick switching (see session.ts): this page holds the viewers, each a frame of its own with its
 * own worker, world and sound. One is shown; those switched away from stay loaded out of sight,
 * stopped and silent, so switching back is at once: as many as chosen (keptVersions), the one
 * shown longest ago let go first, as each holds a whole world. A version not kept opens in a
 * hidden frame while the one shown carries on, and
 * is shown once the ground in view has loaded; if it can't open, or the switch is cancelled or
 * takes too long, the one shown stays. After evaera's switcher in #8.
 */
export function hostViewers(): void {
	const banner = document.createElement('div');
	banner.id = 'switch-status';
	banner.hidden = true;
	banner.setAttribute('role', 'status');
	banner.setAttribute('aria-live', 'polite');
	const message = document.createElement('span');
	const cancel = document.createElement('button');
	cancel.textContent = 'Cancel';
	banner.append(message, cancel);
	document.body.replaceChildren(banner);

	let shown = addFrame();
	shown.element.classList.add('shown');
	/** Loaded out of sight, the one shown last first. */
	let kept: Frame[] = [];
	let pending: Frame | null = null;
	/** Whether the pending switch was chosen in the Game version menu (see SwitchState.menu). */
	let pendingMenu = false;
	let timer = 0;
	let messageTimer = 0;

	function addFrame(request?: SwitchRequest): Frame {
		const element = document.createElement('iframe');
		element.className = 'viewer-frame';
		element.title = 'Map Explorer';
		element.allow = 'autoplay; fullscreen';
		const url = new URL(location.href);
		url.searchParams.set('viewer', '1');
		element.src = url.href;
		// Out of sight and out of reach of the keyboard until shown.
		element.inert = !!request;
		document.body.prepend(element);
		return { element, product: request?.product ?? null, session: null, request };
	}

	const isFrame = (child: Window, frame: Frame | null): frame is Frame => !!frame && frame.element.contentWindow === child;

	function say(text: string, cancellable: boolean): void {
		clearTimeout(messageTimer);
		message.textContent = text;
		cancel.hidden = !cancellable;
		banner.hidden = false;
	}

	/** Lets go of the kept frames past as many as are to be kept, those shown longest ago. */
	function trimKept(): void {
		for (const frame of kept.splice(keptVersions())) frame.element.remove();
	}

	/** Shows the frame a switch is waiting for, at what the one shown shows now, and keeps that one. */
	async function commit(next: Frame): Promise<void> {
		const previous = shown;
		try {
			// What's in view now, not when the switch was asked for.
			await next.session!.show({ ...previous.session!.state(), menu: pendingMenu });
		} catch (e) {
			// Cancelled meanwhile, perhaps with another switch begun since: that one isn't this one's to end.
			if (pending === next) giveUp(`${productName(next.product ?? '')} couldn't show this place (${(e as Error).message}).`);
			return;
		}
		if (pending !== next) return;
		pending = null;
		clearTimeout(timer);
		// Now, not when the switch began: a key let go meanwhile isn't held any more.
		const { keys = [], captured = false } = previous.session!.state();
		await previous.session!.pause();
		previous.element.classList.remove('shown');
		previous.element.inert = true;
		next.element.classList.add('shown');
		next.element.inert = false;
		kept = [previous, ...kept.filter((frame) => frame !== next)];
		trimKept();
		shown = next;
		next.element.contentWindow?.focus();
		next.session!.activate(keys, captured);
		banner.hidden = true;
	}

	/** Leaves the view as it is: the frame being opened goes (one kept stays kept), with why. */
	function giveUp(reason: string): void {
		const frame = pending;
		if (!frame) return;
		pending = null;
		clearTimeout(timer);
		if (!kept.includes(frame)) frame.element.remove();
		say(`${reason} Still showing ${productName(shown.product ?? '')}.`, false);
		messageTimer = window.setTimeout(() => (banner.hidden = true), MESSAGE_TIME);
		shown.element.contentWindow?.focus();
	}
	cancel.addEventListener('click', () => giveUp('Switch cancelled.'));

	const host: SessionHost = {
		request: (child) => (isFrame(child, pending) ? pending.request : undefined),
		ready(child, session) {
			if (isFrame(child, shown) && !shown.session) {
				shown.session = session;
				shown.product = session.product;
			} else if (isFrame(child, pending)) {
				pending.session = session;
				void commit(pending);
			}
		},
		failed(child, reason) {
			if (isFrame(child, pending)) giveUp(reason);
		},
		progress(child, text) {
			if (isFrame(child, pending)) say(`Opening ${productName(pending.product ?? '')}: ${text}`, true);
		},
		switchProduct(child, product, source, state) {
			if (!isFrame(child, shown) || pending || product === shown.product) return;
			say(`Opening ${productName(product)}…`, true);
			pendingMenu = !!state.menu;
			const loaded = kept.find((frame) => frame.product === product && frame.session);
			if (loaded) {
				pending = loaded;
				void commit(loaded);
				return;
			}
			pending = addFrame({ product, source, state });
			timer = window.setTimeout(() => giveUp(`${productName(product)} took too long to open.`), SWITCH_TIMEOUT);
		},
		hash(child, hash) {
			if (isFrame(child, shown)) history.replaceState(null, '', hash);
		},
	};
	window.mapExplorerHost = host;

	// Fewer to keep, chosen in a viewer's menu: let go of the rest now.
	window.addEventListener('storage', (e) => {
		if (e.key === KEPT_VERSIONS_KEY) trimKept();
	});

	// A view typed into the address, or Back and Forward: for the viewer shown.
	window.addEventListener('hashchange', () => {
		const view = shown.element.contentWindow;
		if (view && view.location.hash !== location.hash) view.location.hash = location.hash;
	});
}
