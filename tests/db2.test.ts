import { expect, test } from 'bun:test';
import { Db2 } from '../src/formats/db2';

const RECORD_SIZE = 20;
const FIELD_COUNT = 6;
// Fields: 0 id, 1 int, 2 float, 3 string offset, 4 bitpacked (5 bits), 5 signed bitpacked (5 bits).

interface Rec {
	id: number;
	int: number;
	float: number;
	str: string;
	packed: number;
	signed: number;
}

interface Options {
	/** Store IDs in the section's ID list instead of in field 0. */
	idList?: boolean;
	/** [new id, source id] pairs. */
	copies?: [number, number][];
	/** [record index, parent id] pairs. */
	parents?: [number, number][];
	magic?: string;
	flags?: number;
}

function build(recs: Rec[], opts: Options = {}): Uint8Array {
	const copies = opts.copies ?? [];
	const parents = opts.parents ?? [];

	// String table: a leading NUL, then each record's string.
	const strings: number[] = [0];
	const strAt: number[] = [];
	for (const r of recs) {
		strAt.push(strings.length);
		strings.push(...new TextEncoder().encode(r.str), 0);
	}

	const idListSize = opts.idList ? recs.length * 4 : 0;
	const relSize = parents.length ? 12 + parents.length * 8 : 0;
	const headerSize = 136 + 36 + 2 + 2 + 4 * 7 + 40 + FIELD_COUNT * 4 + FIELD_COUNT * 24;
	const total = headerSize + recs.length * RECORD_SIZE + strings.length + idListSize + copies.length * 8 + relSize;
	const bytes = new Uint8Array(total);
	const v = new DataView(bytes.buffer);
	let p = 0;
	const u32 = (x: number) => { v.setUint32(p, x, true); p += 4; };
	const u16 = (x: number) => { v.setUint16(p, x, true); p += 2; };

	bytes.set(new TextEncoder().encode(opts.magic ?? 'WDC5'), 0);
	p = 136;
	u32(recs.length); u32(FIELD_COUNT); u32(RECORD_SIZE); u32(strings.length);
	u32(0); u32(0); u32(0); u32(0); u32(0); // table hash, layout hash, min id, max id, locale
	u16(opts.flags ?? 0); u16(0); // flags, id index
	u32(FIELD_COUNT); u32(0); u32(0); // total fields, bitpacked offset, lookup columns
	u32(FIELD_COUNT * 24); u32(0); u32(0); // storage info size, common size, pallet size
	u32(1); // sections

	// Section header.
	p += 8; // key hash 0 = not encrypted
	u32(headerSize); u32(recs.length); u32(strings.length); u32(0);
	u32(idListSize); u32(relSize); u32(0); u32(copies.length);

	// Field structure: [32 - bit size, byte offset]; all are 32-bit elements.
	for (const byteOffset of [0, 4, 8, 12, 16, 16]) { u16(0); u16(byteOffset); }
	// Storage info: offset bits, size bits, additional, storage, val1, val2, val3.
	const info = (offsetBits: number, sizeBits: number, storage: number, val2 = 0) => {
		u16(offsetBits); u16(sizeBits); u32(0); u32(storage); u32(0); u32(val2); u32(0);
	};
	info(0, 32, 0); info(32, 32, 0); info(64, 32, 0); info(96, 32, 0);
	info(128, 5, 1, 5); // bitpacked
	info(133, 5, 5, 5); // bitpacked, signed

	// Records.
	recs.forEach((r, i) => {
		const start = headerSize + i * RECORD_SIZE;
		v.setUint32(start, r.id, true);
		v.setInt32(start + 4, r.int, true);
		v.setFloat32(start + 8, r.float, true);
		// The string offset is relative to the field itself, across the records-then-strings layout.
		const fieldToStrings = (recs.length - i) * RECORD_SIZE - 12;
		v.setUint32(start + 12, fieldToStrings + strAt[i], true);
		v.setUint32(start + 16, (r.packed & 31) | ((r.signed & 31) << 5), true);
	});

	p = headerSize + recs.length * RECORD_SIZE;
	bytes.set(strings, p);
	p += strings.length;
	if (opts.idList) for (const r of recs) u32(r.id);
	for (const [newId, sourceId] of copies) { u32(newId); u32(sourceId); }
	if (parents.length) {
		u32(parents.length); u32(0); u32(0);
		for (const [index, parent] of parents) { u32(parent); u32(index); }
	}
	return bytes;
}

