// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import { Window } from 'happy-dom';
import {
  type Climb,
  categoriseClimbs,
  type Note,
  nameClimbs,
  type Profile,
} from '../../plugins/video-source-vangestel/climbs.ts';
import { drawProfile } from '../../plugins/video-source-vangestel/profile-picture.ts';
import type { RidrsWorld } from '../support/world.ts';

/*
 * The climbs of a route and its profile picture, headless: synthetic profiles sampled every 100 m
 * from 500 m up, or a route of the shipped Van Gestel catalog.
 */

const CATALOG = join(import.meta.dirname, '../../plugins/video-source-vangestel/catalog');
const SPACING = 100;
const FOOT = 500;

interface Scenario {
  profile?: Profile;
  notes?: readonly Note[];
  peaks?: readonly string[];
  climbs?: readonly Climb[];
  picture?: Document;
  route?: { readonly id: string; readonly climbs?: readonly Climb[] };
}

const scenarios = new WeakMap<RidrsWorld, Scenario>();

function scenario(world: RidrsWorld): Scenario {
  const found = scenarios.get(world) ?? {};
  scenarios.set(world, found);
  return found;
}

const required = <T>(value: T | undefined, what: string): T => {
  assert.ok(value !== undefined, `Expected ${what}`);
  return value;
};

/** `2 km` or `0.5 km` in m, `-30 m` in m. */
const amount = (cell: string | undefined) => Number.parseFloat(cell ?? '');

const km = (distance: number) => (distance / 1000).toFixed(1);

Given('a route that runs', function (this: RidrsWorld, table: DataTable) {
  const elevations = [FOOT];
  for (const row of table.hashes()) {
    const steps = Math.round((amount(row.for) * 1000) / SPACING);
    const from = elevations.at(-1) ?? FOOT;
    for (let i = 1; i <= steps; i++) {
      elevations.push(from + (amount(row.rising) * i) / steps);
    }
  }
  scenario(this).profile = { spacing: SPACING, elevations };
});

Given("the route's notes", function (this: RidrsWorld, table: DataTable) {
  // As the control file has them, the text by language; Gherkin reads `\n` in a cell as a new line.
  scenario(this).notes = table.hashes().map((row) => ({
    distance: amount(row.at?.replace('km', '')) * 1000,
    text: { en: row.text ?? '' },
  }));
});

Given("the route's peaks", function (this: RidrsWorld, table: DataTable) {
  scenario(this).peaks = table.raw().map(([peak = '']) => peak);
});

When('its climbs are categorised', function (this: RidrsWorld) {
  const current = scenario(this);
  current.climbs = nameClimbs(
    categoriseClimbs(required(current.profile, 'a route')),
    current.notes ?? [],
    current.peaks ?? [],
  );
});

Then('climb {int} is named {string}', function (this: RidrsWorld, n: number, name: string) {
  assert.equal(required(scenario(this).climbs?.[n - 1], `climb ${n}`).name, name);
});

Then('climb {int} has no name', function (this: RidrsWorld, n: number) {
  assert.equal(required(scenario(this).climbs?.[n - 1], `climb ${n}`).name, undefined);
});

When('its profile picture is drawn', function (this: RidrsWorld) {
  const current = scenario(this);
  const profile = required(current.profile, 'a route');
  const svg = drawProfile(profile, categoriseClimbs(profile));
  const window = new Window();
  current.picture = new window.DOMParser().parseFromString(
    svg,
    'image/svg+xml',
  ) as unknown as Document;
});

Then(/^it has (\d+) climbs?$/, function (this: RidrsWorld, count: string) {
  const climbs = required(scenario(this).climbs, 'categorised climbs');
  assert.equal(climbs.length, Number(count), JSON.stringify(climbs));
});

Then(
  'climb {int} is {string} from km {float} to km {float} with {int} m at {float} %',
  function (
    this: RidrsWorld,
    n: number,
    category: string,
    start: number,
    end: number,
    gain: number,
    grade: number,
  ) {
    const climb = required(scenario(this).climbs?.[n - 1], `climb ${n}`);
    assert.deepEqual(
      {
        category: climb.category,
        start: km(climb.start),
        end: km(climb.end),
        gain: Math.round(climb.gain),
        grade: climb.grade.toFixed(1),
      },
      { category, start: start.toFixed(1), end: end.toFixed(1), gain, grade: grade.toFixed(1) },
    );
  },
);

