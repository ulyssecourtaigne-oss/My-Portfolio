// charts.js — dependency-free SVG charts (donut, indexed line chart) with hover tooltips.
import { svg, h, clear, fmtMoney, fmtNum } from './ui.js';

export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];

/** data: [{label, value}] — top 7 kept in given order, rest folded into "Other". */
export function donut(data, { title, format = (v) => fmtNum(v, 0), size = 180 } = {}) {
  const items = data.filter((d) => d.value > 0);
  const total = items.reduce((a, d) => a + d.value, 0);
  const wrap = h('div', { class: 'chart donut-chart' });
  if (title) wrap.append(h('h3', null, title));
  if (!total) {
    wrap.append(h('p', { class: 'muted' }, 'Nothing to show yet.'));
    return wrap;
  }
  let shown = items.slice(0, 7);
  if (items.length > 7) shown = [...shown, { label: 'Other', value: items.slice(7).reduce((a, d) => a + d.value, 0) }];
  const r = size / 2 - 8;
  const cx = size / 2;
  const cy = size / 2;
  const stroke = 26;
  const circ = 2 * Math.PI * (r - stroke / 2);
  const g = svg('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img', 'aria-label': title || 'allocation' });
  const centre = svg('text', { x: cx, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'donut-centre' }, '100%');
  let offset = 0;
  const legend = h('ul', { class: 'legend' });
  shown.forEach((d, i) => {
    const frac = d.value / total;
    const len = Math.max(0, frac * circ - 2); // 2px surface gap between segments
    const seg = svg('circle', {
      cx, cy, r: r - stroke / 2, fill: 'none', stroke: SERIES[i % SERIES.length], 'stroke-width': stroke,
      'stroke-dasharray': `${len} ${circ - len}`, 'stroke-dashoffset': -offset, transform: `rotate(-90 ${cx} ${cy})`,
      class: 'donut-seg',
    });
    const show = () => { centre.textContent = `${(frac * 100).toFixed(1)}%`; seg.classList.add('hot'); li.classList.add('hot'); };
    const hide = () => { centre.textContent = '100%'; seg.classList.remove('hot'); li.classList.remove('hot'); };
    seg.addEventListener('mouseenter', show);
    seg.addEventListener('mouseleave', hide);
    seg.append(svg('title', null, `${d.label}: ${format(d.value)} (${(frac * 100).toFixed(1)}%)`));
    g.append(seg);
    offset += frac * circ;
    const li = h('li', { onMouseenter: show, onMouseleave: hide },
      h('span', { class: 'swatch', style: { background: SERIES[i % SERIES.length] } }),
      h('span', { class: 'legend-label' }, d.label),
      h('span', { class: 'legend-value' }, `${(frac * 100).toFixed(1)}%`),
      h('span', { class: 'legend-sub' }, format(d.value)));
    legend.append(li);
  });
  g.append(centre);
  wrap.append(h('div', { class: 'donut-row' }, g, legend));
  return wrap;
}

/**
 * Multi-series line chart with a shared x (dates) axis, crosshair + tooltip.
 * series: [{ name, points: [{x: 'YYYY-MM-DD', y}], format }]
 */
