// Unit tests for the DOM-free parts of the house elements: sanitiser, chart-data normaliser, graph layout, small helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHtml, safeUrl } from './components/sanitize.js';
import { dedent, normalizeChartData, alpha, peaks, formatTime, wrapText, flag, parseJson, clamp } from './components/pure.js';
import { layoutGraph, edgeCurve } from './components/graph.js';

// ---------------------------------------------------------------- sanitiser
test('sanitize: scripts and other dangerous elements vanish with their content', () => {
  for (const html of ['<script>alert(1)</script>ok', '<SCRIPT src=x></SCRIPT>ok', '<script>alert(1)ok', '<style>*{x:y}</style>ok', '<iframe src="https://e.x"></iframe>ok',
    '<object data=x>q</object>ok', '<svg onload=alert(1)><script>1</script></svg>ok', '<math><mi>x</mi></math>ok', '<template><b>x</b></template>ok']) {
    const out = sanitizeHtml(html);
    assert.match(out, /^(ok)?$/, html);
    assert.doesNotMatch(out, /script|alert|iframe|style|svg|object|onload/i, html);
  }
  assert.equal(sanitizeHtml('<p>a</p><script>x</script><p>b</p>'), '<p>a</p><p>b</p>');
});

test('sanitize: event handler and style attributes are dropped, harmless ones kept', () => {
  assert.equal(sanitizeHtml('<img src="a.png" onerror="alert(1)" alt="x">'), '<img src="a.png" alt="x">');
  assert.equal(sanitizeHtml('<p onclick=alert(1) style="color:red" id=x class="a b">t</p>'), '<p class="a b">t</p>');
  assert.equal(sanitizeHtml("<b onmouseover='x()' title=\"t\">y</b>"), '<b title="t">y</b>');
  assert.equal(sanitizeHtml('<a href="https://x.dev/a?b=1&c=2">l</a>'), '<a href="https://x.dev/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">l</a>');
  assert.doesNotMatch(sanitizeHtml('<img src=x ONERROR=alert(1)>'), /onerror/i);
  assert.doesNotMatch(sanitizeHtml('<p/onclick=alert(1)>x</p>'), /onclick/i);
});

test('sanitize: javascript: and other schemes cannot get through href/src, however they are disguised', () => {
  const attacks = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', '&#106;avascript:alert(1)',
    '&#x6a;avascript:alert(1)', 'jav&#x09;ascript:alert(1)', 'javascript&colon;alert(1)', '\u0001javascript:alert(1)', 'vbscript:x', 'data:text/html,<script>1</script>', 'file:///etc/passwd'];
  for (const url of attacks) {
    const out = sanitizeHtml(`<a href="${url}">x</a><img src="${url}">`);
    assert.doesNotMatch(out, /href=|src=/i, `${JSON.stringify(url)} -> ${out}`);
  }
  assert.equal(safeUrl('/rel/path.png'), '/rel/path.png');
  assert.equal(safeUrl('img/a.png', { image: true }), 'img/a.png');
  assert.equal(safeUrl('#frag'), '#frag');
  assert.equal(safeUrl('mailto:a@b.dev'), 'mailto:a@b.dev');
  assert.equal(safeUrl('mailto:a@b.dev', { image: true }), null);
  assert.match(safeUrl('data:image/png;base64,iVBORw0KGgo=', { image: true }), /^data:image\/png/);
  assert.equal(safeUrl('data:image/svg+xml;base64,PHN2Zz4=', { image: true }), null);
  assert.equal(safeUrl('data:text/html;base64,PHNjcmlwdD4=', { image: true }), null);
});

test('sanitize: malformed and tricky markup ends up as inert text', () => {
  assert.doesNotMatch(sanitizeHtml('<scr<script>ipt>alert(1)</script>'), /<script|<scr/i);
  assert.equal(sanitizeHtml('a < b > c'), 'a &lt; b &gt; c');
  assert.equal(sanitizeHtml('1 < 2 <3 <= 4'), '1 &lt; 2 &lt;3 &lt;= 4');
  assert.doesNotMatch(sanitizeHtml('<img src="x'), /<img/);
  assert.doesNotMatch(sanitizeHtml('<a href="javascript:x"'), /<a/);
  assert.equal(sanitizeHtml('<!-- <script>x</script> -->k'), 'k');
  assert.equal(sanitizeHtml('<!DOCTYPE html>k'), 'k');
  assert.doesNotMatch(sanitizeHtml('<div<script>x</script>>'), /script/);
  assert.equal(sanitizeHtml('<font color=red>x</font>'), 'x'); // unknown tag: tag dropped, text kept
  assert.equal(sanitizeHtml('Tom &amp; Jerry &copy; &lt;b&gt;'), 'Tom &amp; Jerry &copy; &lt;b&gt;'); // text entities stay entities
  assert.equal(sanitizeHtml('AT&T'), 'AT&amp;T');
  assert.equal(sanitizeHtml(null), '');
});

