import { expect, test } from 'bun:test';
import { guidesFor, holds, parseGuides, route, segments, zoneId } from '../src/game/guide';

const druid = { faction: 'Alliance' as const, race: 'NightElf', cls: 'Druid' };
const hunter = { ...druid, cls: 'Hunter' };

const FILE = `
#version 23
#group RestedXP Forever Guide (A)
#subgroup Speedrun Guide 20-30
#forever
<< Alliance Hunter
#name 21-23 Hunter Start
#next 23-24 Wetlands
step
.goto 1440/0,-454.43,2682.24
.accept 1 >> Accept Hunter Only
#version 23
#group RestedXP Forever Guide (A)
#forever
<< Alliance !Hunter
#name 21-23 Stonetalon/Ashenvale
#next 23-24 Wetlands
step
.goto 1440/0,-454.43,2682.24
>>|Tinterface/worldmap/chatbubble_64grey.blp:20|tTalk to |cRXP_FRIENDLY_Pelturas Whitemoon::268925|r
.accept 1033 >> Accept Elune's Tear
.target Pelturas Whitemoon
step << Druid
#completewith next
.goto Ashenvale,34.6,48.2
.turnin 1033 >> Turn in Elune's Tear
.accept 9 >> Accept Druid Thing << Druid
.accept 10 >> Accept Hunter Thing << Hunter
step << tbc
.accept 11 >> Burning Crusade only
#version 23
#group RestedXP Forever Guide (A)
#forever
<< Alliance
#name 23-24 Wetlands
step
.xp 24
#version 23
#group RestedXP Forever Dungeon Guide (A)
#forever
<< Alliance skip
#name 21-23 Stonetalon/Ashenvale
step
.accept 99 >> Dungeon variant
`;

test('conditions: any of a kind, all kinds, negation, and versions this game is', () => {
	expect(holds('Alliance !Hunter', druid)).toBe(true);
	expect(holds('Alliance !Hunter', hunter)).toBe(false);
	expect(holds('NightElf/Human Druid/Warrior', druid)).toBe(true);
	expect(holds('Human', druid)).toBe(false);
	expect(holds('tbc', druid)).toBe(false);
	expect(holds('!tbc', druid)).toBe(true);
	expect(holds('Alliance skip', druid)).toBe(false);
});

test('a character follows its own guides along #next, step by step', () => {
	const guides = parseGuides(FILE);
	expect(guides.map((g) => g.name)).toEqual(['21-23 Hunter Start', '21-23 Stonetalon/Ashenvale', '23-24 Wetlands', '21-23 Stonetalon/Ashenvale']);
	const r = route(guides, druid);
	expect(r.names).toEqual(['21-23 Stonetalon/Ashenvale', '23-24 Wetlands']);
	expect(r.steps).toHaveLength(3);
	const [first, second, third] = r.steps;
	expect(first.accept).toEqual([1033]);
	// World coordinates come as y, x.
	expect(first.goto).toEqual([{ ui: 1440, x: 2682.24, y: -454.43 }]);
	expect(first.text[0]).toEqual([{ text: 'Talk to ' }, { text: 'Pelturas Whitemoon', tone: 'FRIENDLY' }]);
	expect(second).toMatchObject({ turnin: [1033], accept: [9], optional: true, goto: [{ zone: 'Ashenvale', px: 34.6, py: 48.2 }] });
	expect(third.text[0][0].text).toBe('Grind to level 24');
	expect(route(guides, hunter).names).toEqual(['21-23 Hunter Start', '23-24 Wetlands']);
});

test('the game text codes become plain text with tones', () => {
	expect(segments('|cRXP_ENEMY_Wolf|r and |cFFFF0000red|r|T123:0|t')).toEqual([{ text: 'Wolf', tone: 'ENEMY' }, { text: ' and ' }, { text: 'red', tone: 'WHITE' }]);
});

test('zones are found by their English names in any install', () => {
	expect(zoneId('StormwindClassic')).toBe(1453);
	expect(zoneId("Un'Goro Crater")).toBe(1449);
	expect(zoneId('Wetlands')).toBe(1437);
	expect(zoneId('Nowhere')).toBeNull();
});

test('the addon\'s .lua guides: each race starts at its own, and a route can start from any guide', () => {
	const guide = (name: string, extra: string) => `RXPGuides.RegisterGuide([[\n#forever\n<< Alliance\n#name ${name}\n#group RestedXP Forever Guide (A)\n${extra}\nstep\n.accept ${name.length} >> ${name}\n]])\n`;
	const lua = guide('1-6 Northshire', '#defaultfor Human\n#next 13-15 Westfall') + guide('1-6 Shadowglen', '#defaultfor NightElf\n#next 14-16 Darkshore') + guide('13-15 Westfall', '#next 14-16 Darkshore') + guide('14-16 Darkshore', '');
	const guides = parseGuides(lua);
	expect(guides).toHaveLength(4);
	expect(route(guides, druid).names).toEqual(['1-6 Shadowglen', '14-16 Darkshore']);
	expect(route(guides, { ...druid, race: 'Human' }).names).toEqual(['1-6 Northshire', '13-15 Westfall', '14-16 Darkshore']);
	expect(route(guides, druid, '13-15 Westfall').names).toEqual(['13-15 Westfall', '14-16 Darkshore']);
	expect(guidesFor(guides, druid).map((g) => g.name)).toEqual(['1-6 Northshire', '1-6 Shadowglen', '13-15 Westfall', '14-16 Darkshore']);
});
