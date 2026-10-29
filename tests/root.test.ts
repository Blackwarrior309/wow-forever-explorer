import { expect, test } from 'bun:test';
import { RootTable } from '../src/casc/root';

const ENUS = 0x2;
const DEDE = 0x10;

/** A pre-10.1.7 MFST root with one file per block, every block named. */
function root(blocks: { locale: number; fdid: number; key: number }[]): Uint8Array {
	const size = 12 + blocks.length * (12 + 4 + 16 + 8);
	const data = new Uint8Array(size);
	const view = new DataView(data.buffer);
	view.setUint32(0, 0x4d465354, true);
	view.setUint32(4, blocks.length, true);
	view.setUint32(8, blocks.length, true);
	let at = 12;
	for (const b of blocks) {
		view.setUint32(at, 1, true);
		view.setUint32(at + 4, 0, true);
		view.setUint32(at + 8, b.locale, true);
		view.setInt32(at + 12, b.fdid, true);
		data[at + 16] = b.key;
		at += 12 + 4 + 16 + 8;
	}
	return data;
}

test('other locales are kept behind enUS, so a deDE install finds its own variant', () => {
	const table = RootTable.parse(root([
		{ locale: DEDE, fdid: 982459, key: 0xde },
		{ locale: ENUS, fdid: 982459, key: 0xe5 },
		{ locale: DEDE, fdid: 7, key: 0x07 },
	]));
	expect(table.getContentKeys(982459).map((k) => k[0])).toEqual([0xe5, 0xde]);
	expect(table.getContentKeys(7).map((k) => k[0])).toEqual([0x07]);
	expect(table.fileCount).toBe(2);
});
