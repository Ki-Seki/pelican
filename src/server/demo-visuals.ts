// The demo session that draws: a chart as a Claude Desktop visual, and a page Claude writes.

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SIGNUPS = [1420, 1588, 1710, 2214, 1966, 1702, 1880];

export const SIGNUPS_CSV = `day,signups\n${DAYS.map((d, i) => `${d},${SIGNUPS[i]}`).join('\n')}\n`;

/** A bar chart in the vocabulary of Claude Desktop's visuals (box, th, ts, c-*), sized to read on a phone. */
export function signupsChart(): string {
  const max = Math.max(...SIGNUPS);
  const bars = SIGNUPS.map((value, i) => {
    const h = Math.round((value / max) * 128);
    const x = 26 + i * 52;
    const y = 196 - h;
    const tone = value === max ? 'c-purple' : 'c-teal';
    return `<g class="${tone}"><rect x="${x}" y="${y}" width="38" height="${h}" rx="6"/></g>`
      + `<text class="ts" x="${x + 19}" y="${y - 8}" text-anchor="middle">${(value / 1000).toFixed(1)}k</text>`
      + `<text class="ts" x="${x + 19}" y="216" text-anchor="middle">${DAYS[i]}</text>`;
  }).join('');
  return `<svg width="100%" viewBox="0 0 400 228" role="img"><title>Signups by day, last week</title>`
    + `<text class="th" x="16" y="24">Signups by day · last week</text>`
    + `<text class="ts" x="16" y="42">12,480 in total, 18% more than the week before</text>`
    + `<line x1="16" y1="196.5" x2="384" y2="196.5" style="stroke:var(--line)"/>`
    + `${bars}</svg>`;
}

export const REPORT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signups · week 45</title>
<style>
  :root { color-scheme: light dark; --ink: #17181a; --soft: #6b6e75; --line: #e6e6e3; --card: #fff; --bg: #f6f6f3; --a: #0e7490; --b: #7c6cf2; }
  @media (prefers-color-scheme: dark) { :root { --ink: #ececea; --soft: #a5a8ae; --line: #2a2d31; --card: #16181b; --bg: #0e0f11; --a: #3ba7bd; --b: #9d90f5; } }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--ink); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 28px 20px 40px; }
  main { max-width: 640px; margin: 0 auto; }
  .eyebrow { color: var(--a); font-weight: 600; font-size: 13px; letter-spacing: .02em; }
  h1 { margin-top: 6px; font-size: 30px; line-height: 1.1; letter-spacing: -.03em; }
  .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 22px; }
  .kpi { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px; }
  .kpi b { display: block; font-size: 24px; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
  .kpi span { color: var(--soft); font-size: 12.5px; }
  .up { color: #16a34a; }
  .chart { margin-top: 14px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px 14px 10px; }
  .bars { display: flex; align-items: flex-end; gap: 8px; height: 170px; }
  .bar { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 6px; height: 100%; }
  .bar i { display: block; width: 100%; border-radius: 8px 8px 4px 4px; background: color-mix(in srgb, var(--a) 75%, transparent); height: 0; transition: height .9s cubic-bezier(.2,.8,.2,1); }
  .bar.top i { background: var(--b); }
  .bar small { color: var(--soft); font-size: 11.5px; }
  p.note { margin-top: 16px; color: var(--soft); }
</style>
</head>
<body>
<main>
  <div class="eyebrow">Growth · week 45</div>
  <h1>Signups grew 18%, and Thursday led the week</h1>
  <div class="kpis">
    <div class="kpi"><b data-count="12480">0</b><span>signups</span></div>
    <div class="kpi"><b class="up">+18%</b><span>on week 44</span></div>
    <div class="kpi"><b>Thu</b><span>best day, 2,214</span></div>
  </div>
  <div class="chart"><div class="bars" id="bars"></div></div>
  <p class="note">Thursday's newsletter brought the peak; the weekend held above the weekday average.</p>
</main>
<script>
  const days = ${JSON.stringify(DAYS)};
  const values = ${JSON.stringify(SIGNUPS)};
  const max = Math.max(...values);
  const bars = document.getElementById('bars');
  values.forEach((v, i) => {
    const bar = document.createElement('div');
    bar.className = 'bar' + (v === max ? ' top' : '');
    bar.innerHTML = '<small>' + v.toLocaleString() + '</small><i></i><small>' + days[i] + '</small>';
    bars.append(bar);
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.querySelector('i').style.height = (v / max * 120) + 'px'; }));
  });
  for (const el of document.querySelectorAll('[data-count]')) {
    const end = Number(el.dataset.count); const start = performance.now();
    const step = (t) => { const k = Math.min(1, (t - start) / 900); el.textContent = Math.round(end * (1 - Math.pow(1 - k, 3))).toLocaleString(); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
</script>
</body>
</html>
`;
