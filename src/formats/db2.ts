const STORAGE_NONE = 0;
const STORAGE_BITPACKED = 1;
const STORAGE_COMMON = 2;
const STORAGE_PALLET = 3;
const STORAGE_PALLET_ARRAY = 4;
const STORAGE_BITPACKED_SIGNED = 5;

const FLAG_SPARSE = 0x1;

interface FieldInfo {
	/** Byte offset within a record, from the field structure table. */
	byteOffset: number;
	offsetBits: number;
	sizeBits: number;
	storage: number;
	/** Storage-specific values (bitpacked: offset, size, flags; common: default; pallet array: count). */
	val1: number;
	val2: number;
	val3: number;
	/** This field's block in the pallet or common data. */
	dataOffset: number;
	dataSize: number;
	arrayCount: number;
	/** Size of one element of an uncompressed field (8, 16 or 32). */
	elementBits: number;
}

interface Row {
	id: number;
	/** Absolute offset of the record in the file. */
	offset: number;
	/** Global record index across sections, used for string offsets. */
	index: number;
	/** Foreign key from the relationship map, for tables that have one. */
	parent?: number;
}

const decoder = new TextDecoder();

/**
 * Reader for WDC5 client database tables (DBFilesClient/*.db2). Supports the storage types
 * used by normal (non-sparse) tables; sections encrypted with a missing key read as zeros
 * and are skipped.
 */
export class Db2 {
	private readonly view: DataView;
	private readonly fields: FieldInfo[] = [];
	private readonly rows = new Map<number, Row>();
	private readonly common: Map<number, number>[] = [];
	private readonly palletStart: number;
	private readonly recordSize: number;
	private readonly totalRecords: number;
	private readonly recordsStart: number[] = [];
	private readonly stringTables: { start: number; size: number; before: number }[] = [];
	readonly skippedSections: number;
	/** Which arrangement of fields this file has: the same table differs between game versions. */
	readonly layoutHash: number;
	/** Field numbers as asked for, to this file's own (see mapFields); null for one it hasn't. */
	private fieldMap: (number | null)[] | null = null;

	constructor(private readonly bytes: Uint8Array) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const v = this.view;
		const magic = decoder.decode(bytes.subarray(0, 4));
		if (magic !== 'WDC5') throw new Error(`Unsupported DB2 format ${magic}`);
		let p = 4 + 4 + 128; // magic, version, schema string
		const u32 = () => { const x = v.getUint32(p, true); p += 4; return x; };
		const u16 = () => { const x = v.getUint16(p, true); p += 2; return x; };
		this.totalRecords = u32();
		const fieldCount = u32();
		this.recordSize = u32();
		u32(); // string table size
		u32(); // table hash
		this.layoutHash = u32();
		u32(); u32(); // min id, max id
		u32(); // locale
		const flags = u16();
		const idIndex = u16();
		u32(); // total field count
		u32(); // bitpacked data offset
		u32(); // lookup column count
		const storageInfoSize = u32();
		u32(); // common data size
		const palletSize = u32();
		const sectionCount = u32();
		if (flags & FLAG_SPARSE) throw new Error('Sparse DB2 tables are not supported');

		const sections: { keyHash: bigint; offset: number; records: number; stringSize: number; idListSize: number; copyCount: number; relationshipSize: number }[] = [];
		for (let s = 0; s < sectionCount; s++) {
			const keyHash = v.getBigUint64(p, true);
			p += 8;
			const offset = u32();
			const records = u32();
			const stringSize = u32();
			u32(); // offset records end
			const idListSize = u32();
			const relationshipSize = u32();
			u32(); // offset map id count
			const copyCount = u32();
			sections.push({ keyHash, offset, records, stringSize, idListSize, copyCount, relationshipSize });
		}