const recs: Rec[] = [
	{ id: 10, int: -5, float: 1.5, str: 'Elwynn', packed: 21, signed: -3 },
	{ id: 20, int: 7, float: -0.25, str: 'Westfall', packed: 0, signed: 15 },
	{ id: 30, int: 0, float: 3.75, str: '', packed: 31, signed: -16 },
];

test('reads ids, integers, floats and bitpacked fields', () => {
	const db = new Db2(build(recs));
	expect(db.size).toBe(3);
	expect(db.ids()).toEqual([10, 20, 30]);
	expect(db.fieldCount).toBe(FIELD_COUNT);
	expect(db.has(20)).toBe(true);
	expect(db.has(21)).toBe(false);
	expect(db.getInt(10, 1)! | 0).toBe(-5);
	expect(db.getFloat(10, 2)).toBe(1.5);
	expect(db.getFloat(20, 2)).toBe(-0.25);
	expect(db.getInt(10, 4)).toBe(21);
	expect(db.getInt(30, 4)).toBe(31);
	expect(db.arrayLength(1)).toBe(1);
});

test('signed bitpacked fields sign-extend', () => {
	const db = new Db2(build(recs));
	expect(db.getInt(10, 5)).toBe(-3);
	expect(db.getInt(20, 5)).toBe(15);
	expect(db.getInt(30, 5)).toBe(-16);
});

test('strings resolve through the string table for every record', () => {
	const db = new Db2(build(recs));
	expect(db.getString(10, 3)).toBe('Elwynn');
	expect(db.getString(20, 3)).toBe('Westfall');
	expect(db.getString(30, 3)).toBe('');
});

test('unknown ids read as null', () => {
	const db = new Db2(build(recs));
	expect(db.getInt(99, 1)).toBeNull();
	expect(db.getFloat(99, 2)).toBeNull();
	expect(db.getString(99, 3)).toBeNull();
	expect(db.getParent(99)).toBeNull();
});

test('ids come from the ID list when the section has one', () => {
	const stored = recs.map((r) => ({ ...r, id: 0 }));
	const listed = build(stored.map((r, i) => ({ ...r, id: [100, 200, 300][i] })), { idList: true });
	// Zero field 0 in every record so only the ID list can supply the ids.
	for (let i = 0; i < 3; i++) new DataView(listed.buffer).setUint32(136 + 36 + 4 + 28 + 40 + FIELD_COUNT * 28 + i * RECORD_SIZE, 0, true);
	const db = new Db2(listed);
	expect(db.ids()).toEqual([100, 200, 300]);
	expect(db.getString(200, 3)).toBe('Westfall');
});

test('copy table entries duplicate the source record under a new id', () => {
	const db = new Db2(build(recs, { copies: [[25, 20]] }));
	expect(db.size).toBe(4);
	expect(db.getInt(25, 1)).toBe(7);
	expect(db.getString(25, 3)).toBe('Westfall');
});

test('the relationship map supplies each record\'s parent', () => {
	const db = new Db2(build(recs, { parents: [[0, 500], [2, 700]] }));
	expect(db.getParent(10)).toBe(500);
	expect(db.getParent(20)).toBeNull();
	expect(db.getParent(30)).toBe(700);
});

test('fields past the end read as missing rather than failing', () => {
	const db = new Db2(build(recs));
	expect(db.getInt(10, FIELD_COUNT)).toBeNull();
	expect(db.getString(20, FIELD_COUNT + 3)).toBeNull();
	expect(db.arrayLength(FIELD_COUNT)).toBe(0);
});

test('a field map reads fields by another layout\'s numbers, those it hasn\'t as missing', () => {
	const db = new Db2(build(recs));
	// As if the other layout had the string first, then a field this one hasn't, then the int.
	db.mapFields([0, 3, null, 1]);
	expect(db.fieldCount).toBe(4);
	expect(db.getString(20, 1)).toBe('Westfall');
	expect(db.getInt(20, 2)).toBeNull();
	expect(db.getFloat(20, 2)).toBeNull();
	expect(db.arrayLength(2)).toBe(0);
	expect(db.getInt(20, 3)).toBe(7);
	expect(db.getInt(20, 5)).toBeNull();
});

test('rejects other formats and sparse tables', () => {
	expect(() => new Db2(build(recs, { magic: 'WDC3' }))).toThrow(/Unsupported DB2 format WDC3/);
	expect(() => new Db2(build(recs, { flags: 1 }))).toThrow(/Sparse/);
});