export function lineChart(series, { title, width = 720, height = 260, yFormat = (v) => fmtNum(v, 1), baseline = null } = {}) {
  const wrap = h('div', { class: 'chart line-chart' });
  if (title) wrap.append(h('h3', null, title));
  const dates = [...new Set(series.flatMap((s) => s.points.filter((p) => p.y != null && Number.isFinite(p.y)).map((p) => p.x)))].sort();
  if (dates.length < 2) {
    wrap.append(h('p', { class: 'muted' }, 'Needs at least two daily snapshots. Snapshots are saved automatically once a day while the page is open with prices.'));
    return wrap;
  }
  const pad = { l: 56, r: 16, t: 12, b: 28 };
  const W = width;
  const H = height;
  const ys = series.flatMap((s) => s.points.map((p) => p.y)).filter((v) => v != null && Number.isFinite(v));
  if (baseline != null) ys.push(baseline);
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const yPad = (yMax - yMin) * 0.08;
  yMin -= yPad; yMax += yPad;
  const xi = new Map(dates.map((d, i) => [d, i]));
  const t0 = Date.parse(dates[0]);
  const t1 = Date.parse(dates[dates.length - 1]);
  const X = (d) => pad.l + ((Date.parse(d) - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);
  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'line-svg', role: 'img', 'aria-label': title || 'chart' });
  // grid
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = yMin + ((yMax - yMin) * i) / ticks;
    g.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v), class: 'grid' }));
    g.append(svg('text', { x: pad.l - 8, y: Y(v), 'text-anchor': 'end', 'dominant-baseline': 'middle', class: 'axis' }, yFormat(v)));
  }
  if (baseline != null) g.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: Y(baseline), y2: Y(baseline), class: 'baseline' }));
  const xTicks = Math.min(6, dates.length);
  for (let i = 0; i < xTicks; i++) {
    const d = dates[Math.round((i * (dates.length - 1)) / Math.max(1, xTicks - 1))];
    g.append(svg('text', { x: X(d), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === xTicks - 1 ? 'end' : 'middle', class: 'axis' }, d.slice(5)));
  }
  // lines
  series.forEach((s, i) => {
    const pts = s.points.filter((p) => p.y != null && Number.isFinite(p.y) && xi.has(p.x)).sort((a, b) => (a.x < b.x ? -1 : 1));
    if (!pts.length) return;
    const d = pts.map((p, j) => `${j ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
    g.append(svg('path', { d, fill: 'none', stroke: SERIES[i], 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    const last = pts[pts.length - 1];
    g.append(svg('circle', { cx: X(last.x), cy: Y(last.y), r: 4, fill: SERIES[i], stroke: 'var(--surface)', 'stroke-width': 2 }));
  });
  // crosshair + tooltip
  const cross = svg('line', { y1: pad.t, y2: H - pad.b, class: 'crosshair', visibility: 'hidden' });
  const dots = series.map((s, i) => svg('circle', { r: 5, fill: SERIES[i], stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }));
  g.append(cross, ...dots);
  const tip = h('div', { class: 'tooltip', hidden: true });
  const hit = svg('rect', { x: pad.l, y: pad.t, width: W - pad.l - pad.r, height: H - pad.t - pad.b, fill: 'transparent' });
  hit.addEventListener('mousemove', (e) => {
    const rect = g.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const tx = t0 + ((px - pad.l) / (W - pad.l - pad.r)) * (t1 - t0);
    let d = dates[0];
    for (const dd of dates) if (Math.abs(Date.parse(dd) - tx) < Math.abs(Date.parse(d) - tx)) d = dd;
    cross.setAttribute('x1', X(d)); cross.setAttribute('x2', X(d)); cross.setAttribute('visibility', 'visible');
    clear(tip);
    tip.append(h('div', { class: 'tip-date' }, d));
    series.forEach((s, i) => {
      const p = s.points.find((q) => q.x === d);
      if (p && p.y != null && Number.isFinite(p.y)) {
        dots[i].setAttribute('cx', X(d)); dots[i].setAttribute('cy', Y(p.y)); dots[i].setAttribute('visibility', 'visible');
        tip.append(h('div', { class: 'tip-row' }, h('span', { class: 'swatch', style: { background: SERIES[i] } }), h('span', null, s.name), h('b', null, (s.format || yFormat)(p.y))));
      } else dots[i].setAttribute('visibility', 'hidden');
    });
    tip.hidden = false;
    const left = (e.clientX - rect.left) / rect.width;
    tip.style.left = `${Math.min(92, Math.max(0, left * 100))}%`;
    tip.style.transform = left > 0.6 ? 'translateX(-100%)' : 'none';
  });
  hit.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); tip.hidden = true; });
  g.append(hit);
  const legend = h('ul', { class: 'legend inline' }, series.map((s, i) => h('li', null, h('span', { class: 'swatch', style: { background: SERIES[i] } }), s.name)));
  wrap.append(h('div', { class: 'chart-area' }, g, tip), legend);
  return wrap;
}

export { fmtMoney };