const picture = (world: RidrsWorld) => required(scenario(world).picture, 'a profile picture');

Then(
  'the picture marks a summit {string} at {int} m at km {float}',
  function (this: RidrsWorld, category: string, elevation: number, at: number) {
    const summits = [...picture(this).querySelectorAll('.summit')];
    const texts = summits.map((summit) => summit.textContent?.replace(/\s+/g, ' ').trim());
    assert.ok(
      summits.some(
        (summit) =>
          summit.querySelector('.badge')?.textContent?.trim() === category &&
          summit.textContent?.includes(`${elevation} m`) &&
          summit.textContent?.includes(`km ${at.toFixed(1)}`),
      ),
      `Summits: ${JSON.stringify(texts)}`,
    );
  },
);

Then(
  'the picture colours km {int} as {string}',
  function (this: RidrsWorld, n: number, grade: string) {
    const block = picture(this).querySelector(`.km[data-km="${n}"]`);
    assert.equal(block?.getAttribute('data-grade'), grade);
    const legend = [...picture(this).querySelectorAll('.legend [data-grade]')].find(
      (entry) => entry.getAttribute('data-grade') === grade,
    );
    assert.ok(legend, `No legend entry for ${grade}`);
    assert.equal(block?.getAttribute('fill'), legend.getAttribute('fill'));
  },
);

Then('the picture shows no name or logo of the Tour de France', function (this: RidrsWorld) {
  const document = picture(this);
  assert.doesNotMatch(document.documentElement.textContent ?? '', /tour de france|\bASO\b/i);
  assert.equal(document.querySelectorAll('image').length, 0);
});

When(
  'I read the route {string} of the Van Gestel catalog',
  function (this: RidrsWorld, id: string) {
    scenario(this).route = JSON.parse(readFileSync(join(CATALOG, id, 'route.json'), 'utf8')).route;
  },
);

Then(
  'the route has a climb {string} to {int} m at km {float}',
  function (this: RidrsWorld, category: string, summit: number, at: number) {
    const climbs = required(scenario(this).route, 'a route').climbs ?? [];
    assert.ok(
      climbs.some(
        (climb) =>
          climb.category === category &&
          Math.round(climb.summit) === summit &&
          km(climb.end) === at.toFixed(1),
      ),
      JSON.stringify(climbs),
    );
  },
);

Then(
  'the route has a climb {string} to {int} m at km {float} named {string}',
  function (this: RidrsWorld, category: string, summit: number, at: number, name: string) {
    const climbs = required(scenario(this).route, 'a route').climbs ?? [];
    assert.ok(
      climbs.some(
        (climb) =>
          climb.category === category &&
          Math.round(climb.summit) === summit &&
          km(climb.end) === at.toFixed(1) &&
          climb.name === name,
      ),
      JSON.stringify(climbs),
    );
  },
);

Then('the route has a profile picture', function (this: RidrsWorld) {
  const { id } = required(scenario(this).route, 'a route');
  assert.ok(existsSync(join(CATALOG, id, 'profile.svg')), `${id}/profile.svg is missing`);
});

Then('every video of the Van Gestel catalog has a peaks file matching its climbs', () => {
  const index = JSON.parse(readFileSync(join(CATALOG, 'index.json'), 'utf8')) as {
    readonly routes: readonly { readonly id: string; readonly climbs?: readonly Climb[] }[];
  };
  for (const route of index.routes) {
    const file = join(CATALOG, route.id, 'peaks.txt');
    assert.ok(existsSync(file), `${route.id}/peaks.txt is missing`);
    const peaks = readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const climbs = route.climbs ?? [];
    assert.deepEqual(
      climbs.map((climb) => climb.name),
      peaks,
      `${route.id}: climbs and peaks.txt differ`,
    );
  }
});