test('sanitize: normal marked output survives', () => {
  const html = '<h2>Title</h2>\n<p>Hello <strong>bold</strong> and <em>em</em> <code>x</code></p>\n<ul>\n<li>one</li>\n<li><input checked="" disabled="" type="checkbox"> done</li>\n</ul>\n'
    + '<pre><code class="language-js">const a = 1 &lt; 2;\n</code></pre>\n<table><thead><tr><th align="right">h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>\n<blockquote><p>q</p></blockquote><hr><p>x<br>y</p>';
  const out = sanitizeHtml(html);
  for (const part of ['<h2>Title</h2>', '<strong>bold</strong>', '<code class="language-js">', '&lt; 2', '<th align="right">', '<input type="checkbox" disabled checked>', '<hr>', '<br>', '</table>']) assert.ok(out.includes(part), part + ' in ' + out);
  assert.equal(sanitizeHtml(out), out, 'idempotent');
});

test('sanitize: form-ish inputs other than the task checkbox are removed; duplicate attributes use the first', () => {
  assert.equal(sanitizeHtml('<input type="text" value="x">'), '');
  assert.equal(sanitizeHtml('<input type="password">'), '');
  assert.equal(sanitizeHtml('<a href="https://a.dev" href="javascript:x">l</a>'), '<a href="https://a.dev" target="_blank" rel="noopener noreferrer">l</a>');
  assert.equal(sanitizeHtml('<p class="a&quot; onclick=&quot;x">t</p>'), '<p class="a onclickx">t</p>');
});

// ---------------------------------------------------------------- helpers
test('dedent strips blank edges and common indentation', () => {
  assert.equal(dedent('\n    const a = 1;\n      if (a) {}\n    return a;\n  '), 'const a = 1;\n  if (a) {}\nreturn a;');
  assert.equal(dedent(''), '');
  assert.equal(dedent('   \n  '), '');
  assert.equal(dedent('x'), 'x');
});

