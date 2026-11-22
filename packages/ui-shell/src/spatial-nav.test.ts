// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { findNearestSpatial, findSpatialCandidate, snapshotRect } from './spatial-nav.ts';

function buttonAt(
  label: string,
  left: number,
  top: number,
  width: number,
  height: number,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.textContent = label;
  const rect: DOMRect = {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    }),
  };
  button.getBoundingClientRect = () => rect;
  return button;
}

describe('spatial-nav', () => {
  it('moves cleanly across a 2D grid in all four directions and stops at edges', () => {
    // 3x2 grid of 100x60 cards with 20 px gap.
    const a1 = buttonAt('a1', 0, 0, 100, 60);
    const a2 = buttonAt('a2', 120, 0, 100, 60);
    const a3 = buttonAt('a3', 240, 0, 100, 60);
    const b1 = buttonAt('b1', 0, 80, 100, 60);
    const b2 = buttonAt('b2', 120, 80, 100, 60);
    const b3 = buttonAt('b3', 240, 80, 100, 60);
    const all = [a1, a2, a3, b1, b2, b3];

    expect(findSpatialCandidate(snapshotRect(a1), all, 'right', a1)).toBe(a2);
    expect(findSpatialCandidate(snapshotRect(a1), all, 'down', a1)).toBe(b1);
    expect(findSpatialCandidate(snapshotRect(a1), all, 'up', a1)).toBeUndefined();
    expect(findSpatialCandidate(snapshotRect(a1), all, 'left', a1)).toBeUndefined();

    expect(findSpatialCandidate(snapshotRect(a2), all, 'down', a2)).toBe(b2);
    expect(findSpatialCandidate(snapshotRect(b2), all, 'up', b2)).toBe(a2);
    expect(findSpatialCandidate(snapshotRect(b2), all, 'left', b2)).toBe(b1);
    expect(findSpatialCandidate(snapshotRect(b2), all, 'right', b2)).toBe(b3);
    expect(findSpatialCandidate(snapshotRect(b3), all, 'right', b3)).toBeUndefined();
    expect(findSpatialCandidate(snapshotRect(b3), all, 'down', b3)).toBeUndefined();
  });

  it('does not jump down to a wider element directly underneath when pressing Right at end of row', () => {
    const chip1 = buttonAt('chip1', 40, 100, 80, 36);
    const chip2 = buttonAt('chip2', 130, 100, 80, 36);
    const wideCard = buttonAt('card', 40, 160, 600, 180);
    const all = [chip1, chip2, wideCard];

    expect(findSpatialCandidate(snapshotRect(chip2), all, 'right', chip2)).toBeUndefined();
    expect(findSpatialCandidate(snapshotRect(chip2), all, 'down', chip2)).toBe(wideCard);
  });

  it('navigates the activity screen layout without trapping focus on the isolated Gear control', () => {
    const gear = buttonAt('Gear', 80, 140, 80, 40);
    const skipIntro = buttonAt('Skip intro', 16, 728, 130, 56);
    const pause = buttonAt('Pause', 1000, 728, 56, 56);
    const erg = buttonAt('ERG', 1072, 728, 56, 56);
    const shot = buttonAt('Screenshot', 1144, 728, 56, 56);
    const finish = buttonAt('Finish ride', 1216, 728, 56, 56);
    const all = [gear, skipIntro, pause, erg, shot, finish];

    // Row navigation at bottom-right.
    expect(findSpatialCandidate(snapshotRect(pause), all, 'right', pause)).toBe(erg);
    expect(findSpatialCandidate(snapshotRect(erg), all, 'right', erg)).toBe(shot);
    expect(findSpatialCandidate(snapshotRect(shot), all, 'right', shot)).toBe(finish);
    expect(findSpatialCandidate(snapshotRect(finish), all, 'right', finish)).toBeUndefined();
    expect(findSpatialCandidate(snapshotRect(erg), all, 'down', erg)).toBeUndefined();

    // Left from Pause reaches Skip intro on the same row (beating Gear far above).
    expect(findSpatialCandidate(snapshotRect(pause), all, 'left', pause)).toBe(skipIntro);
    // Up from any bottom-right button reaches Gear.
    expect(findSpatialCandidate(snapshotRect(pause), all, 'up', pause)).toBe(gear);
    // Gear captures Up/Down for shifting, so Right MUST escape Gear toward the ride controls.
    expect(findSpatialCandidate(snapshotRect(gear), all, 'right', gear)).toBe(pause);
    // When Skip intro disappears, Left from Pause can still reach Gear.
    const withoutIntro = [gear, pause, erg, shot, finish];
    expect(findSpatialCandidate(snapshotRect(pause), withoutIntro, 'left', pause)).toBe(gear);
  });

  it('moves cleanly between a sidebar menu, main content and top-right actions', () => {
    const today = buttonAt('Today', 12, 100, 176, 44);
    const ride = buttonAt('Ride', 12, 152, 176, 44);
    const training = buttonAt('Training', 12, 204, 176, 44);
    const topAction = buttonAt('Settings', 1150, 40, 44, 44);
    const cardLeft = buttonAt('Card 1', 240, 150, 300, 180);
    const cardRight = buttonAt('Card 2', 900, 150, 300, 180);
    const all = [today, ride, training, topAction, cardLeft, cardRight];

    expect(findSpatialCandidate(snapshotRect(ride), all, 'right', ride)).toBe(cardLeft);
    // cardLeft spans y=150..330 (centre 240); Training (centre 226) sits directly beside its middle.
    expect(findSpatialCandidate(snapshotRect(cardLeft), all, 'left', cardLeft)).toBe(training);
    expect(findSpatialCandidate(snapshotRect(cardLeft), all, 'right', cardLeft)).toBe(cardRight);
    expect(findSpatialCandidate(snapshotRect(cardRight), all, 'up', cardRight)).toBe(topAction);
  });

  it('recovers to the spatially nearest control when no candidate exists in the pressed direction', () => {
    const pause = buttonAt('Pause', 1000, 728, 56, 56);
    const erg = buttonAt('ERG', 1072, 728, 56, 56);
    const vanishedFinish = {
      left: 1216,
      top: 728,
      right: 1272,
      bottom: 784,
      width: 56,
      height: 56,
    };
    expect(findNearestSpatial(vanishedFinish, [pause, erg])).toBe(erg);
  });
});
