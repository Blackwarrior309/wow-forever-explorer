# MapExplorer (Forever edition)

Fly over and walk through the World of Warcraft world, drawn from your own game install, and explore it together with friends. Everything is read straight from the game files on your computer; no game files are hosted, uploaded or downloaded.

**Play it in the browser: [https://blackwarrior309.github.io/wow-forever-explorer/](https://blackwarrior309.github.io/wow-forever-explorer/)**

A fork of [Coldensjo/ClassicWowMapExplorer](https://github.com/Coldensjo/ClassicWowMapExplorer) (MIT). This fork adds:

- **WoW Forever (`wowf`)** chosen first when it is installed.
- **Together**: in the *Together* menu, enter a name and a room and join. Everyone in the same room, with the same game version, sees each other walk, swim, jump and emote, and anyone flying the free camera shows up as a visitor. Only your name, look and position are sent, a few times a second, through the public MQTT broker `broker.emqx.io` (pick another with `?mqtt=wss://…`). Anyone who knows the room name can read and send there, so don't send anything private.

- **Adventure**: turn it on in the *Adventure* menu and walk. Pick a class (all nine vanilla ones, a handful of abilities each), fight creatures with their VMaNGOS health and damage, gain experience and levels, and take, do and hand in the 4,000-odd vanilla quests (kill, collect, use). Together, everyone in the room fights the same mobs: each is run by whoever pulled it, the others' hits are sent to them. Your character is kept in your browser. `bun run game -- path/to/data` rebuilds `public/game` from VMaNGOS tables.

Built for WoW Classic, with Eastern Kingdoms and Kalimdor loaded as one seamless world.

## Adventure characters and training

- **Characters:** in Adventure, enter a name, choose a new class and press **Create character**. Switch with the Character dropdown; the existing character is kept. Each slot stores its name, class, level, XP, copper, quest progress, learned abilities and appearance. The old single-character save is imported as the first slot. Saves belong to this browser and website address; localhost and GitHub Pages have separate saves. Switching or creating is blocked in combat or while dead.
- **Spellbook:** press **P** while Adventure is on, or use **Spellbook (P)** in its menu. It lists your class abilities, costs, range, cast time, cooldown and level requirements. Learned abilities can be cast from the book or their numbered action-bar slots. Escape closes the book. Outside Adventure, P still takes a screenshot.
- **Targeting:** left- or right-click an NPC or creature to select it, including creatures already fighting. A second click attacks an enemy; friendly quest givers and class trainers open their dialog. Holding and dragging the right button still controls the camera.
- **Class trainers:** 208 class trainers are identified from the local VMaNGOS source tables. Visit a friendly trainer for your class within 6 yards, out of combat. Level-1 abilities are known immediately; later abilities are learned for **10 copper × required level**, with simplified Adventure pricing. Existing saves keep the abilities their current level previously unlocked. Trainers for professions, riding and pets are not included. `bun run game -- path/to/data` also rebuilds `public/game/trainers.json`.

## In the browser (Windows)

You need **World of Warcraft Forever** (or Classic) installed and **Chrome** or **Edge**.

1. Open **[https://blackwarrior309.github.io/wow-forever-explorer/](https://blackwarrior309.github.io/wow-forever-explorer/)**.
2. Click **Choose your World of Warcraft folder** and pick the folder that contains `_forever_`,
   `_classic_` or `_classic_beta_` (e.g. `F:\World of Warcraft`). The browser calls it an upload, but the
   files are only read on your computer; nothing leaves it.
3. Pick the game version (Forever) and click **Explore**.

Fly with **W A S D**, hold **Shift** to go faster. Press **?** for all controls.

## Linux and macOS

Run from source. You need World of Warcraft Classic, Chrome or another Chromium-based browser, **git**
and **[Bun](https://bun.sh)**.

```sh
git clone https://github.com/Blackwarrior309/wow-forever-explorer.git
cd wow-forever-explorer
bun install
bun run dev
```

Then open **http://localhost:5173**. It looks for the game in the usual places (Wine, Lutris, Bottles,
Steam, Heroic on Linux; `/Applications` on macOS). If it can't find it, set `WOW_DIR` to the folder that
contains `_classic_`, `_classic_beta_` or `_forever_`, or choose the folder in the page:

```sh
WOW_DIR="/path/to/World of Warcraft" bun run dev
```

macOS is untested.

## Troubleshooting

- **"That isn't the World of Warcraft folder"**: pick the folder one level up, the one that
  contains `_classic_`, `_classic_beta_` or `_forever_`.
- **Nothing shows up**: use Chrome or Edge with hardware acceleration on and an up-to-date graphics driver.
- **Freezes or stutter**: press **F9** right after one to save a debug log and attach it to the issue.

## For developers

- `bun run dev`: start the dev server
- `bun run build`: type-check and build to `dist`
- `bun run spawns`: rebuild the spawn files from a VMaNGOS SQLite database (`-- path/to/mangos.sqlite`)
- `bun run regions`: rebuild regions, flight paths, boats and zeppelins
- `bun run portable`: build the Windows portable version into `release/`

Source layout: `src/casc` (storage), `src/formats` (file formats), `src/worker` (parsing),
`src/explorer` (world data), `src/viewer` (rendering, controls, audio), `tools` (Bun scripts).