test('normalizeChartData handles numbers, rows, scatter and native data', () => {
  assert.deepEqual(normalizeChartData([3, 5]), { labels: ['1', '2'], datasets: [{ label: 'value', data: [3, 5] }] });
  const rows = [{ month: 'Jan', a: 1, b: 2 }, { month: 'Feb', a: 3, b: 4 }];
  assert.deepEqual(normalizeChartData(rows), { labels: ['Jan', 'Feb'], datasets: [{ label: 'a', data: [1, 3] }, { label: 'b', data: [2, 4] }] });
  assert.deepEqual(normalizeChartData(rows, { y: 'b' }).datasets, [{ label: 'b', data: [2, 4] }]);
  assert.deepEqual(normalizeChartData(rows, { x: 'a', y: 'b', type: 'scatter' }).datasets[0].data, [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
  const pts = [{ w: 1, h: 2 }, { w: 3, h: 4 }];
  assert.deepEqual(normalizeChartData(pts, { type: 'scatter' }).datasets[0], { label: 'h', data: [{ x: 1, y: 2 }, { x: 3, y: 4 }] });
  const native = { labels: ['x'], datasets: [{ label: 'q', data: [1] }] };
  assert.deepEqual(normalizeChartData(native), native);
  assert.deepEqual(normalizeChartData([]), { labels: [], datasets: [] });
  assert.throws(() => normalizeChartData('nope'), /array/);
  assert.throws(() => normalizeChartData([{ a: 'x' }, 1]), /rows/);
  assert.throws(() => normalizeChartData(rows, { y: 'zzz' }), /no key "zzz"/);
  assert.throws(() => normalizeChartData([{ name: 'a' }]), /numeric/);
});

test('alpha, peaks, formatTime, wrapText, flag, parseJson, clamp', () => {
  assert.equal(alpha('#7aa2ff', 0.5), 'rgba(122, 162, 255, 0.5)');
  assert.equal(alpha('#fff', 1), 'rgba(255, 255, 255, 1)');
  assert.equal(alpha('rgb(1, 2, 3)', 0.2), 'rgba(1, 2, 3, 0.2)');
  assert.equal(alpha('hotpink', 0.2), 'hotpink');
  const p = peaks([0, 0.5, -1, 0.25, 0, 0, 0.1, 0], 4);
  assert.deepEqual(p, [0.5, 1, 0, 0.1]);
  assert.deepEqual(peaks([], 3), [0, 0, 0]);
  assert.deepEqual(peaks([0, 0], 2), [0, 0]);
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(75.9), '1:15');
  assert.equal(formatTime(NaN), '0:00');
  assert.deepEqual(wrapText('Thundering herd of clients', 12), ['Thundering', 'herd of', 'clients']);
  assert.deepEqual(wrapText('', 5), ['']);
  assert.deepEqual(wrapText('averyveryverylongword', 5), ['averyveryverylongword']);
  assert.deepEqual([flag(null), flag(''), flag('true'), flag('false'), flag('0')], [false, true, true, false, false]);
  assert.deepEqual(parseJson('[1]'), { value: [1] });
  assert.match(parseJson('{bad').error, /JSON|property|Expected/i);
  assert.equal(clamp(5, 0, 3), 3);
});

// ---------------------------------------------------------------- graph layout
const box = (id) => ({ id, w: 100, h: 40 });
test('layoutGraph: chain gets increasing layers left to right with no overlaps', () => {
  const g = layoutGraph(['a', 'b', 'c'].map(box), [['a', 'b'], ['b', 'c']]);
  const [a, b, c] = ['a', 'b', 'c'].map((id) => g.nodes.get(id));
  assert.deepEqual([a.layer, b.layer, c.layer], [0, 1, 2]);
  assert.ok(a.x + a.w < b.x && b.x + b.w < c.x);
  assert.ok(g.width >= c.x + c.w && g.height >= a.y + a.h);
});

test('layoutGraph: branches share a layer, do not overlap and stay inside the box; tb swaps the axes', () => {
  const ids = ['s', 'x', 'y', 'z', 't'];
  const edges = [['s', 'x'], ['s', 'y'], ['s', 'z'], ['x', 't'], ['y', 't'], ['z', 't']];
  for (const direction of ['lr', 'tb']) {
    const g = layoutGraph(ids.map(box), edges, { direction });
    const mid = ['x', 'y', 'z'].map((id) => g.nodes.get(id));
    assert.ok(mid.every((n) => n.layer === 1));
    const sorted = [...mid].sort((p, q) => (direction === 'lr' ? p.y - q.y : p.x - q.x));
    for (let i = 1; i < 3; i++) {
      if (direction === 'lr') assert.ok(sorted[i - 1].y + sorted[i - 1].h <= sorted[i].y); else assert.ok(sorted[i - 1].x + sorted[i - 1].w <= sorted[i].x);
    }
    for (const n of g.nodes.values()) assert.ok(n.x >= 0 && n.y >= 0 && n.x + n.w <= g.width && n.y + n.h <= g.height, JSON.stringify(n));
    const s = g.nodes.get('s');
    const t = g.nodes.get('t');
    if (direction === 'lr') assert.ok(s.x < t.x); else assert.ok(s.y < t.y);
  }
});

test('layoutGraph: cycles terminate, back edges are reported, unknown endpoints and self loops are ignored', () => {
  const g = layoutGraph(['a', 'b', 'c'].map(box), [['a', 'b'], ['b', 'c'], ['c', 'a'], ['a', 'a'], ['a', 'ghost']]);
  assert.deepEqual([...g.back], ['c>a']);
  assert.deepEqual(['a', 'b', 'c'].map((id) => g.nodes.get(id).layer), [0, 1, 2]);
  const lone = layoutGraph([box('only')], []);
  assert.equal(lone.nodes.size, 1);
  assert.deepEqual(layoutGraph([], []).nodes.size, 0);
});

test('edgeCurve: forward edges leave the right side and arrive at the left side; back edges loop underneath', () => {
  const g = layoutGraph(['a', 'b'].map(box), [['a', 'b']]);
  const a = g.nodes.get('a');
  const b = g.nodes.get('b');
  const fwd = edgeCurve(a, b);
  assert.equal(fwd.points[0].x, a.x + a.w);
  assert.equal(fwd.points[3].x, b.x);
  assert.match(fwd.d, /^M[\d.,-]+ C/);
  assert.ok(fwd.mid.x > a.x + a.w && fwd.mid.x < b.x);
  const back = edgeCurve(b, a, { back: true });
  assert.equal(back.points[0].y, b.y + b.h);
  assert.ok(back.points[1].y > back.points[0].y);
  const down = edgeCurve(a, { ...b, layer: 1 }, { direction: 'tb' });
  assert.equal(down.points[0].y, a.y + a.h);
});
