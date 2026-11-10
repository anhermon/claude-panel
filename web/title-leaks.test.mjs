import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './testkit.mjs';
import { normalizeData as boardData, capTitle } from './builtin/board/board-logic.mjs';
import { normalizeTickets } from './builtin/board/router-frames-logic.mjs';
import { normalizeKindStack, normalizeRepeats } from './builtin/board/insight-frames-logic.mjs';
import { normalizeData as agentsData } from './builtin/agents-info/agents-info-logic.mjs';
import { captionOf } from './builtin/agents-info/event-fx.mjs';
import { idHint, retitle, titleOf } from './builtin/agents-info/title-of.mjs';
import { normalizeDetail } from './builtin/agents-info/detail-logic.mjs';
import { normalizeRun } from './builtin/agents-info/detail-run-logic.mjs';
import { normalizeProgress, normalizeStruggles } from './builtin/agents-info/detail-progress-logic.mjs';
import { laneTitle } from './builtin/board/lane-format.mjs';
import { loadBrowserScripts } from './fake-dom.mjs';

const RAW = 'T50: workflow-insight frame T65';
const SLUG = '01-slug-name';
const TEXT_CAP = 80;
const TICKET_TOKEN = /\bT\d+\b/i;
const SLUG_TOKEN = /^\d{2}-[a-z]/i;
const SCRIPTS = ['blocks.js', 'scenes.js', 'events-client.js', 'workspace/layout.js', 'stage.js', 'rail.js', 'ui.js'];
const clean = (texts) => {
  for (const text of texts) {
    assert.equal(typeof text, 'string');
    assert.doesNotMatch(text, TICKET_TOKEN);
    assert.doesNotMatch(text, SLUG_TOKEN);
  }
};

for (const raw of [RAW, SLUG]) {
  test(`ticker captions clean work-event payloads and unknown-agent events: ${raw}`, () => {
    const agent = { id: 'worker', name: raw };
    const event = { agent: agent.id, kind: 'work', text: `T63 · ${raw}` };
    clean([captionOf(event, [agent]), captionOf(event, []), retitle(`See ${raw}`, [])]);
  });

  test(`list, crew and ticket titles and hover labels are plain: ${raw}`, () => {
    const agent = { id: 'worker', name: raw, ticket: { id: 'T63', title: raw } };
    clean([titleOf(agent), idHint(agent), titleOf({ isMain: true, title: raw }), laneTitle({ goal: raw }), capTitle(raw, TEXT_CAP)]);
    const { items } = normalizeTickets({ items: [{ id: 'T63', title: raw, agent: raw, note: raw, dependsOn: [SLUG, 'T65'] }] });
    clean(items.flatMap((item) => [item.title, item.agent, item.note, ...item.after]));
    assert.equal(items[0].id, 'T63', 'ticket lookup id stays intact');
  });

  test(`board frame titles, Now, lane fields and checklist items are plain: ${raw}`, () => {
    const data = boardData({ now: { title: raw }, lanes: [{ id: 'lane', label: raw, goal: raw, step: raw, note: raw, dod: [{ t: raw }] }], frames: [{ id: 'now', type: 'now', title: raw }] });
    clean([data.now.title, data.frames[0].title, data.frames[0].text, ...data.lanes.flatMap((lane) => [lane.label, lane.goal, lane.step, lane.note, ...lane.dod.map((d) => d.t)])]);
  });

  test(`workflow insight labels clean older and posted data: ${raw}`, () => {
    const stack = normalizeKindStack({ caption: raw, items: [{ label: raw, segs: [{ k: 'tests', s: 1 }] }] });
    const repeats = normalizeRepeats({ caption: raw, cols: [raw], rows: [{ label: raw, cells: [1] }] });
    clean([stack.caption, stack.items[0].label, repeats.caption, ...repeats.cols, repeats.rows[0].label]);
  });

  test(`agent normalization, run descriptions, briefs and detail headings are plain: ${raw}`, () => {
    const { agents } = agentsData({ agents: [{ id: 'worker', state: 'working', title: raw, headline: raw, note: raw, ticket: { id: 'T63', title: raw, text: raw } }] });
    const detail = normalizeDetail({ id: 'worker', name: raw, brief: raw, transcript: {}, metrics: {} });
    const run = normalizeRun({ status: 'running', title: raw, prompt: { text: raw } });
    const progress = normalizeProgress({ plan: { label: raw }, phases: [{ label: raw, a: 0, b: 1 }], issues: { list: [{ title: raw }] } });
    const struggles = normalizeStruggles({ headline: raw, items: [{ kind: 'slow-call', title: raw, t: 0 }], calm: [{ title: raw }] });
    clean([agents[0].title, agents[0].headline, agents[0].note, agents[0].ticket.title, agents[0].ticket.text, detail.name, detail.brief, run.title, run.prompt.text, progress.plan.label, progress.phases[0].label, progress.issues.list[0].title, struggles.headline, struggles.items[0].title, struggles.calm[0].title]);
  });

  test(`browser page headers, card titles, scene strips and rail titles are plain: ${raw}`, () => {
    const { ctx, doc } = loadBrowserScripts(SCRIPTS);
    ctx.PanelUI.render({ v: 4, status: 'working', task: { title: raw }, cards: [{ id: 'card', title: raw, blocks: [{ kind: 'text', text: 'Body' }] }], scenes: [{ id: 'scene', title: raw, layout: 'stage', alt: raw }] });
    clean([doc.title, doc.getElementById('head').textContent, doc.getElementById('cards').textContent, doc.getElementById('rail-title').textContent, doc.getElementById('stage').textContent]);
    for (const node of doc.getElementById('stage').findAll((n) => n.tagName === 'IFRAME')) clean([node.title]);
  });
}


test('the shared title module resolves and is served from scene and page URLs', async () => {
  const TEMP_PREFIX = 'panel-title-modules-';
  const STATE_FILE = 'state.json';
  const STATUS_OK = 200;
  const SCENE_ID = 'agents-info';
  const SCENE_MODULE = 'title-of.mjs';
  const SHARED_MODULE = '../../kit/panel/plain-title.mjs';
  const CLASSIC_MODULE = '../../plain-title.js';
  const root = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const stateFile = join(root, STATE_FILE);
  writeFileSync(stateFile, JSON.stringify({ v: 4, scenes: [{ id: SCENE_ID, entry: 'index.html', dir: fileURLToPath(new URL('./builtin/agents-info', import.meta.url)) }] }));
  let server;
  try {
    server = await startServer(stateFile);
    const sceneURL = new URL(`${server.base}/s/${SCENE_ID}/${SCENE_MODULE}`);
    const sharedURL = new URL(SHARED_MODULE, sceneURL);
    const classicURL = new URL(CLASSIC_MODULE, sharedURL);
    for (const url of [sceneURL, sharedURL, classicURL]) {
      const response = await server.get(url.pathname);
      assert.equal(response.status, STATUS_OK, url.pathname);
      assert.match(response.text, /plainTitle/);
    }
  } finally {
    server?.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
