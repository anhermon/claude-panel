"use strict";
/* Workspace layout: PURE functions shared by the browser stage (web/stage.js), the terminal's workspace page
 * (workspace.js) and the tests. Classic script on purpose: the browser loads it with a <script> tag (it sets
 * globalThis.PanelWorkspaceLayout); node loads it as CommonJS (module.exports).
 *
 *   tilesOf(scenes)            which scenes are tiles: stage scenes and pinned ones; the board always, the agents scene when the mod registered it, other built-ins never
 *   orderTiles(tiles, heroId)  the picked hero first, then slot "big", then "auto" in publish order, then "side"
 *   chooseLayout(n, w, h)      the grid for n tiles in a w x h viewport: tracks (fr) and one cell per shown tile
 *   tileHash / parseTileHash   the hash that moves one tile (`#<id>.<h>_<v>`), used by `scene {id, goto}` */
(function (root) {
  const BOARD_ID = "board";
  const AGENTS_INFO_ID = "agents-info";
  const STAGE_LAYOUT = "stage";
  const SLOT_BIG = "big";
  const SLOT_SIDE = "side";
  const MAX_TILES = 6; // more than this: the first MAX_TILES and a "+N more" chip
  const WIDE_MIN_RATIO = 1.25; // width / height at or above: columns
  const TALL_MAX_RATIO = 0.8; // at or below: rows
  const FALLBACK_SIZE = { width: 1280, height: 720 };
  const HASH_SEP = ".";
  const PATH_SEP = "/";
  const PATH_SEP_IN_HASH = "_";

  const RANK = { hero: 0, big: 1, auto: 2, side: 3 };
  const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

  function isTile(s) {
    if (!isObj(s) || typeof s.id !== "string" || s.id === "") return false;
    if (s.builtin === true && s.id !== BOARD_ID && s.id !== AGENTS_INFO_ID) return false;
    return s.id === BOARD_ID || s.layout === STAGE_LAYOUT || s.pin === true;
  }
  const tilesOf = (scenes) => (Array.isArray(scenes) ? scenes.filter(isTile) : []);

  function rankOf(s, heroId) {
    if (heroId && s.id === heroId) return RANK.hero;
    if (s.slot === SLOT_BIG) return RANK.big;
    return s.slot === SLOT_SIDE ? RANK.side : RANK.auto;
  }
  /* A stable sort: scenes of one rank keep the order they were given in (the board first, then publish order). */
  function orderTiles(tiles, heroId) {
    return tiles
      .map((s, i) => ({ s, i, r: rankOf(s, heroId) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.s);
  }

  const cell = (col, row, colSpan = 1, rowSpan = 1) => ({ col, row, colSpan, rowSpan });

  /* A cols x rows grid filled row by row; an unfinished last row is filled by stretching its last tile. */
  function gridCells(n, cols) {
    const cells = [];
    for (let i = 0; i < n; i++) cells.push(cell((i % cols) + 1, Math.floor(i / cols) + 1));
    const left = cols - (n % cols || cols);
    if (left > 0) cells[n - 1].colSpan += left;
    return cells;
  }

  function shapeOf(width, height) {
    const w = Number.isFinite(width) && width > 0 ? width : FALLBACK_SIZE.width;
    const h = Number.isFinite(height) && height > 0 ? height : FALLBACK_SIZE.height;
    const ratio = w / h;
    return ratio >= WIDE_MIN_RATIO ? "wide" : ratio <= TALL_MAX_RATIO ? "tall" : "square";
  }

  /* -> { shape, shown, more, cols: [fr], rows: [fr], cells: [{col,row,colSpan,rowSpan}] (1-based, one per shown tile) } */
  function chooseLayout(count, width, height) {
    const shape = shapeOf(width, height);
    const n = Math.min(MAX_TILES, Math.max(0, Math.floor(Number(count)) || 0));
    const more = Math.max(0, (Math.floor(Number(count)) || 0) - n);
    const isTall = shape === "tall";
    const out = (cols, rows, cells) => ({ shape, shown: n, more, cols, rows, cells });
    if (n <= 1) return out([1], [1], n === 0 ? [] : [cell(1, 1)]);
    if (n === 2) return isTall ? out([1], [1, 1], gridCells(2, 1)) : out([1, 1], [1], gridCells(2, 2));
    if (n === 3) {
      // one big tile and two small: the big one on the left (wide, square) or on top (tall)
      return isTall
        ? out([1, 1], [2, 1], [cell(1, 1, 2, 1), cell(1, 2), cell(2, 2)])
        : out([2, 1], [1, 1], [cell(1, 1, 1, 2), cell(2, 1), cell(2, 2)]);
    }
    if (n === 4) return out([1, 1], [1, 1], gridCells(4, 2));
    const cols = isTall ? 2 : 3;
    const rows = Math.ceil(n / cols);
    return out(Array(cols).fill(1), Array(rows).fill(1), gridCells(n, cols));
  }

  /* `scene {id, goto: "#/2/0"}` -> "#board.2_0"-style hash the workspace page reads. null when it cannot be spelled. */
  function tileHash(id, hash) {
    if (typeof hash !== "string" || !hash.startsWith("#")) return null;
    return "#" + id + HASH_SEP + hash.slice(1).split(PATH_SEP).join(PATH_SEP_IN_HASH);
  }
  /* The inverse: "#board.2_0" -> { id: "board", hash: "#/2/0" }; null for anything else. */
  function parseTileHash(hash) {
    if (typeof hash !== "string" || !hash.startsWith("#")) return null;
    const at = hash.indexOf(HASH_SEP);
    if (at < 2) return null;
    return { id: hash.slice(1, at), hash: "#" + hash.slice(at + 1).split(PATH_SEP_IN_HASH).join(PATH_SEP) };
  }

  const api = {
    BOARD_ID, MAX_TILES, WIDE_MIN_RATIO, TALL_MAX_RATIO, isTile, tilesOf, orderTiles, chooseLayout, shapeOf, tileHash, parseTileHash,
  };
  root.PanelWorkspaceLayout = api;
  if (typeof module === "object" && module !== null && module.exports) module.exports = api;
})(globalThis);
