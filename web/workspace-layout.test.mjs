// The workspace's pure logic (builtin/workspace/layout.js): which scenes are tiles, their order, the grid for n tiles in a
// viewport (a table over counts 1..8 x three aspects), and the hash that moves one tile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import L from './builtin/workspace/layout.js';

const VIEWPORTS = { wide: [1920, 1080], square: [1000, 1000], tall: [720, 1600] };
const cell = (col, row, colSpan = 1, rowSpan = 1) => ({ col, row, colSpan, rowSpan });
const scene = (id, over = {}) => ({ id, layout: 'stage', ...over });

// shape -> count -> [cols, rows, cells]. 1: full. 2: halves. 3: one big + two small. 4: 2x2. 5 and 6: 3x2 (2x3 when tall).
const TABLE = {
  wide: {
    1: [[1], [1], [cell(1, 1)]],
    2: [[1, 1], [1], [cell(1, 1), cell(2, 1)]],
    3: [[2, 1], [1, 1], [cell(1, 1, 1, 2), cell(2, 1), cell(2, 2)]],
    4: [[1, 1], [1, 1], [cell(1, 1), cell(2, 1), cell(1, 2), cell(2, 2)]],
    5: [[1, 1, 1], [1, 1], [cell(1, 1), cell(2, 1), cell(3, 1), cell(1, 2), cell(2, 2, 2)]],
    6: [[1, 1, 1], [1, 1], [cell(1, 1), cell(2, 1), cell(3, 1), cell(1, 2), cell(2, 2), cell(3, 2)]],
  },
  tall: {
    1: [[1], [1], [cell(1, 1)]],
    2: [[1], [1, 1], [cell(1, 1), cell(1, 2)]],
    3: [[1, 1], [2, 1], [cell(1, 1, 2, 1), cell(1, 2), cell(2, 2)]],
    4: [[1, 1], [1, 1], [cell(1, 1), cell(2, 1), cell(1, 2), cell(2, 2)]],
    5: [[1, 1], [1, 1, 1], [cell(1, 1), cell(2, 1), cell(1, 2), cell(2, 2), cell(1, 3, 2)]],
    6: [[1, 1], [1, 1, 1], [cell(1, 1), cell(2, 1), cell(1, 2), cell(2, 2), cell(1, 3), cell(2, 3)]],
  },
};
TABLE.square = TABLE.wide;

for (const [shape, [w, h]] of Object.entries(VIEWPORTS)) {
  test(`chooseLayout, ${shape} ${w}x${h}: counts 0..8 match the table, cover the grid exactly, and cap at ${L.MAX_TILES} with a "+N more" count`, () => {
    for (let n = 0; n <= 8; n++) {
      const plan = L.chooseLayout(n, w, h);
      const shown = Math.min(n, L.MAX_TILES);
      assert.equal(plan.shape, shape);
      assert.equal(plan.shown, shown, `n=${n}`);
      assert.equal(plan.more, n - shown, `n=${n}`);
      assert.equal(plan.cells.length, shown);
      if (n === 0) {
        assert.deepEqual(plan.cells, []);
        continue;
      }
      const [cols, rows, cells] = TABLE[shape][shown];
      assert.deepEqual([plan.cols, plan.rows, plan.cells], [cols, rows, cells], `n=${n}`);
      // every grid cell is covered by exactly one tile
      const seen = new Map();
      for (const c of plan.cells) {
        assert.ok(c.col >= 1 && c.row >= 1 && c.col + c.colSpan - 1 <= plan.cols.length && c.row + c.rowSpan - 1 <= plan.rows.length, 'inside the grid');
        for (let x = c.col; x < c.col + c.colSpan; x++) for (let y = c.row; y < c.row + c.rowSpan; y++) seen.set(`${x},${y}`, (seen.get(`${x},${y}`) ?? 0) + 1);
      }
      assert.equal(seen.size, plan.cols.length * plan.rows.length, `n=${n}: no empty cell`);
      assert.ok([...seen.values()].every((v) => v === 1), `n=${n}: no overlap`);
    }
  });
}

test('chooseLayout: the shape thresholds, and an unusable size falls back instead of throwing', () => {
  assert.equal(L.shapeOf(1250, 1000), 'wide', 'exactly the wide threshold');
  assert.equal(L.shapeOf(1249, 1000), 'square');
  assert.equal(L.shapeOf(800, 1000), 'tall', 'exactly the tall threshold');
  assert.equal(L.shapeOf(801, 1000), 'square');
  assert.equal(L.shapeOf(0, 0), 'wide', 'the 16:9 fallback');
  assert.equal(L.shapeOf(NaN, 10), 'wide');
  assert.equal(L.chooseLayout('3', 1000, 1000).shown, 3, 'a numeric string counts');
  assert.equal(L.chooseLayout(undefined, 1000, 1000).shown, 0);
  assert.equal(L.chooseLayout(-4, 1000, 1000).more, 0);
});

test('tilesOf: stage scenes, pinned ones and the board; a card, a retired pulse and any other built-in are not tiles', () => {
  const list = [
    scene('board', { builtin: true, pin: true }),
    scene('deck'),
    { id: 'note', layout: 'card' },
    { id: 'pinned', layout: 'card', pin: true },
    scene('pulse', { builtin: true }),
    scene('extra', { builtin: true }),
    { id: '' },
    null,
  ];
  assert.deepEqual(L.tilesOf(list).map((s) => s.id), ['board', 'deck', 'pinned']);
  assert.deepEqual(L.tilesOf(undefined), []);
  assert.equal(L.tilesOf([{ id: 'board' }]).length, 1, 'the board is a tile even if the page lost its flags');
});

test('orderTiles: the picked hero first, then slot big, then auto in publish order (the board first), then side', () => {
  const list = [scene('board'), scene('a'), scene('b', { slot: 'side' }), scene('c', { slot: 'big' }), scene('d', { slot: 'auto' }), scene('e')];
  const ids = (heroId) => L.orderTiles(list, heroId).map((s) => s.id);
  assert.deepEqual(ids(''), ['c', 'board', 'a', 'd', 'e', 'b']);
  assert.deepEqual(ids('e'), ['e', 'c', 'board', 'a', 'd', 'b']);
  assert.deepEqual(ids('b'), ['b', 'c', 'board', 'a', 'd', 'e'], 'a hero beats a side slot');
  assert.deepEqual(ids('gone'), ids(''), 'a hero that is not there changes nothing');
  assert.equal(list[0].id, 'board', 'the input is not reordered');
});

test('tileHash / parseTileHash: a deck hash for one tile survives the round trip', () => {
  assert.equal(L.tileHash('deck', '#/2'), '#deck._2');
  assert.equal(L.tileHash('deck', '#/3/1/2'), '#deck._3_1_2');
  assert.deepEqual(L.parseTileHash('#deck._3_1_2'), { id: 'deck', hash: '#/3/1/2' });
  assert.deepEqual(L.parseTileHash(L.tileHash('my-deck', '#intro')), { id: 'my-deck', hash: '#intro' });
  assert.equal(L.tileHash('deck', 'nohash'), null);
  assert.equal(L.parseTileHash('#nodot'), null);
  assert.equal(L.parseTileHash('#.2'), null);
  assert.equal(L.parseTileHash(undefined), null);
});