		const structure: number[] = [];
		const elementBits: number[] = [];
		for (let f = 0; f < fieldCount; f++) {
			elementBits.push(32 - v.getInt16(p, true));
			p += 2;
			structure.push(u16());
		}
		let palletOffset = 0;
		let commonOffset = 0;
		for (let f = 0; f < storageInfoSize / 24; f++) {
			const offsetBits = u16();
			const sizeBits = u16();
			const additional = u32();
			const storage = u32();
			const val1 = u32();
			const val2 = u32();
			const val3 = u32();
			const field: FieldInfo = { byteOffset: structure[f], offsetBits, sizeBits, storage, val1, val2, val3, dataOffset: 0, dataSize: additional, arrayCount: 1, elementBits: elementBits[f] ?? 32 };
			if (storage === STORAGE_PALLET || storage === STORAGE_PALLET_ARRAY) {
				field.dataOffset = palletOffset;
				palletOffset += additional;
				if (storage === STORAGE_PALLET_ARRAY) field.arrayCount = val3;
			} else if (storage === STORAGE_COMMON) {
				field.dataOffset = commonOffset;
				commonOffset += additional;
			} else if (storage === STORAGE_NONE) {
				field.arrayCount = Math.max(1, sizeBits / field.elementBits);
			}
			this.fields.push(field);
		}
		this.palletStart = p;
		p += palletSize;
		const commonStart = p;
		for (const field of this.fields) {
			const map = new Map<number, number>();
			if (field.storage === STORAGE_COMMON) {
				for (let o = commonStart + field.dataOffset; o < commonStart + field.dataOffset + field.dataSize; o += 8) {
					map.set(v.getUint32(o, true), v.getUint32(o + 4, true));
				}
			}
			this.common.push(map);
		}

