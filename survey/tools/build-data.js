// Regenerates survey/data/*.json:
//   quadrants.json — default street checklist per quadrant (from OpenStreetMap)
//   inventory.json — slim copy of ../EA_trees.geojson for the map overlay
// Usage: node tools/build-data.js
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {classifyStreets, slimInventory} from '../lib.js';

const here = fileURLToPath(new URL('..', import.meta.url));

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const QUERY = `[out:json][timeout:60];
area["name"="East Aurora"]["boundary"="administrative"]->.a;
way(area.a)["highway"~"^(residential|primary|secondary|tertiary|unclassified|living_street)$"]["name"];
out geom;`;

// not real survey streets
const SKIP = new Set(['School Parking Lot', "Fireman's Field Access Road"]);

const fetchStreets = async () => {
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: {'User-Agent': 'tree-survey-tool/0.1'},
    body: new URLSearchParams({data: QUERY}),
  });
  if (!res.ok) throw new Error(`overpass ${res.status}`);
  const {elements} = await res.json();
  return elements.filter(way => !SKIP.has(way.tags.name));
};

const main = async () => {
  const ways = await fetchStreets();
  const quadrants = classifyStreets(ways);
  const geojson = JSON.parse(
    await fs.readFile(here + '../EA_trees.geojson', 'utf8')
  );
  const inventory = slimInventory(geojson);
  await fs.mkdir(here + 'data', {recursive: true});
  await fs.writeFile(
    here + 'data/quadrants.json',
    JSON.stringify(quadrants, null, 1)
  );
  await fs.writeFile(here + 'data/inventory.json', JSON.stringify(inventory));
  for (const [quad, streets] of Object.entries(quadrants))
    console.log(quad, streets.length, 'streets');
  console.log(inventory.length, 'inventory trees');
};

main();
