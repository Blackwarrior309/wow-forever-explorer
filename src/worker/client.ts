import type { AsyncStorageApi, Request, Response, StorageApi } from './protocol';
import { perf } from '../viewer/perf';

/** Main-thread proxy for the storage worker. */
/** onChanged: called once if the game is updated while the storage is open (see Response). */
export function createStorageClient(onProgress: (message: string) => void, onChanged: () => void = () => {}): AsyncStorageApi {
	const worker = new Worker(new URL('./storage.worker.ts', import.meta.url), { type: 'module' });
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string; args: string; start: number }>();
	let nextId = 1;

	worker.onmessage = (event: MessageEvent<Response>) => {
		const msg = event.data;
		if ('progress' in msg) {
			onProgress(msg.progress);
			return;
		}
		if ('changed' in msg) {
			perf.log('storage', 'the game was updated while open');
			onChanged();
			return;
		}
		const call = pending.get(msg.id);
		if (!call) return;
		pending.delete(msg.id);
		const ms = performance.now() - call.start;
		if ('error' in msg) {
			perf.log('storage', `${call.method}(${call.args}) failed after ${ms.toFixed(0)} ms: ${msg.error}`);
			call.reject(new Error(msg.error));
		} else {
			// The time includes the wait in the worker's queue. A big result is copied in on the page's
			// own thread before this runs, which shows in the long animation frames.
			perf.log('storage', `${call.method}(${call.args}) ${ms.toFixed(0)} ms, ${(byteSize(msg.result) / 1048576).toFixed(2)} MB, ${pending.size} still waiting`);
			call.resolve(msg.result);
		}
	};

	const send = (method: keyof StorageApi, args: unknown[]) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject, method, args: describeArgs(args), start: performance.now() });
			worker.postMessage({ id, method, args } satisfies Request);
		});

	// Calls held back (see THROTTLED), in the order they were made, and how many of each are in the worker.
	const held = new Map<keyof StorageApi, (() => void)[]>();
	const running = new Map<keyof StorageApi, number>();
	const call = (method: keyof StorageApi, args: unknown[]): Promise<unknown> => {
		const limit = THROTTLED[method];
		if (!limit) return send(method, args);
		return new Promise((resolve, reject) => {
			const queue = held.get(method) ?? [];
			held.set(method, queue);
			queue.push(() => {
				running.set(method, (running.get(method) ?? 0) + 1);
				send(method, args).then(resolve, reject).finally(() => {
					running.set(method, running.get(method)! - 1);
					queue.shift()?.();
				});
			});
			if ((running.get(method) ?? 0) < limit) queue.shift()!();
		});
	};

	// Sent first; the worker handles messages in order.
	void call('setPageUrl', [location.href]);
	return new Proxy({} as AsyncStorageApi, {
		get: (_, method: string) => (...args: unknown[]) => call(method as keyof StorageApi, args),
	});
}

/**
 * Calls asked for many at once that are kept to a few in the worker at a time, the rest sent as
 * those finish, in the order asked. The worker works on everything it has been sent together,
 * so the objects of the hundred-odd tiles in view (asked for as the world opens) held up the
 * detailed ground under the camera by a second or more; held back, that goes ahead of them.
 */
const THROTTLED: Partial<Record<keyof StorageApi, number>> = {
	loadTileObjects: 4,
};

/** A storage call's arguments, short: numbers and short strings as they are, lists by length. */
function describeArgs(args: unknown[]): string {
	return args.map((a) => {
		if (typeof a === 'number' || typeof a === 'boolean') return String(a);
		if (typeof a === 'string') return a.length > 40 ? `${a.slice(0, 40)}…` : a;
		if (Array.isArray(a)) return `[${a.length}]`;
		return a === null || a === undefined ? String(a) : '{…}';
	}).join(', ');
}

/** Roughly how many bytes of typed arrays a result holds (looking a few levels in). */
function byteSize(value: unknown, depth = 0): number {
	if (ArrayBuffer.isView(value)) return value.byteLength;
	if (value instanceof ArrayBuffer) return value.byteLength;
	if (depth > 4 || value === null || typeof value !== 'object') return 0;
	let n = 0;
	for (const v of Array.isArray(value) ? value : Object.values(value)) n += byteSize(v, depth + 1);
	return n;
}
