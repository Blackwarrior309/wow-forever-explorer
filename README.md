# MapExplorer (Forever edition)

Fly over and walk through the World of Warcraft world, drawn from your own game install, and explore it together with friends. Everything is read straight from the game files on your computer; no game files are hosted, uploaded or downloaded.

A fork of [Coldensjo/ClassicWowMapExplorer](https://github.com/Coldensjo/ClassicWowMapExplorer) (MIT). This fork adds:

- **WoW Forever (`wowf`)** chosen first when it is installed.
- **Together**: in the *Together* menu, enter a name and a room and join. Everyone in the same room, with the same game version, sees each other walk, swim, jump and emote, and anyone flying the free camera shows up as a visitor. Only your name, look and position are sent, a few times a second, through the public MQTT broker `broker.emqx.io` (pick another with `?mqtt=wss://…`). Anyone who knows the room name can read and send there, so don't send anything private.

- **Adventure**: turn it on in the *Adventure* menu and walk. Pick a class (all nine vanilla ones, a handful of abilities each), fight creatures with their VMaNGOS health and damage, gain experience and levels, and take, do and hand in the 4,000-odd vanilla quests (kill, collect, use). Together, everyone in the room fights the same mobs: each is run by whoever pulled it, the others' hits are sent to them. Your character is kept in your browser. `bun run game -- path/to/data` rebuilds `public/game` from VMaNGOS tables.

Built for WoW Classic, with Eastern Kingdoms and Kalimdor loaded as one seamless world.

## Windows

You need **Windows 10 or 11** and **World of Warcraft Classic** installed.

1. Download **MapExplorer-portable.zip** from the
   [latest release](https://github.com/Coldensjo/ClassicWowMapExplorer/releases/latest) and unzip it anywhere.
2. Run **MapExplorer.exe**. If Windows says *"Windows protected your PC"* (the program isn't signed),
   click **More info**, then **Run anyway**.
3. It finds World of Warcraft by itself. If not, click **Choose your World of Warcraft folder** and pick
   the folder that contains `_classic_`, `_classic_beta_` or `_forever_`. The files never leave your computer.

Fly with **W A S D**, hold **Shift** to go faster. Press **?** for all controls.

## Linux and macOS

Run from source. You need World of Warcraft Classic, Chrome or another Chromium-based browser, **git**
and **[Bun](https://bun.sh)**.

```sh
git clone https://github.com/Coldensjo/ClassicWowMapExplorer.git
cd ClassicWowMapExplorer
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
