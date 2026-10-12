/** A file that supports reading arbitrary byte ranges without loading it whole. */
export interface RandomAccessFile {
	readonly size: number;
	read(offset: number, length: number): Promise<Uint8Array>;
}

/**
 * Read-only access to a World of Warcraft install directory. Paths are relative to the
 * install root (the folder holding .build.info) and given as segments, e.g. ['Data', 'data', 'data.000'].
 */
export interface FileSource {
	openFile(path: string[]): Promise<RandomAccessFile>;
	listDir(path: string[]): Promise<string[]>;
}

export class NotFoundError extends Error {
	constructor(path: string[]) {
		super(`File not found: ${path.join('/')}`);
		this.name = 'NotFoundError';
	}
}

export class BlobFile implements RandomAccessFile {
	constructor(private readonly blob: Blob) {}

	get size(): number {
		return this.blob.size;
	}

	async read(offset: number, length: number): Promise<Uint8Array> {
		return new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
	}
}

/** Source backed by files from an <input webkitdirectory> pick (works in every browser). */
export class FileListSource implements FileSource {
	private readonly files = new Map<string, File>();

	/** Paths are relative to the install root, using '/' separators. */
	constructor(entries: { path: string; file: File }[]) {
		for (const { path, file } of entries) this.files.set(path.toLowerCase(), file);
	}

	async openFile(path: string[]): Promise<RandomAccessFile> {
		const file = this.files.get(path.join('/').toLowerCase());
		if (!file) throw new NotFoundError(path);
		return new BlobFile(file);
	}

	async listDir(path: string[]): Promise<string[]> {
		const prefix = path.length ? path.join('/').toLowerCase() + '/' : '';
		const names = new Set<string>();
		for (const [key, file] of this.files) {
			if (!key.startsWith(prefix)) continue;
			const rest = key.slice(prefix.length);
			const slash = rest.indexOf('/');
			// Keys are lower-cased for lookup; report the real file name when it is a direct child.
			names.add(slash < 0 ? file.name : rest.slice(0, slash));
		}
		return [...names];
	}
}

/** A file read in byte ranges over HTTP. */
class HttpFile implements RandomAccessFile {
	constructor(private readonly url: string, readonly size: number) {}

	async read(offset: number, length: number): Promise<Uint8Array> {
		if (length <= 0) return new Uint8Array(0);
		const response = await fetch(this.url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
		if (!response.ok) throw new Error(`Reading ${this.url} failed: ${response.status}`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		// A server that ignores Range sends the whole file.
		return response.status === 206 ? bytes : bytes.subarray(offset, offset + length);
	}
}

/**
 * Source served over HTTP: the portable launcher (and the dev server) serve the install they
 * found on this computer under /__wow/. Files support Range requests; a path ending in '/'
 * lists that folder, one name per line.
 */
export class HttpSource implements FileSource {
	private readonly files = new Map<string, Promise<RandomAccessFile>>();

	/** base ends in '/', e.g. http://127.0.0.1:51730/__wow/ */
	constructor(private readonly base: string) {}

	private url(path: string[]): string {
		return this.base + path.map(encodeURIComponent).join('/');
	}

	openFile(path: string[]): Promise<RandomAccessFile> {
		const key = path.join('/').toLowerCase();
		let file = this.files.get(key);
		if (!file) {
			file = (async () => {
				const url = this.url(path);
				const response = await fetch(url, { method: 'HEAD' });
				if (response.status === 404) throw new NotFoundError(path);
				if (!response.ok) throw new Error(`Opening ${url} failed: ${response.status}`);
				return new HttpFile(url, Number(response.headers.get('Content-Length')));
			})();
			file.catch(() => this.files.delete(key));
			this.files.set(key, file);
		}
		return file;
	}

	async listDir(path: string[]): Promise<string[]> {
		const response = await fetch(`${this.url(path)}/`);
		if (response.status === 404) throw new NotFoundError(path);
		if (!response.ok) throw new Error(`Listing ${path.join('/')} failed: ${response.status}`);
		return (await response.text()).split('\n').filter(Boolean);
	}
}
