// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
// @ts-expect-error the collector is plain JavaScript: it is loaded in the page
import { accessibilityTree, collectLayout } from './collect.js';

const render = (html: string): HTMLElement => {
  document.body.innerHTML = html;
  return document.body;
};

describe('the accessibility tree', () => {
  it('names buttons, links, headings and fields, and passes through plain wrappers', () => {
    const tree = accessibilityTree(
      render(`
        <main><div><h2>This week</h2>
          <button aria-pressed="true">Favourite <span>Sweet Spot</span></button>
          <button aria-label="Close"><svg></svg></button>
          <a href="/x">Settings</a>
          <label for="q">Search</label><input id="q" type="search" />
          <img alt="" src="x.png" /><img alt="Hero" src="y.png" />
          <ul><li>One</li></ul>
        </div></main>`),
    );
    expect(tree).toEqual([
      {
        role: 'main',
        name: '',
        children: [
          { role: 'heading', name: 'This week', level: 2 },
          { role: 'button', name: 'Favourite Sweet Spot', states: { pressed: 'true' } },
          { role: 'button', name: 'Close' },
          { role: 'link', name: 'Settings' },
          { role: 'searchbox', name: 'Search' },
          { role: 'img', name: 'Hero' },
          { role: 'list', name: '', children: [{ role: 'listitem', name: 'One' }] },
        ],
      },
    ]);
  });

  it('keeps the words of neighbouring elements apart', () => {
    const tree = accessibilityTree(render('<button><b>Monday</b><i>9 Nov</i></button>'));
    expect(tree).toEqual([{ role: 'button', name: 'Monday 9 Nov' }]);
  });

  it('leaves out what is hidden and names a table by its headers', () => {
    const tree = accessibilityTree(
      render(`<div aria-hidden="true"><button>Hidden</button></div><button hidden>Gone</button>
        <table><tr><th scope="col">Day</th></tr><tr><th scope="row">Monday</th><td>Ride</td></tr></table>`),
    );
    expect(JSON.stringify(tree)).not.toContain('Hidden');
    expect(JSON.stringify(tree)).not.toContain('Gone');
    expect(JSON.stringify(tree)).toContain('"role":"columnheader","name":"Day"');
    expect(JSON.stringify(tree)).toContain('"role":"rowheader","name":"Monday"');
  });
});

describe('the layout facts', () => {
  it('reports every visible element with its own text, path and whether it is interactive', () => {
    const { facts } = collectLayout(
      render(
        '<div><button>Go</button><span style="display:none">x</span><p>Hi <b>you</b></p></div>',
      ),
    );
    const byPath = Object.fromEntries(facts.map((f: { path: string }) => [f.path, f]));
    expect(Object.keys(byPath)).toEqual([
      'body',
      'body > div:0',
      'body > div:0 > button:0',
      'body > div:0 > p:2',
      'body > div:0 > p:2 > b:0',
    ]);
    expect(byPath['body > div:0 > button:0']).toMatchObject({ text: 'Go', interactive: true });
    expect(byPath['body > div:0 > p:2']).toMatchObject({ text: 'Hi', interactive: false });
  });

  it('stops at the limit and says so', () => {
    const { facts, truncated } = collectLayout(render('<p>a</p><p>b</p><p>c</p>'), 2);
    expect(facts).toHaveLength(2);
    expect(truncated).toBe(true);
  });
});
