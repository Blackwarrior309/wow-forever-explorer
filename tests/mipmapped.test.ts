import { expect, test } from 'bun:test';
import { mipmapped } from '../src/formats/blp';

/** An opaque picture: left half red, right half blue. */
function halves(size: number): { width: number; height: number; rgba: Uint8Array } {
	const rgba = new Uint8Array(size * size * 4);
	for (let i = 0; i < size * size; i++) rgba.set(i % size < size / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
	return { width: size, height: size, rgba };
}

test('makes a full chain down to 1x1 at the size asked for', () => {
	const texture = mipmapped(halves(32), 16, true);
	expect(texture.format).toBe('dxt1');
	expect(texture.mips.map((m) => m.width)).toEqual([16, 8, 4, 2, 1]);
	// Eight bytes per 4x4 block, at least one block per level.
	expect(texture.mips.map((m) => m.data.length)).toEqual([128, 32, 8, 8, 8]);
});

test('uncompressed levels are box-filtered halves', () => {
	const texture = mipmapped(halves(8), 8, false);
	expect(texture.format).toBe('rgba');
	expect([...texture.mips[0].data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
	// At 1x1 the two halves average out.
	expect([...texture.mips[3].data]).toEqual([128, 0, 128, 255]);
});

test('a block of one colour encodes it exactly', () => {
	const view = new DataView(mipmapped(halves(8), 8, true).mips[0].data.buffer);
	// The top-left block is all red: both ends pure red in 5:6:5.
	expect(view.getUint16(0, true)).toBe(0xf800);
	expect(view.getUint16(2, true)).toBe(0xf800);
});
