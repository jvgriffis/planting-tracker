// Pure helpers shared by the browser app, the data build script, and tests.

export const QUADRANTS = {
  NW: 'Northwest',
  NE: 'Northeast',
  SE: 'Southeast',
  SW: 'Southwest',
};

export const STATUSES = [
  'Candidate',
  'Selected',
  'Not suitable',
  'Sent to tracker',
];
export const PRIORITIES = ['High', 'Medium', 'Low'];
export const SIZES = ['Small', 'Large'];
export const OBSTRUCTIONS = [
  'Overhead wires',
  'Hydrant within ~10 ft',
  'Driveway',
  'Sidewalk crowding',
  'Nearby tree',
  'Recently removed tree',
  'Utility pole / box',
  'Sign / streetlight',
];

// ── quadrant boundaries ────────────────────────────────
// Main St splits N/S; Maple St splits the north, Park Pl the south.
const MAPLE_LNG = -78.6209;
const PARK_LNG = -78.6163;
const BOUNDARY_STREETS = {
  'Main St': ['NW', 'NE', 'SE', 'SW'],
  'Maple St': ['NW', 'NE'],
  'Park Pl': ['SE', 'SW'],
  'S Park Pl': ['SE', 'SW'],
};

const WORDS = {
  Street: 'St',
  Avenue: 'Ave',
  Road: 'Rd',
  Place: 'Pl',
  Drive: 'Dr',
  Lane: 'Ln',
  Court: 'Ct',
  Terrace: 'Ter',
  North: 'N',
  South: 'S',
  East: 'E',
  West: 'W',
};

export const abbreviate = name => {
  const words = name.split(/\s+/);
  // keep names like "The Meadow" and lone direction words intact
  return words
    .map((word, idx) => {
      const isDirection = ['North', 'South', 'East', 'West'].includes(word);
      if (isDirection && (idx !== 0 || words.length < 3)) return word;
      if (!isDirection && idx === 0) return word;
      return WORDS[word] || word;
    })
    .join(' ');
};

const makeMainLat = mainPoints => {
  const pts = [...mainPoints].sort((a, b) => a.lon - b.lon);
  return lon => {
    if (lon <= pts[0].lon) return pts[0].lat;
    if (lon >= pts.at(-1).lon) return pts.at(-1).lat;
    const idx = pts.findIndex(pt => pt.lon >= lon);
    const [prev, next] = [pts[idx - 1], pts[idx]];
    const span = next.lon - prev.lon || 1;
    return prev.lat + ((lon - prev.lon) / span) * (next.lat - prev.lat);
  };
};

export const quadrantOf = ({lat, lon}, mainLat) => {
  const north = lat > mainLat(lon);
  if (north) return lon < MAPLE_LNG ? 'NW' : 'NE';
  return lon < PARK_LNG ? 'SW' : 'SE';
};

// ways: OSM ways with tags.name and geometry [{lat, lon}]
// Returns {NW: [{name, partial}], ...}. A street with >10% of its length in
// another quadrant is listed in both, flagged partial.
export const classifyStreets = ways => {
  const mainLat = makeMainLat(
    ways
      .filter(way => way.tags.name === 'Main Street')
      .flatMap(way => way.geometry)
  );
  const lengths = {};
  for (const way of ways) {
    const name = abbreviate(way.tags.name);
    const geo = way.geometry;
    lengths[name] ??= {NW: 0, NE: 0, SE: 0, SW: 0};
    for (let idx = 1; idx < geo.length; idx++) {
      const [prev, cur] = [geo[idx - 1], geo[idx]];
      const mid = {
        lat: (prev.lat + cur.lat) / 2,
        lon: (prev.lon + cur.lon) / 2,
      };
      const len = Math.hypot(cur.lat - prev.lat, (cur.lon - prev.lon) * 0.734);
      lengths[name][quadrantOf(mid, mainLat)] += len;
    }
  }
  const out = {NW: [], NE: [], SE: [], SW: []};
  for (const [name, byQuad] of Object.entries(lengths)) {
    const total = Object.values(byQuad).reduce((sum, len) => sum + len, 0);
    const quads =
      BOUNDARY_STREETS[name] ||
      Object.keys(byQuad).filter(quad => total && byQuad[quad] / total > 0.1);
    for (const quad of quads) out[quad].push({name, partial: quads.length > 1});
  }
  for (const quad of Object.keys(out))
    out[quad].sort((a, b) => a.name.localeCompare(b.name));
  return out;
};