		let globalIndex = 0;
		let stringsBefore = 0;
		let skipped = 0;
		for (const section of sections) {
			const recordsStart = section.offset;
			const stringStart = recordsStart + section.records * this.recordSize;
			this.recordsStart.push(recordsStart);
			this.stringTables.push({ start: stringStart, size: section.stringSize, before: stringsBefore });

			let q = stringStart + section.stringSize;
			const ids: number[] = [];
			for (let i = 0; i < section.idListSize / 4; i++) ids.push(v.getUint32(q + i * 4, true));
			q += section.idListSize;
			const copies: [number, number][] = [];
			for (let i = 0; i < section.copyCount; i++) copies.push([v.getUint32(q + i * 8, true), v.getUint32(q + i * 8 + 4, true)]);
			q += section.copyCount * 8;
			// Relationship map: each record's parent (foreign key), kept outside the record data.
			// Layout: count, min id, max id, then (foreign id, record index) pairs.
			const parents = new Map<number, number>();
			if (section.relationshipSize > 0) {
				const count = v.getUint32(q, true);
				for (let i = 0; i < count; i++) {
					const e = q + 12 + i * 8;
					parents.set(v.getUint32(e + 4, true), v.getUint32(e, true));
				}
			}

			// An encrypted section whose key we don't have decodes to zeros.
			const encrypted = section.keyHash !== 0n && section.records > 0 && isZero(bytes, recordsStart, Math.min(64, section.records * this.recordSize));
			if (encrypted) {
				skipped++;
			} else {
				for (let i = 0; i < section.records; i++) {
					const offset = recordsStart + i * this.recordSize;
					const row: Row = { id: 0, offset, index: globalIndex + i };
					row.id = ids.length ? ids[i] : this.fieldValue(row, idIndex);
					row.parent = parents.get(i);
					this.rows.set(row.id, row);
				}
				for (const [newId, sourceId] of copies) {
					const source = this.rows.get(sourceId);
					if (source) this.rows.set(newId, { ...source, id: newId });
				}
			}
			globalIndex += section.records;
			stringsBefore += section.stringSize;
		}
		this.skippedSections = skipped;
	}

	/**
	 * Reads field i of the calls below as this file's field map[i], or as missing where that's
	 * null: the code numbers fields as one game version has them (see db2Layouts.ts).
	 */
	mapFields(map: (number | null)[]): void {
		this.fieldMap = map;
	}

	/** This file's own number for a field asked for, or null if it hasn't that field. */
	private local(field: number): number | null {
		const f = this.fieldMap ? (this.fieldMap[field] ?? null) : field;
		return f !== null && f < this.fields.length ? f : null;
	}

	get fieldCount(): number {
		return this.fieldMap?.length ?? this.fields.length;
	}

	/** Number of array elements in a field (1 for scalars, 0 for a field this file hasn't). */
	arrayLength(field: number): number {
		const f = this.local(field);
		return f === null ? 0 : this.fields[f].arrayCount;
	}

	/** The record's parent ID from the relationship map (e.g. CreatureDisplayInfoOption -> Extra). */
	getParent(id: number): number | null {
		return this.rows.get(id)?.parent ?? null;
	}

	get size(): number {
		return this.rows.size;
	}

	ids(): number[] {
		return [...this.rows.keys()];
	}

	has(id: number): boolean {
		return this.rows.has(id);
	}

	private readBits(recordOffset: number, bitOffset: number, bitCount: number): number {
		let value = 0;
		for (let i = 0; i < bitCount; i++) {
			const b = bitOffset + i;
			if ((this.bytes[recordOffset + (b >> 3)] >> (b & 7)) & 1) value += 2 ** i;
		}
		return value;
	}

	private fieldValue(row: Row, fieldIndex: number, arrayIndex = 0): number {
		const f = this.fields[fieldIndex];
		switch (f.storage) {
			case STORAGE_NONE: {
				const elementBytes = f.elementBits / 8;
				const o = row.offset + f.offsetBits / 8 + arrayIndex * elementBytes;
				if (elementBytes === 1) return this.bytes[o];
				if (elementBytes === 2) return this.view.getUint16(o, true);
				return this.view.getUint32(o, true);
			}
			case STORAGE_BITPACKED:
			case STORAGE_BITPACKED_SIGNED: {
				let value = this.readBits(row.offset, f.offsetBits, f.val2);
				if (f.storage === STORAGE_BITPACKED_SIGNED && value >= 2 ** (f.val2 - 1)) value -= 2 ** f.val2;
				return value;
			}
			case STORAGE_COMMON:
				return this.common[fieldIndex].get(row.id) ?? f.val1;
			case STORAGE_PALLET:
			case STORAGE_PALLET_ARRAY: {
				const index = this.readBits(row.offset, f.offsetBits, f.sizeBits);
				return this.view.getUint32(this.palletStart + f.dataOffset + (index * f.arrayCount + arrayIndex) * 4, true);
			}
			default:
				throw new Error(`Unsupported DB2 storage type ${f.storage}`);
		}
	}

	/** Raw 32-bit field value, or null if the row is unknown or the file hasn't the field. */
	getInt(id: number, field: number, arrayIndex = 0): number | null {
		const row = this.rows.get(id);
		const f = this.local(field);
		return row && f !== null ? this.fieldValue(row, f, arrayIndex) : null;
	}

	getFloat(id: number, field: number, arrayIndex = 0): number | null {
		const raw = this.getInt(id, field, arrayIndex);
		if (raw === null) return null;
		const tmp = new DataView(new ArrayBuffer(4));
		tmp.setUint32(0, raw, true);
		return tmp.getFloat32(0, true);
	}

	/** String fields hold an offset from the field's own position into the string tables. */
	getString(id: number, field: number, arrayIndex = 0): string | null {
		const row = this.rows.get(id);
		const local = this.local(field);
		if (!row || local === null) return null;
		const f = this.fields[local];
		const fieldPos = row.offset + f.offsetBits / 8 + arrayIndex * 4;
		const target = fieldPos + this.fieldValue(row, local, arrayIndex);
		// Offsets are relative to a virtual layout: all records, then all string tables.
		const recordsSpace = row.index * this.recordSize + (fieldPos - row.offset);
		const intoStrings = recordsSpace + (target - fieldPos) - this.totalRecords * this.recordSize;
		for (const table of this.stringTables) {
			const local = intoStrings - table.before;
			if (local >= 0 && local < table.size) {
				const start = table.start + local;
				let end = start;
				while (end < this.bytes.length && this.bytes[end] !== 0) end++;
				return decoder.decode(this.bytes.subarray(start, end));
			}
		}
		return null;
	}
}

function isZero(bytes: Uint8Array, start: number, length: number): boolean {
	for (let i = start; i < start + length; i++) if (bytes[i] !== 0) return false;
	return true;
}
