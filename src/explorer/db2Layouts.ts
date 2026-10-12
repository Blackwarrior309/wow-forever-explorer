/**
 * The client database tables the app reads are laid out differently in other game versions:
 * fields added, dropped or moved. The code numbers fields as Forever (wow_classic_beta) has
 * them; for another version's layout of a table, map[i] is where Forever's field i is in it, or
 * null where it hasn't one. Worked out by matching the rows the versions share (the same ID
 * with the same values). A layout not listed is read as it is, a field past its end as missing.
 */
type FieldMap = (number | null)[];

/**
 * A map for a table with `count` fields in Forever: each run moves `length` fields from Forever's
 * `from` on to the other layout's `to` on; fields in no run are missing.
 */
function moved(count: number, ...runs: [from: number, to: number, length: number][]): FieldMap {
	const map: FieldMap = new Array(count).fill(null);
	for (const [from, to, length] of runs) for (let i = 0; i < length; i++) map[from + i] = to + i;
	return map;
}

/** By table file ID, then layout hash. */
const LAYOUTS: Record<number, Record<number, FieldMap>> = {
	// AreaPOI: Classic lacks one field after the first seven, and four before the last two.
	1000630: { 0x91335bf1: moved(22, [0, 0, 7], [8, 7, 8], [20, 16, 2]) },
	// CreatureDisplayInfo: Classic lacks two fields before the texture variations.
	1108759: { 0xf75f884c: moved(28, [0, 0, 25], [27, 25, 1]) },
	// CreatureDisplayInfoExtra: Classic still has the old look fields (skin, face, hair...)
	// before the baked texture, and no HD bake.
	1264997: { 0xf5e49981: moved(7, [0, 0, 4], [5, 10, 1]) },
	// CreatureModelData: Classic lacks two fields after the file.
	1365368: { 0x3ffee408: moved(34, [0, 0, 3], [5, 3, 29]) },
	// GameObjectDisplayInfo: Classic has a field in front.
	1266277: { 0x7c5f0b90: moved(9, [0, 1, 2]) },
	// ChrCustomizationElement and ChrCustomizationMaterial: Classic keeps the ID as a field, in front.
	3512765: { 0xd68dcdea: moved(13, [0, 1, 13]) },
	3459652: { 0xe61f7a35: moved(2, [0, 1, 2]) },
	// LightData: Forever keeps the ID as a field, in front; Classic lacks the later sky fields.
	1375580: { 0x70c6cd80: moved(63, [1, 0, 42], [60, 43, 3]) },
	// Lock: Forever has a field in front.
	1343608: { 0x8fa7e48a: moved(5, [1, 0, 4]) },
	// Map: Classic has a single field where Forever has two, and no WDT file (found by name instead).
	1349477: { 0xb47c6f05: moved(26, [0, 0, 6], [7, 6, 6], [16, 15, 1], [20, 20, 1], [25, 22, 1]) },
};

/** How to read a table's fields as Forever numbers them, or null if this layout needs nothing. */
export function fieldMap(fdid: number, layoutHash: number): FieldMap | null {
	return LAYOUTS[fdid]?.[layoutHash] ?? null;
}
