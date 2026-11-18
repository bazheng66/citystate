// 报告里的图：从实验结果直接算出数据，画成独立的 SVG（白底，任何 Markdown 查看器里都能看）。
// 由 tools/report.js 调用，输出到 bench/figs/。
const fs = require("fs");
const path = require("path");

const FONT = "'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif";
const INK = "#0b0b0b";
const SUB = "#52514e";
const MUTED = "#898781";
const GRID = "#e1e0d9";
const AXIS = "#c3c2b7";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// series: [{ name, color, dash, values: [数或 null] }]；bars: 同结构，画成分组柱
// refs: [{ value, label }] 横向参考线
function chart({ title, subtitle, cats, series = [], bars = [], refs = [], yLabel, unit = "", W = 760, H = 380 }) {
  const subs = [].concat(subtitle || []);
  const L = 64, R = 24, T = 92 + Math.max(0, subs.length - 1) * 18, B = 52;
  const LY = 66 + Math.max(0, subs.length - 1) * 18;
  const pw = W - L - R, ph = H - T - B;
  const all = series.concat(bars).flatMap((s) => s.values).concat(refs.map((r) => r.value)).filter((v) => v != null);
  const ymax = niceMax(Math.max(...all) * 1.12);
  const y = (v) => T + ph - (v / ymax) * ph;
  const step = pw / cats.length;
  const cx = (i) => L + step * (i + 0.5);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}">`;
  s += `<rect width="${W}" height="${H}" fill="#ffffff"/>`;
  s += `<text x="${L - 40}" y="28" font-size="17" font-weight="500" fill="${INK}">${esc(title)}</text>`;
  subs.forEach((t, i) => { s += `<text x="${L - 40}" y="${50 + i * 18}" font-size="13" fill="${SUB}">${esc(t)}</text>`; });
  // 图例
  let lx = L - 40;
  for (const it of bars.map((b) => Object.assign({ kind: "bar" }, b)).concat(series.map((x) => Object.assign({ kind: "line" }, x)), refs.map((r) => ({ kind: "ref", name: r.label })))) {
    if (it.kind === "bar") s += `<rect x="${lx}" y="${LY}" width="11" height="11" rx="2" fill="${it.color}"/>`;
    else if (it.kind === "line") s += `<line x1="${lx}" y1="${LY + 6}" x2="${lx + 18}" y2="${LY + 6}" stroke="${it.color}" stroke-width="2.5" ${it.dash ? `stroke-dasharray="${it.dash}"` : ""}/>`;
    else s += `<line x1="${lx}" y1="${LY + 6}" x2="${lx + 18}" y2="${LY + 6}" stroke="${MUTED}" stroke-width="1.2" stroke-dasharray="4 3"/>`;
    const w = (it.kind === "bar" ? 16 : 24);
    s += `<text x="${lx + w}" y="${LY + 10}" font-size="12.5" fill="${SUB}">${esc(it.name)}</text>`;
    lx += w + it.name.length * 13 + 22;
  }
  // 网格与坐标轴
  const NT = [3, 6, 12, 15, 30, 60, 120, 150].some((k) => Math.abs(ymax / k - Math.round(ymax / k)) < 1e-9 && Math.round(ymax / k) <= 10 && ymax % 6 === 0) ? 6 : 5;
  for (let i = 0; i <= NT; i++) {
    const v = (ymax / NT) * i;
    s += `<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" stroke="${i ? GRID : AXIS}" stroke-width="1"/>`;
    s += `<text x="${L - 8}" y="${y(v) + 4}" font-size="12" fill="${MUTED}" text-anchor="end">${+v.toFixed(1)}</text>`;
  }
  if (yLabel) s += `<text x="16" y="${T + ph / 2}" font-size="12" fill="${MUTED}" text-anchor="middle" transform="rotate(-90 16 ${T + ph / 2})">${esc(yLabel)}</text>`;
  cats.forEach((c, i) => { s += `<text x="${cx(i)}" y="${H - B + 22}" font-size="12.5" fill="${SUB}" text-anchor="middle">${esc(c)}</text>`; });
  // 柱：每组不超过 24px 粗，柱间 2px 白缝，顶端圆角
  if (bars.length) {
    const bw = Math.min(24, (step * 0.7) / bars.length);
    bars.forEach((b, k) => {
      b.values.forEach((v, i) => {
        if (v == null) return;
        const x = cx(i) - (bars.length * bw) / 2 + k * bw + 1;
        const h = Math.max(1, T + ph - y(v));
        const w = bw - 2;
        const r = Math.min(4, w / 2, h);
        s += `<path d="M${x},${T + ph} V${y(v) + r} Q${x},${y(v)} ${x + r},${y(v)} H${x + w - r} Q${x + w},${y(v)} ${x + w},${y(v) + r} V${T + ph} Z" fill="${b.color}"/>`;
        if (b.labels) s += `<text x="${x + w / 2}" y="${y(v) - 5}" font-size="11.5" fill="${INK}" text-anchor="middle">${+v.toFixed(1)}</text>`;
      });
    });
  }
  for (const r of refs) s += `<line x1="${L}" y1="${y(r.value)}" x2="${W - R}" y2="${y(r.value)}" stroke="${MUTED}" stroke-width="1.2" stroke-dasharray="4 3"/>`;
  // 线：2.5px，端点圆点带白圈；末端直接标数值
  for (const se of series) {
    const pts = se.values.map((v, i) => (v == null ? null : [cx(i), y(v)]));
    const segs = [];
    let cur = [];
    for (const p of pts) { if (p) cur.push(p); else if (cur.length) { segs.push(cur); cur = []; } }
    if (cur.length) segs.push(cur);
    for (const g of segs) s += `<polyline points="${g.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${se.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" ${se.dash ? `stroke-dasharray="${se.dash}"` : ""}/>`;
    for (const p of pts) if (p) s += `<circle cx="${p[0]}" cy="${p[1]}" r="4.5" fill="${se.color}" stroke="#ffffff" stroke-width="2"/>`;
    (se.labelAt || []).forEach((i) => { const p = pts[i]; if (p) s += `<text x="${p[0] + (se.dx || 8)}" y="${p[1] + (se.dy || -8)}" font-size="11.5" fill="${INK}">${+se.values[i].toFixed(1)}${unit}</text>`; });
  }
  return s + "</svg>\n";
}

