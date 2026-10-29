import { Reader } from './reader';

const MFST_MAGIC = 0x4d465354; // 'TSFM' on disk
const LOCALE_ENUS = 0x2;
const CONTENT_LOW_VIOLENCE = 0x80;
const CONTENT_NO_NAME_HASH = 0x10000000;
const RECORD_BITS = 2 ** 24;

/** Maps file data IDs (and hashed paths, where present) to content keys. */
export class RootTable {
	private constructor(
		private readonly data: Uint8Array,
		/** Sorted file data IDs; a file with several variants appears once per variant. */
		private readonly fdids: Uint32Array,
		/** Offset of each file's content key in data. */
		private readonly ckeyOffsets: Uint32Array,
		private readonly nameHi: Uint32Array,
		private readonly nameLo: Uint32Array,
		readonly fileCount: number,
		readonly namedCount: number,
	) {}

	static parse(data: Uint8Array): RootTable {
		const r = new Reader(data);
		if (r.u32() !== MFST_MAGIC) throw new Error('Unsupported root format (expected MFST)');
		let headerSize = r.u32();
		let version = r.u32();
		let totalCount: number;
		let namedCount: number;
		if (headerSize === 0x18) {
			totalCount = r.u32();
			namedCount = r.u32();
		} else {
			// Pre-10.1.7 header: the two fields were the counts.
			totalCount = headerSize;
			namedCount = version;
			headerSize = 12;
			version = 0;
		}
		r.seek(headerSize);
		const allowUnnamed = totalCount !== namedCount;

		const recFdid: number[] = [];
		const recCkey: number[] = [];
		const recHashOff: number[] = [];
		/** Whether each record is another locale's, kept after enUS (see the sort). */
		const recOther: boolean[] = [];
		while (r.remaining > 0) {
			const count = r.u32();
			let contentFlags: number;
			let localeFlags: number;
			if (version === 2) {
				localeFlags = r.u32();
				const f1 = r.u32();
				const f2 = r.u32();
				const f3 = r.u8();
				contentFlags = f1 | f2 | (f3 << 17);
			} else {
				contentFlags = r.u32();
				localeFlags = r.u32();
			}

			const idStart = r.pos;
			r.skip(count * 4);
			const ckeyStart = r.pos;
			r.skip(count * 16);
			const hasNames = !(allowUnnamed && contentFlags & CONTENT_NO_NAME_HASH);
			const hashStart = r.pos;
			if (hasNames) r.skip(count * 8);

			// Other locales are kept too, behind enUS: an install in another language (deDE) has
			// only its own variant of localised files such as DB2s stored locally.
			if (contentFlags & CONTENT_LOW_VIOLENCE) continue;
			const other = !(localeFlags & LOCALE_ENUS);
			let fdid = -1;
			for (let i = 0; i < count; i++) {
				fdid += r.view.getInt32(idStart + i * 4, true) + 1;
				recFdid.push(fdid);
				recCkey.push(ckeyStart + i * 16);
				recHashOff.push(hasNames ? hashStart + i * 8 : -1);
				recOther.push(other);
			}
		}

		// Sort records by fdid (ties enUS first, then by record order) with a single numeric typed-array sort.
		const n = recFdid.length;
		if (n >= RECORD_BITS) throw new Error('Root table too large');
		const order = new Float64Array(n);
		for (let i = 0; i < n; i++) order[i] = recFdid[i] * RECORD_BITS * 2 + (recOther[i] ? RECORD_BITS : 0) + i;
		order.sort();

		// Keep every variant of a file (e.g. high-res and standard textures); the storage
		// picks whichever one is actually installed.
		const fdids = new Uint32Array(n);
		const ckeyOffsets = new Uint32Array(n);
		const nameHi = new Uint32Array(n);
		const nameLo = new Uint32Array(n);
		let unique = 0;
		let named = 0;
		for (let j = 0; j < n; j++) {
			const i = order[j] % RECORD_BITS;
			const isNew = j === 0 || fdids[j - 1] !== recFdid[i];
			fdids[j] = recFdid[i];
			ckeyOffsets[j] = recCkey[i];
			const h = recHashOff[i];
			if (h >= 0) {
				nameLo[j] = r.view.getUint32(h, true);
				nameHi[j] = r.view.getUint32(h + 4, true);
			}
			if (isNew) {
				unique++;
				if (h >= 0) named++;
			}
		}
		return new RootTable(data, fdids, ckeyOffsets, nameHi, nameLo, unique, named);
	}
	private indexOf(fdid: number): number {
		let lo = 0;
		let hi = this.fdids.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			const v = this.fdids[mid];
			if (v === fdid) return mid;
			if (v < fdid) lo = mid + 1;
			else hi = mid - 1;
		}
		return -1;
	}

	/** All content keys listed for a file, in root order (high-res variants come first). */
	getContentKeys(fdid: number): Uint8Array[] {
		let i = this.indexOf(fdid);
		if (i < 0) return [];
		while (i > 0 && this.fdids[i - 1] === fdid) i--;
		const keys: Uint8Array[] = [];
		for (; i < this.fdids.length && this.fdids[i] === fdid; i++) {
			keys.push(this.data.subarray(this.ckeyOffsets[i], this.ckeyOffsets[i] + 16));
		}
		return keys;
	}

	/** Linear scan over name hashes; fine for occasional lookups. */
	findByNameHash(hi: number, lo: number): number | null {
		const nameHi = this.nameHi;
		const nameLo = this.nameLo;
		for (let i = 0; i < nameHi.length; i++) {
			if (nameLo[i] === lo && nameHi[i] === hi) return this.fdids[i];
		}
		return null;
	}
}
