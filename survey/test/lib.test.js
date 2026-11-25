import test from 'tape';
import {
  abbreviate,
  classifyStreets,
  addressKey,
  distanceFt,
  nearbyTrees,
  summarize,
  planHandoff,
  toTrackerRecord,
  trackerSeason,
  slimInventory,
} from '../lib.js';

test('abbreviate shortens suffixes and leading directions', t => {
  t.equal(abbreviate('North Willow Street'), 'N Willow St');
  t.equal(abbreviate('South Park Place'), 'S Park Pl');
  t.equal(abbreviate('North Street'), 'North St');
  t.equal(abbreviate('The Meadow'), 'The Meadow');
  t.equal(abbreviate('Godfrey Terrace'), 'Godfrey Ter');
  t.end();
});

const line = (name, pts) => ({
  tags: {name},
  geometry: pts.map(([lat, lon]) => ({lat, lon})),
});

test('classifyStreets sorts streets into quadrants by Main/Maple/Park Pl', t => {
  const ways = [
    line('Main Street', [
      [42.7678, -78.64],
      [42.7678, -78.59],
    ]),
    line('Northwest Lane', [
      [42.78, -78.63],
      [42.781, -78.63],
    ]),
    line('Southeast Lane', [
      [42.76, -78.6],
      [42.761, -78.6],
    ]),
    line('Crossing Avenue', [
      [42.76, -78.63],
      [42.76, -78.615],
      [42.76, -78.6],
    ]),
  ];
  const out = classifyStreets(ways);
  const names = quad => out[quad].map(street => street.name);
  t.deepEqual(names('NW'), ['Main St', 'Northwest Ln']);
  t.ok(names('SE').includes('Southeast Ln'));
  t.ok(
    names('SE').includes('Crossing Ave') && names('SW').includes('Crossing Ave')
  );
  t.ok(out.SE.find(street => street.name === 'Crossing Ave').partial);
  t.notOk(out.SE.find(street => street.name === 'Southeast Ln').partial);
  t.ok(
    out.NE.find(street => street.name === 'Main St').partial,
    'Main is in every quadrant'
  );
  t.end();
});

test('addressKey matches tracker normalization', t => {
  t.equal(addressKey('12', 'Elm St.'), addressKey('12', 'elm street'));
  t.equal(addressKey('5', 'N Willow St'), '5 north willow street');
  t.end();
});

test('distance and nearby trees', t => {
  const here = {lat: 42.7678, lng: -78.6135};
  const tenFtNorth = {lat: 42.7678 + 10 / 364000, lng: -78.6135};
  t.ok(Math.abs(distanceFt(here, tenFtNorth) - 10) < 0.2);
  const inv = [
    [tenFtNorth.lat, tenFtNorth.lng, 'R', 'Maple'],
    [42.78, -78.6135, '', 'Oak'],
  ];
  const near = nearbyTrees(here, inv, 40);
  t.equal(near.length, 1);
  t.equal(near[0].status, 'R');
  t.end();
});

test('slimInventory keeps coords, status code, species', t => {
  const geo = {
    features: [
      {
        geometry: {coordinates: [-78.6, 42.7]},
        properties: {_status: 'Removed', tree_species: 'Ash'},
      },
      {geometry: null, properties: {}},
    ],
  };
  t.deepEqual(slimInventory(geo), [[42.7, -78.6, 'R', 'Ash']]);
  t.end();
});

test('summarize counts streets walked and priorities (ignoring not suitable)', t => {
  const sites = [
    {street: 'Elm St', priority: 'High', status: 'Selected'},
    {street: 'Elm Street', priority: 'High', status: 'Not suitable'},
    {street: 'Oak St', priority: 'Low', status: 'Candidate'},
  ];
  const streets = {'elm street': {walked: true}, 'oak street': {walked: false}};
  const sum = summarize(sites, streets);
  t.equal(sum.streetsWalked, 1);
  t.equal(sum.streetsTotal, 2);
  t.equal(sum.byPriority.High, 1);
  t.equal(sum.byStatus['Not suitable'], 1);
  t.equal(sum.perStreet['elm street'], 2);
  t.end();
});

test('planHandoff sends only Selected sites and splits out tracker duplicates', t => {
  const sites = [
    {id: 'a', housenum: '1', street: 'Elm St', status: 'Selected'},
    {id: 'b', housenum: '2', street: 'Elm St', status: 'Selected'},
    {id: 'c', housenum: '3', street: 'Elm St', status: 'Candidate'},
  ];
  const tracker = [{id: 'x', housenum: '2', street: 'Elm Street'}];
  const {toSend, duplicates} = planHandoff(sites, tracker);
  t.deepEqual(
    toSend.map(site => site.id),
    ['a']
  );
  t.equal(duplicates[0].record.id, 'x');
  t.end();
});

test('toTrackerRecord makes a next-spring tracker record', t => {
  const rec = toTrackerRecord(
    {
      id: 's1',
      year: 2026,
      housenum: '9',
      street: 'King St',
      priority: 'High',
      size: 'Small',
      obstructions: ['Overhead wires'],
    },
    'Nov 25, 2026 9:00 AM'
  );
  t.equal(trackerSeason(2026), 'Spring 2027');
  t.equal(rec.season, 'Spring 2027');
  t.equal(rec.status, '');
  t.equal(rec.housenum, '9');
  t.match(rec.log[0].text, /2026 site survey.*High.*Small.*Overhead wires/);
  t.end();
});