// rs：report.js 里去重后的全部有效结果
module.exports = function makeFigs(rs, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const pick = (sim, n, fn) => {
    const g = rs.filter((r) => r.shell === "tauri" && (r.group.startsWith("backend-") || r.group.startsWith("backlimit-")) && (r.query.sim || "main") === sim && r.query.bench === n && r.res);
    return g.length ? avg(g.map(fn)) : null;
  };
  const NS = [10000, 20000, 30000, 40000, 50000, 60000];
  const cats = NS.map((n) => n / 10000 + " 万兵");
  const fps = (r) => r.res.avgFps;
  const step = (r) => (r.res.remote ? r.res.remote.backendStepMs : null);
  const hz = (r) => (r.res.remote ? r.res.remote.snapHz : null);
  const out = {};
  const save = (name, svg) => { fs.writeFileSync(path.join(outDir, name), svg); out[name] = true; };

  if (pick("main", 10000, fps) != null && pick("rustp", 60000, fps) != null) {
    save("fps.svg", chart({
      title: "图 1 · 平均帧率随兵数变化（Tauri）",
      subtitle: ["Worker 和 Rust 两条线几乎重合：帧率的提升来自“离开主线程”，不是来自 Rust", "1–3 万兵各 3 轮，4–6 万兵各 2 轮取均值；主线程 JS 只测到 3 万兵"],
      cats, yLabel: "平均 FPS", refs: [{ value: 30, label: "30 FPS" }],
      series: [
        { name: "主线程 JS", color: "#898781", values: NS.map((n) => pick("main", n, fps)), labelAt: [1, 2] },
        { name: "Web Worker", color: "#2a78d6", values: NS.map((n) => pick("workerp", n, fps)), labelAt: [5], dy: -10 },
        { name: "Rust 线程", color: "#eb6834", dash: "7 4", values: NS.map((n) => pick("rustp", n, fps)), labelAt: [5], dy: 16 },
      ],
    }));
    save("step.svg", chart({
      title: "图 2 · 每个模拟步的耗时（后端自己计时）",
      subtitle: ["实时要求每步不超过 33.3 ms。Rust 约快 2.3 倍", "超出预算的位置：Worker 约 3.1 万兵，Rust 约 4.7 万兵"],
      cats, yLabel: "ms / 步", refs: [{ value: 1000 / 30, label: "33.3 ms 步长预算" }],
      bars: [
        { name: "Web Worker（JS）", color: "#2a78d6", values: NS.map((n) => pick("workerp", n, step)), labels: true },
        { name: "Rust 线程", color: "#eb6834", values: NS.map((n) => pick("rustp", n, step)), labels: true },
      ],
    }));
  }
  const sims = ["worker", "rust", "workerp", "rustp"];
  if (sims.every((s) => pick(s, 30000, fps) != null)) {
    save("hz.svg", chart({
      title: "图 3 · 3 万兵：帧率一样，画面更新差 6 倍",
      subtitle: ["帧率 = 页面每秒画几帧；画面拿到快照 = 每秒拿到几份新的战场状态", "后者低于 30 时，单位在跳步移动，只看帧率看不出来"],
      cats: ["Worker", "Rust", "Worker + 流水线", "Rust + 流水线"], yLabel: "次 / 秒",
      bars: [
        { name: "平均帧率", color: "#b4b2a9", values: sims.map((s) => pick(s, 30000, fps)), labels: true },
        { name: "画面拿到快照", color: "#2a78d6", values: sims.map((s) => pick(s, 30000, hz)), labels: true },
      ],
    }));
  }
  return out;
};