// ── inventory ──────────────────────────────────────────
// [lat, lng, status, species] — status: 'R' removed, 'A' needs attention, '' ok
export const slimInventory = geojson =>
  geojson.features
    .filter(feat => feat.geometry?.coordinates)
    .map(feat => {
      const [lng, lat] = feat.geometry.coordinates;
      const status = feat.properties._status;
      const code =
        status === 'Removed' ? 'R' : status === 'Needs Attention' ? 'A' : '';
      return [
        +lat.toFixed(6),
        +lng.toFixed(6),
        code,
        feat.properties.tree_species || '',
      ];
    });

const EARTH_FT = 20902231;
const rad = deg => (deg * Math.PI) / 180;

export const distanceFt = (a, b) => {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const hav =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_FT * Math.asin(Math.sqrt(hav));
};

export const nearbyTrees = (pin, inventory, radiusFt) =>
  inventory
    .map(([lat, lng, status, species]) => ({
      lat,
      lng,
      status,
      species,
      feet: distanceFt(pin, {lat, lng}),
    }))
    .filter(tree => tree.feet <= radiusFt)
    .sort((a, b) => a.feet - b.feet);

// ── addresses ──────────────────────────────────────────
// same normalization as the planting tracker's duplicate check
const SUFFIXES = {
  st: 'street',
  str: 'street',
  ave: 'avenue',
  av: 'avenue',
  rd: 'road',
  dr: 'drive',
  ln: 'lane',
  ct: 'court',
  pl: 'place',
  blvd: 'boulevard',
  pkwy: 'parkway',
  cir: 'circle',
  ter: 'terrace',
  terr: 'terrace',
  hwy: 'highway',
  sq: 'square',
  trl: 'trail',
  n: 'north',
  s: 'south',
  e: 'east',
  w: 'west',
};

export const addressKey = (housenum, street) =>
  `${housenum || ''} ${street || ''}`
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(word => SUFFIXES[word] || word)
    .join(' ');

export const streetKey = street => addressKey('', street);

// ── progress ───────────────────────────────────────────
// streets: {key: {name, walked, partial}}
export const summarize = (sites, streets = {}) => {
  const count = (list, field, values) =>
    Object.fromEntries(
      values.map(val => [val, list.filter(site => site[field] === val).length])
    );
  const active = sites.filter(site => site.status !== 'Not suitable');
  const streetList = Object.values(streets);
  const perStreet = {};
  for (const site of sites) {
    const key = streetKey(site.street);
    perStreet[key] = (perStreet[key] || 0) + 1;
  }
  return {
    total: sites.length,
    byStatus: count(sites, 'status', STATUSES),
    byPriority: count(active, 'priority', PRIORITIES),
    streetsTotal: streetList.length,
    streetsWalked: streetList.filter(street => street.walked).length,
    perStreet,
  };
};

// ── export ─────────────────────────────────────────────
export const exportRows = sites =>
  sites.map(site => ({
    'House #': site.housenum,
    Street: site.street,
    Status: site.status,
    Priority: site.priority,
    'Size allowed': site.size,
    'ROW condition': site.row,
    Obstructions: (site.obstructions || []).join(', '),
    Surveyor: site.surveyor,
    'Survey date': site.surveyedOn,
    Lat: site.lat ?? '',
    Lng: site.lng ?? '',
    Notes: (site.log || []).map(entry => entry.text).join(' | '),
  }));

// ── hand-off to the planting tracker ───────────────────
// Survey year N feeds letters in the fall and planting in spring N+1.
export const trackerSeason = year => `Spring ${Number(year) + 1}`;

export const toTrackerRecord = (site, stamp) => {
  const details = [
    `priority ${site.priority || '?'}`,
    site.size && `size ${site.size}`,
    site.obstructions?.length && site.obstructions.join(', '),
  ]
    .filter(Boolean)
    .join('; ');
  return {
    housenum: site.housenum,
    street: site.street,
    owner: '',
    source: '',
    email: '',
    phone: '',
    status: '',
    tree1: '',
    tree2: '',
    season: trackerSeason(site.year),
    followup: false,
    created: stamp,
    updated: stamp,
    surveyId: site.id,
    log: [
      {
        date: stamp,
        text: `Created from ${site.year} site survey (${details}).`,
      },
    ],
  };
};

// Selected sites not yet sent, split by whether the tracker already has them.
export const planHandoff = (sites, trackerRecords) => {
  const existing = new Map(
    trackerRecords.map(rec => [addressKey(rec.housenum, rec.street), rec])
  );
  const ready = sites.filter(site => site.status === 'Selected');
  return {
    toSend: ready.filter(
      site => !existing.has(addressKey(site.housenum, site.street))
    ),
    duplicates: ready
      .filter(site => existing.has(addressKey(site.housenum, site.street)))
      .map(site => ({
        site,
        record: existing.get(addressKey(site.housenum, site.street)),
      })),
  };
};
