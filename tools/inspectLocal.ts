import { CascStorage } from '../src/casc/storage';
import { KNOWN_MAPS, MapExplorer } from '../src/explorer/maps';
import { NodeSource } from './nodeSource';

const source = new NodeSource(process.argv[2] ?? 'F:/World of Warcraft');
const product = process.argv[3] ?? 'wowf';
try {
  console.log('PRODUCTS', JSON.stringify(await CascStorage.listProducts(source)));
  const storage = await CascStorage.open(source, product, console.log);
  console.log('STORAGE', JSON.stringify(storage.stats));
  const explorer = new MapExplorer(storage);
  for (const map of KNOWN_MAPS) {
    try {
      const summary = await explorer.loadMap(map.wdt);
      console.log('MAP', JSON.stringify({ name: map.name, tiles: summary.tileCount, availability: summary.availability }));
      const tile = summary.tiles.find(t => t.x === 32 && t.y === 48) ?? summary.tiles[0];
      if (tile) {
        const details = await explorer.loadTile(map.wdt, tile.x, tile.y);
        console.log('TILE', JSON.stringify({ name: map.name, x: tile.x, y: tile.y, chunks: details.chunkCount, heightGrid: details.heightGrid ? {size: details.heightGrid.size, min: details.heightGrid.min, max: details.heightGrid.max} : null, errors: details.errors }));
      }
    } catch (error) { console.error('MAP_ERROR', map.name, String(error)); process.exitCode = 1; }
  }
} catch (error) { console.error(error); process.exitCode = 1; }
