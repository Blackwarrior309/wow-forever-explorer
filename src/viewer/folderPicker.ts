import type { SourceInit } from '../worker/protocol';

/**
 * Converts an <input webkitdirectory> selection into a source, keeping only the files the
 * storage reader needs. Paths become relative to the picked folder. Browsers on macOS and
 * Linux leave hidden files (.build.info) out of that selection; it is then rebuilt from the
 * build configs in Data/config.
 */
export async function filesToSource(files: FileList | File[]): Promise<SourceInit> {
	const entries = [...files]
		.map((file) => ({ path: file.webkitRelativePath.split('/').slice(1).join('/'), file }))
		.filter(({ path }) => path === '.build.info' || /^data\/(config|data)\//i.test(path));
	if (!entries.some(({ path }) => path === '.build.info')) {
		const rebuilt = await rebuildBuildInfo(entries);
		if (rebuilt) entries.push({ path: '.build.info', file: rebuilt });
	}
	return { kind: 'files', files: entries };
}

/**
 * A stand-in .build.info made from the build configs in Data/config ("build-uid = wow_classic"
 * and the like), newest first. The reader only needs each product's name and build config key.
 */
async function rebuildBuildInfo(entries: { path: string; file: File }[]): Promise<File | null> {
	const rows: { product: string; key: string; version: string; time: number }[] = [];
	for (const { path, file } of entries) {
		// Config files are Data/config/xx/yy/<32 hex digits>, a few hundred bytes each.
		if (!/^data\/config\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{32}$/i.test(path) || file.size > 65536) continue;
		const text = await file.text();
		const product = text.match(/^build-uid\s*=\s*(\S+)/m)?.[1];
		if (!product || !/^root\s*=/m.test(text)) continue;
		rows.push({ product, key: file.name, version: text.match(/^build-name\s*=\s*(.+?)\s*$/m)?.[1] ?? '', time: file.lastModified });
	}
	if (!rows.length) return null;
	rows.sort((a, b) => b.time - a.time);
	const lines = ['Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Key!HEX:16|Version!STRING:0|Product!STRING:0',
		...rows.map((r) => `|1|${r.key}||${r.version}|${r.product}`)];
	return new File([lines.join('\n')], '.build.info');
}

/** A dropped folder's entries in a directory, all of them (readEntries returns them in batches). */
function readDir(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
	return new Promise((resolve, reject) => {
		const reader = dir.createReader();
		const all: FileSystemEntry[] = [];
		const next = () => reader.readEntries((batch) => {
			if (!batch.length) return resolve(all);
			all.push(...batch);
			next();
		}, reject);
		next();
	});
}

const fileOf = (entry: FileSystemFileEntry) => new Promise<File>((resolve, reject) => entry.file(resolve, reject));

/**
 * A folder dropped on the page, as a source: only the files the storage reader needs
 * (.build.info, Data/config and Data/data), so even a large install is quick to list.
 */
export async function droppedFolderToSource(root: FileSystemDirectoryEntry): Promise<SourceInit> {
	const files: { path: string; file: File }[] = [];
	const walk = async (dir: FileSystemDirectoryEntry, prefix: string): Promise<void> => {
		for (const entry of await readDir(dir)) {
			const path = `${prefix}${entry.name}`;
			if (entry.isFile) files.push({ path, file: await fileOf(entry as FileSystemFileEntry) });
			else await walk(entry as FileSystemDirectoryEntry, `${path}/`);
		}
	};
	const top = await readDir(root);
	const buildInfo = top.find((e) => e.isFile && e.name === '.build.info');
	if (buildInfo) files.push({ path: '.build.info', file: await fileOf(buildInfo as FileSystemFileEntry) });
	const data = top.find((e) => e.isDirectory && e.name.toLowerCase() === 'data');
	if (data) {
		for (const entry of await readDir(data as FileSystemDirectoryEntry)) {
			if (entry.isDirectory && /^(config|data)$/i.test(entry.name)) await walk(entry as FileSystemDirectoryEntry, `Data/${entry.name}/`);
		}
	}
	return { kind: 'files', files };
}
