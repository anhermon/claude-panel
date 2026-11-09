import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHARACTERS, CODEX_EYE_COLOR, CODEX_VISOR_COLOR, FIT_UNITS, figureSize, fitOf, spriteRects } from './mascot-grid.mjs';

const C = CHARACTERS.claude;

test('the Claude silhouette matches the reference: a 12x8 body, two 2x2 arm stubs, four legs, 16x10 overall', () => {
  assert.deepEqual([C.body.w, C.body.h], [12, 8]);
  assert.deepEqual([C.arms.w, C.arms.h], [2, 2]);
  assert.equal(C.legs.xs.length, 4);
  assert.deepEqual(figureSize(C), { w: 16, h: 10 });
  const rects = spriteRects(C);
  assert.equal(rects.length, 1 + 2 + 4);
  assert.equal(Math.max(...rects.map(([x, , w]) => x + w)), 16);
  assert.equal(Math.max(...rects.map(([, y, , h]) => y + h)), 10);
});

test('Claude: arms on rows 4-6 of the body, eyes on rows 2-4 at x 2 and 9, legs in two pairs with a gap', () => {
  assert.equal(C.arms.top + C.arms.h, 6);
  assert.equal(C.eyes.top + C.eyes.h, 4);
  assert.deepEqual([...C.eyes.xs], [2, 9]);
  assert.deepEqual(C.legs.xs.slice(1).map((x, i) => x - C.legs.xs[i]), [2, 5, 2]);
});

test('every character fits the frame, and no two silhouettes are alike', () => {
  const seen = new Set();
  for (const [name, c] of Object.entries(CHARACTERS)) {
    assert.ok(fitOf(c) > 0 && fitOf(c) <= 1, name);
    const s = figureSize(c);
    assert.ok(s.w * fitOf(c) <= FIT_UNITS + 1e-9 && s.h * fitOf(c) <= FIT_UNITS + 1e-9, name);
    seen.add(JSON.stringify(spriteRects(c)));
  }
  assert.equal(seen.size, Object.keys(CHARACTERS).length);
  assert.ok(figureSize(CHARACTERS.agy).w > figureSize(CHARACTERS.agy).h * 1.7, 'agy is wide and low');
});

test('codex is the small blue robot: a cloud head with a dark visor, a round torso with a prompt glyph, arc eyes, light cyan eyes', () => {
  const X = CHARACTERS.codex;
  assert.ok(X.round && X.torso && X.visor && X.glyph && X.eyeArc);
  assert.ok(X.bumps.length >= 5, 'a bumpy cloud outline');
  assert.equal(X.toppers.length, 0, 'no antenna: that was the placeholder');
  assert.equal(X.legs.xs.length, 2);
  assert.ok(X.torso.w < X.body.w, 'the head is wider than the body');
  assert.notEqual(CODEX_EYE_COLOR, CODEX_VISOR_COLOR);
  assert.ok(X.eyes.xs.every((x) => x >= X.visor.x && x + X.eyes.w <= X.visor.x + X.visor.w), 'the eyes sit inside the visor');
  const s = figureSize(X);
  assert.ok(s.h > s.w && s.h < s.w * 1.4, 'compact, not the claude block and not a tall tower');
  assert.notDeepEqual(figureSize(X), figureSize(C));
});
