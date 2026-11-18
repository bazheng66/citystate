// 把 bench/results/*.json 汇总成 Markdown 报告：node tools/report.js
// 同一组实验有多份结果时用最新的一份。bench/notes.md（人工写的结论）会放在数据表前面。
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "bench", "results");

const byKey = new Map();
for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith(".json")).sort()) {
  const d = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
  if (d.mode === "smoke" || d.mode === "backsmoke") continue;
  for (const r of d.results) {
    if (!r.ok) continue;
    let key = r.group + "|" + r.shell + "|" + JSON.stringify(r.query);
    if (r.group === "startup") key += "|" + r.id; // 启动测试每轮都保留
    if (r.rep != null) key += "|rep" + r.rep; // 重复实验：每次重复都保留
    byKey.set(key, r);
  }
}
const all = Array.from(byKey.values());
const SH = ["tauri", "electron", "edge"];
const NAME = { tauri: "Tauri (WebView2)", electron: "Electron", edge: "Edge 浏览器" };
const grp = (g) => all.filter((r) => r.group === g);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const f1 = (v) => (v == null ? "–" : (+v).toFixed(1));
const f0 = (v) => (v == null ? "–" : Math.round(v));
const table = (head, rows) => "| " + head.join(" | ") + " |\n|" + head.map((_, i) => (i ? "---:" : "---")).join("|") + "|\n" + rows.map((r) => "| " + r.join(" | ") + " |").join("\n") + "\n";
let md = "";
const sec = (title, body) => { if (body) md += `\n## ${title}\n\n${body}\n`; };

// ---- 环境 ----
const any = all.find((r) => r.res);
if (any) {
  const ua = {};
  for (const s of SH) { const r = all.find((x) => x.shell === s && x.res && x.res.version); if (r) ua[s] = r.res.ua; }
  const ver = (s) => { const m = (ua[s] || "").match(/(Electron\/[\d.]+).*|Chrome\/[\d.]+/); const c = (ua[s] || "").match(/Chrome\/([\d.]+)/); const e = (ua[s] || "").match(/Electron\/([\d.]+)/); return (e ? "Electron " + e[1] + "，" : "") + (c ? "Chromium " + c[1] : m ? m[0] : "?"); };
  sec("测试环境", [
    `- 显卡：${any.res.gpu || "?"}`,
    `- 画布：${any.res.canvas}（窗口内容区 1360×900，系统缩放 ${any.res.dpr}）`,
    ...SH.filter((s) => ua[s]).map((s) => `- ${NAME[s]}：${ver(s)}`),
    "- 三个外壳加了同样的开关，窗口被遮挡或失焦时不降帧；每轮测试都是新开进程、测完杀掉",
    "- 帧率上限由显示器刷新率决定（本机 240Hz）；“JS 侧渲染耗时”只是发绘制指令的时间，GPU 光栅化的开销体现在帧率和帧时间里",
  ].join("\n"));
}

// ---- 启动与体积 ----
{
  const rows = [];
  const size = (p) => { try { const st = fs.statSync(p); if (st.isFile()) return st.size; let n = 0; for (const f of fs.readdirSync(p)) n += size(path.join(p, f)); return n; } catch (e) { return 0; } };
  const pkg = { tauri: size(path.join(ROOT, "src-tauri/target/release/citystate.exe")), electron: size(path.join(ROOT, "electron/dist/win-unpacked")), edge: 0 };
  for (const s of SH) {
    const rs = grp("startup").filter((r) => r.shell === s);
    if (!rs.length) continue;
    rows.push([NAME[s], rs.map((r) => f0(r.startMs)).join(" / "), f0(avg(rs.map((r) => r.bootMs))), f0(avg(rs.map((r) => r.atlasMs))),
      f0(avg(rs.map((r) => r.proc.avgPrivMB))), f0(avg(rs.map((r) => r.proc.avgWsMB))), f0(avg(rs.map((r) => r.proc.procs))),
      pkg[s] ? (pkg[s] / 1048576).toFixed(1) + " MB" : "（系统自带）"]);
  }
  if (rows.length) sec("启动、空闲占用与体积", table(["外壳", "进程启动→页面可交互 ms（三次）", "页面内启动 ms", "其中图集合成 ms", "空闲私有内存 MB", "空闲工作集 MB", "进程数", "程序体积"], rows) +
    "\n停在标题页约 9 秒的平均值。内存是整棵进程树之和（Tauri = 宿主 + WebView2 的全部子进程）。Tauri 依赖系统里已装的 WebView2 运行时，Electron 自带一整套 Chromium。Edge 有系统级的启动加速，启动时间仅供参考。");
}

// ---- 规模阶梯 ----
function benchRows(rs, label) {
  return rs.map((r) => [label(r), NAME[r.shell], f1(r.res.avgFps), f1(r.res.low1Fps), f1(r.res.p99FrameMs), f1(r.res.maxFrameMs), `${r.res.over33 ?? "–"} / ${r.res.over100 ?? "–"}`,
    (+r.res.avgSimMs).toFixed(2), (+r.res.avgRenderMs).toFixed(2), f0(r.proc.cpuPct), f0(r.proc.peakPrivMB), f1(r.res.heapEndMB)]);
}
const HEAD = ["场景", "外壳", "平均 FPS", "1% Low", "P99 帧 ms", "最长帧 ms", "卡顿帧 >33 / >100ms", "模拟 ms/帧", "渲染 ms/帧(JS)", "CPU %", "峰值私有内存 MB", "JS 堆 MB"];
{
  const rs = grp("scale").sort((a, b) => a.query.bench - b.query.bench || SH.indexOf(a.shell) - SH.indexOf(b.shell));
  if (rs.length) {
    let body = table(HEAD, benchRows(rs, (r) => `${r.query.bench} 兵`));
    body += "\n大地图 144×90 格（2880×1800 世界像素，51 座据点，6 方混战），30 秒相机脚本：近景巡游 → 拉远 → 全图俯瞰 → 中景。CPU % 是整棵进程树的 CPU 时间 ÷ 墙钟时间（100% = 占满一个逻辑核）。\n\n分阶段帧率（平均 FPS / 1% Low）：\n\n";
    body += table(["场景", "外壳", "近景巡游", "拉远过程", "全图俯瞰", "中景"], rs.map((r) => {
      const p = r.res.phases || {};
      const c = (k) => (p[k] ? `${f1(p[k].avgFps)} / ${f1(p[k].low1Fps)}` : "–");
      return [`${r.query.bench} 兵`, NAME[r.shell], c("close"), c("zoomout"), c("overview"), c("mid")];
    }));
    sec("一、规模阶梯：三个外壳在同一负载下的表现", body);
  }
}

// ---- 重复实验与极限档位 ----
const sd = (a) => { if (a.length < 2) return 0; const m = avg(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const pm = (a, d = 1) => (!a.length ? "–" : a.length > 1 ? `${avg(a).toFixed(d)} ± ${sd(a).toFixed(d)}` : avg(a).toFixed(d));
function aggRows(rs) {
  const rows = [];
  const ns = Array.from(new Set(rs.map((r) => r.query.bench))).sort((a, b) => a - b);
  for (const n of ns) for (const s of SH) {
    const g = rs.filter((r) => r.query.bench === n && r.shell === s);
    if (!g.length) continue;
    const col = (fn) => g.map(fn).filter((v) => v != null && !Number.isNaN(v));
    rows.push([`${n} 兵`, NAME[s], g.length, pm(col((r) => r.res.avgFps)), pm(col((r) => r.res.low1Fps)), pm(col((r) => r.res.p99FrameMs)), pm(col((r) => r.res.over33), 0),
      pm(col((r) => r.res.avgSimMs), 2), pm(col((r) => r.res.avgRenderMs), 2), pm(col((r) => (r.res.simSpeed != null ? r.res.simSpeed * 100 : null)), 0), pm(col((r) => ((r.res.avgSimMs + r.res.avgRenderMs) / (1000 / r.res.avgFps)) * 100), 0), f0(avg(col((r) => r.res.avgSoldiers))), f0(avg(col((r) => r.proc.cpuPct)))]);
  }
  return rows;
}
const AHEAD = ["场景", "外壳", "轮数", "平均 FPS", "1% Low", "P99 帧 ms", "卡顿帧 >33ms", "模拟 ms/帧", "渲染 ms/帧(JS)", "模拟速度 % 实时", "主线程 JS 占帧时间 %", "实际士兵数", "CPU %"];
{
  const rs = grp("rep");
  if (rs.length) {
    let body = table(AHEAD, aggRows(rs)) + "\n和上一节相同的场景，每个配置独立跑三次（每次都是新开进程），“±”后面是样本标准差。\n\nElectron 相对 Tauri 的平均 FPS 差距：";
    const ns = Array.from(new Set(rs.map((r) => r.query.bench))).sort((a, b) => a - b);
    body += ns.map((n) => { const t = avg(rs.filter((r) => r.shell === "tauri" && r.query.bench === n).map((r) => r.res.avgFps)); const e = avg(rs.filter((r) => r.shell === "electron" && r.query.bench === n).map((r) => r.res.avgFps)); const g = avg(rs.filter((r) => r.shell === "edge" && r.query.bench === n).map((r) => r.res.avgFps)); return `${n} 兵 ${((e / t - 1) * 100).toFixed(1)}%（Edge ${((g / t - 1) * 100).toFixed(1)}%）`; }).join("，") + "。\n\n分阶段平均 FPS（三次的均值 ± 标准差）：\n\n";
    const prow = [];
    for (const n of ns) for (const s of SH) {
      const g = rs.filter((r) => r.query.bench === n && r.shell === s);
      if (!g.length) continue;
      const c = (k) => pm(g.map((r) => r.res.phases[k] && r.res.phases[k].avgFps).filter((v) => v != null));
      prow.push([`${n} 兵`, NAME[s], c("close"), c("zoomout"), c("overview"), c("mid")]);
    }
    body += table(["场景", "外壳", "近景巡游", "拉远过程", "全图俯瞰", "中景"], prow);
    sec("一（续）、规模阶梯重复三次：均值与波动", body);
  }
}
{
  const rs = grp("limit");
  if (rs.length) {
    let body = table(AHEAD, aggRows(rs)) + "\n同一张大地图继续加兵。“模拟速度”= 实际跑的模拟步数 ÷ 实时应跑的步数（30 步/秒）；低于 100% 说明主线程已经来不及，游戏本身在变慢，此时 FPS 再高也没有意义。“主线程 JS 占帧时间”=（模拟 + 发绘制指令）÷ 帧时间，越接近 100% 说明帧率越是被页面自己的 JS 卡住，而不是 GPU 或外壳。各配置的轮数见表。\n";
    // 用 Tauri 的各档均值估算几条线落在哪（相邻两档之间线性插值）
    const pts = [];
    const src = grp("scale").filter((r) => r.shell === "tauri" && r.query.bench === 1000).concat(grp("rep").filter((r) => r.shell === "tauri"), rs.filter((r) => r.shell === "tauri"));
    for (const n of Array.from(new Set(src.map((r) => r.query.bench))).sort((a, b) => a - b)) {
      const g = src.filter((r) => r.query.bench === n);
      pts.push({ n: avg(g.map((r) => r.res.avgSoldiers)), fps: avg(g.map((r) => r.res.avgFps)), low: avg(g.map((r) => r.res.low1Fps)), sim: avg(g.map((r) => (r.res.simSpeed != null ? r.res.simSpeed : 1))) });
    }
    const cross = (key, level) => {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        if (a[key] >= level && b[key] < level) return Math.round((a.n + ((a[key] - level) / (a[key] - b[key])) * (b.n - a.n)) / 100) * 100;
      }
      return null;
    };
    const say = (v) => (v == null ? "测试范围内没有跌破" : "约 " + v + " 兵");
    body += "\nTauri 的边界（由各档均值线性插值估算，实际士兵数为横轴）：\n\n" + [
      `- 平均帧率跌破 120 FPS：${say(cross("fps", 120))}`,
      `- 平均帧率跌破 60 FPS：${say(cross("fps", 60))}`,
      `- 最差 1% 的帧跌破 30 FPS：${say(cross("low", 30))}`,
      `- 平均帧率跌破 30 FPS：${say(cross("fps", 30))}`,
      `- 模拟跟不上实时（速度低于 95%）：${say(cross("sim", 0.95))}`,
    ].join("\n") + "\n";
    // Tauri 各档的主线程时间去向
    const trow = [];
    for (const n of Array.from(new Set(src.map((r) => r.query.bench))).sort((a, b) => a - b)) {
      const g = src.filter((r) => r.query.bench === n);
      const m = (fn) => avg(g.map(fn));
      const fps = m((r) => r.res.avgFps);
      const simMs = m((r) => r.res.avgSimMs);
      const renMs = m((r) => r.res.avgRenderMs);
      const step = m((r) => (r.res.avgSimMs * r.res.avgFps) / (30 * (r.res.simSpeed != null ? r.res.simSpeed : 1)));
      trow.push([f0(m((r) => r.res.avgSoldiers)), g.length, fps.toFixed(1), (1000 / fps).toFixed(1), simMs.toFixed(2), renMs.toFixed(2), f0(((simMs + renMs) / (1000 / fps)) * 100), step.toFixed(2), f0((step / (1000 / 30)) * 100)]);
    }
    body += "\nTauri 各档的主线程时间去向（1000 兵取自第一节，3000–10000 兵取自重复实验）：\n\n" + table(["实际士兵数", "轮数", "平均 FPS", "帧时间 ms", "模拟 ms/帧", "绘制 ms/帧(JS)", "JS 占帧时间 %", "每个模拟步 ms", "占 33.3ms 步长预算 %"], trow);
    sec("一（再续）、极限档位：加到跑不动为止", body);
  }
}

// ---- 巨型地图 ----
{
  const rs = grp("xl").sort((a, b) => SH.indexOf(a.shell) - SH.indexOf(b.shell));
  if (rs.length) sec("二、巨型地图（200×125 格，8 方，10000 兵）", table(HEAD, benchRows(rs, (r) => `${r.res.map} · ${r.res.structs} 据点`)) +
    "\n" + table(["外壳", "近景巡游", "拉远过程", "全图俯瞰", "中景", "烘焙地形块", "地形缓存 MP"], rs.map((r) => {
      const p = r.res.phases || {};
      const c = (k) => (p[k] ? `${f1(p[k].avgFps)} / ${f1(p[k].low1Fps)}` : "–");
      return [NAME[r.shell], c("close"), c("zoomout"), c("overview"), c("mid"), r.res.chunksBaked, r.res.chunkCacheMP];
    })));
}

// ---- 改造前后 ----
{
  const old = grp("base-old");
  const neu = grp("base-new");
  const lod = grp("base-new-lod");
  if (old.length || neu.length) {
    const rows = [];
    for (const s of SH) {
      for (const [label, list] of [["改造前（单屏 40×25）", old], ["改造后（64×40，全图视角）", neu]]) {
        const r = list.find((x) => x.shell === s);
        if (!r) continue;
        rows.push([label, NAME[s], f1(r.res.avgFps), f1(r.res.low1Fps), f1(r.res.p99FrameMs), (+r.res.avgSimMs).toFixed(2), (+r.res.avgRenderMs).toFixed(2), f0(r.res.avgSoldiers || r.res.peakSoldiers), f0(r.proc.cpuPct), f0(r.proc.peakPrivMB)]);
      }
    }
    sec("三、改造前后对比（约 2000 兵全部在一屏内）", table(["版本", "外壳", "平均 FPS", "1% Low", "P99 帧 ms", "模拟 ms/帧", "渲染 ms/帧(JS)", "士兵数", "CPU %", "峰值私有内存 MB"], rows) +
      "\n改造前 = backup_v3 里的版本（每个精灵一张小画布、每个士兵用路径画影子和脚环、没有光照 / 粒子 / 迷雾）。改造后在 64×40 的小地图上把镜头拉到全图：这个缩放下 LOD 不会触发，2000 个兵全部按完整精灵画（带影子、脚环、旗标），另外还多了昼夜光照、粒子、云影和水面。改造前的页面由本地 HTTP 服务提供，三个外壳都从同一个地址加载。");
  }
}

// ---- 消融 ----
{
  const rs = all.filter((r) => r.group.startsWith("ablate-"));
  if (rs.length) {
    const label = { full: "全部开启", nolight: "关 昼夜光照", nofx: "关 粒子 / 天气 / 云影 / 水面", noshadow: "关 影子脚环", notags: "关 旗标血条", nolod: "关 LOD（远景也画精灵）" };
    const order = Object.keys(label);
    rs.sort((a, b) => order.indexOf(a.group.slice(7)) - order.indexOf(b.group.slice(7)));
    sec("四、画面特性消融（Tauri，大地图 6000 兵）", table(["配置", "平均 FPS", "1% Low", "P99 帧 ms", "渲染 ms/帧(JS)", "近景 FPS", "俯瞰 FPS", "中景 FPS", "CPU %"], rs.map((r) => {
      const p = r.res.phases || {};
      return [label[r.group.slice(7)] || r.group, f1(r.res.avgFps), f1(r.res.low1Fps), f1(r.res.p99FrameMs), (+r.res.avgRenderMs).toFixed(2), f1(p.close && p.close.avgFps), f1(p.overview && p.overview.avgFps), f1(p.mid && p.mid.avgFps), f0(r.proc.cpuPct)];
    })));
  }
}

// ---- 浸泡 ----
{
  const rs = grp("soak").sort((a, b) => SH.indexOf(a.shell) - SH.indexOf(b.shell));
  if (rs.length) {
    const rows = rs.map((r) => {
      const tl = r.res.timeline || [];
      const head = tl.slice(0, 12);
      const tail = tl.slice(-12);
      const mem = r.memTimeline || [];
      const m0 = mem.slice(Math.floor(mem.length * 0.15), Math.floor(mem.length * 0.3));
      const m1 = mem.slice(-Math.max(1, Math.floor(mem.length * 0.15)));
      return [NAME[r.shell], r.res.secs + " s", f1(r.res.avgFps), f1(avg(head.map((x) => x.fps))), f1(avg(tail.map((x) => x.fps))), f1(r.res.low1Fps), f1(r.res.maxFrameMs), `${r.res.over33} / ${r.res.over100}`,
        `${f1(r.res.heapStartMB)} → ${f1(r.res.heapEndMB)}`, `${f0(avg(m0.map((x) => x.privMB)))} → ${f0(avg(m1.map((x) => x.privMB)))}`, r.res.errorCount];
    });
    let body = table(["外壳", "时长", "平均 FPS", "第 1 分钟 FPS", "最后 1 分钟 FPS", "1% Low", "最长帧 ms", "卡顿帧 >33 / >100ms", "JS 堆 起→止 MB", "进程私有内存 前段→末段 MB", "脚本错误"], rows);
    body += "\n大地图 4000 兵持续混战，相机在整段时间里慢速走完同一套脚本（近景 → 拉远 → 俯瞰 → 中景），所以帧率会随阶段变化；看稳定性主要看卡顿帧、内存走势和错误数。\n\n每分钟平均 FPS：\n\n";
    const mins = Math.max(...rs.map((r) => Math.floor((r.res.timeline || []).length / 12)));
    body += table(["外壳"].concat(Array.from({ length: mins }, (_, i) => `第 ${i + 1} 分`)), rs.map((r) => [NAME[r.shell]].concat(Array.from({ length: mins }, (_, i) => f0(avg((r.res.timeline || []).slice(i * 12, i * 12 + 12).map((x) => x.fps)))))));
    body += "\n进程树私有内存（MB），每约 10 秒一个点里抽样：\n\n";
    body += table(["外壳", "10%", "25%", "50%", "75%", "100%"], rs.map((r) => { const m = r.memTimeline || []; const at = (k) => (m.length ? f0(m[Math.min(m.length - 1, Math.floor(m.length * k))].privMB) : "–"); return [NAME[r.shell], at(0.1), at(0.25), at(0.5), at(0.75), at(0.999)]; }));
    sec("五、稳定性浸泡", body);
  }
}

// ---- 近景浸泡（地形缓存顶着预算淘汰） ----
{
  const rs = grp("soak-close").sort((a, b) => SH.indexOf(a.shell) - SH.indexOf(b.shell));
  if (rs.length) {
    const rows = rs.map((r) => {
      const m = r.memTimeline || [];
      const at = (k) => (m.length ? f0(m[Math.min(m.length - 1, Math.floor(m.length * k))].privMB) : "–");
      return [NAME[r.shell], r.res.secs + " s", f1(r.res.avgFps), f1(r.res.low1Fps), f1(r.res.maxFrameMs), `${r.res.over33} / ${r.res.over100}`, r.res.chunksBaked, r.res.chunkCacheMP, at(0.2), at(0.4), at(0.6), at(0.8), at(0.999), r.res.errorCount];
    });
    sec("六、近景浸泡：内存是否封顶", table(["外壳", "时长", "平均 FPS", "1% Low", "最长帧 ms", "卡顿帧 >33 / >100ms", "烘焙地形块", "缓存 MP", "私有内存 20%", "40%", "60%", "80%", "结束", "脚本错误"], rows) +
      "\n相机全程贴近地面绕 8 字，不停地烘焙新的 1024×1024 地形块；缓存上限 44MP，超出才按最久未用淘汰 —— 这一轮只涨到表里的数值，没有触发淘汰。私有内存是整棵进程树之和（MB），按测试时间的百分位取样。");
  }
}

// ---- 遮挡 ----
{
  const rs = grp("occlude").sort((a, b) => SH.indexOf(a.shell) - SH.indexOf(b.shell));
  if (rs.length) sec("七、窗口被遮挡时", table(["外壳", "遮挡前（每 5 秒平均 FPS）", "遮挡后"], rs.map((r) => { const tl = (r.res.timeline || []).map((x) => f0(x.fps)); return [NAME[r.shell], tl.slice(0, 3).join(" / "), tl.slice(3).join(" / ")]; })) +
    "\n大地图 3000 兵近景，测量开始约 15 秒后弹出一个最大化、置顶的空窗口把测试窗口完全盖住。三个外壳都加了“被遮挡不降帧”的开关。");
}

// ---- 模拟后端对比 ----
const BK = ["main", "worker", "rust", "workerp", "rustp"];
const BKNAME = { main: "主线程 JS", worker: "Web Worker（JS）", rust: "Rust 线程（Tauri IPC）", workerp: "Web Worker + 流水线", rustp: "Rust 线程 + 流水线" };
function backRows(rs) {
  const rows = [];
  const ns = Array.from(new Set(rs.map((r) => r.query.bench))).sort((a, b) => a - b);
  for (const n of ns) for (const s of SH) for (const b of BK) {
    const g = rs.filter((r) => r.query.bench === n && r.shell === s && (r.query.sim || "main") === b);
    if (!g.length) continue;
    const col = (fn) => g.map(fn).filter((v) => v != null && !Number.isNaN(v));
    const rm = (k) => col((r) => r.res.remote && r.res.remote[k]);
    rows.push([`${n} 兵`, NAME[s], BKNAME[b], g.length, pm(col((r) => r.res.avgFps)), pm(col((r) => r.res.low1Fps)), pm(col((r) => r.res.p99FrameMs)),
      pm(col((r) => r.res.avgSimMs), 2), pm(col((r) => r.res.avgRenderMs), 2),
      b === "main" ? pm(col((r) => (r.res.avgSimMs * r.res.avgFps) / (30 * (r.res.simSpeed || 1))), 2) : pm(rm("backendStepMs"), 2),
      b === "main" ? "–" : pm(rm("avgBytes").map((v) => v / 1024), 0), b === "main" ? "–" : pm(rm("transitMs"), 1), b === "main" ? "–" : pm(rm("snapHz"), 1),
      pm(col((r) => (r.res.simSpeed != null ? r.res.simSpeed * 100 : null)), 0), f0(avg(col((r) => r.res.avgSoldiers))), f0(avg(col((r) => r.proc.cpuPct)))]);
  }
  return rows;
}
const BHEAD = ["场景", "外壳", "模拟跑在", "轮数", "平均 FPS", "1% Low", "P99 帧 ms", "主线程模拟/还原 ms/帧", "渲染 ms/帧(JS)", "每个模拟步 ms", "快照 KB", "快照传输 ms", "画面拿到快照 次/秒", "模拟速度 % 实时", "实际士兵数", "CPU %"];
{
  const rs = all.filter((r) => r.group.startsWith("backend-"));
  if (rs.length) {
    let body = table(BHEAD, backRows(rs));
    body += "\n“主线程模拟/还原”：主线程 JS 时是模拟本身的耗时；Worker / Rust 时模拟不在主线程上，这一列是把快照还原进镜像世界的耗时。“每个模拟步”：主线程 JS 按每帧模拟耗时折算；Worker / Rust 是后端自己报的。“快照传输”= 请求往返时间 − 后端等下一步算完的时间，含主线程忙于渲染、来不及处理回复的排队时间。“画面拿到快照 次/秒”低于 30 说明传输跟不上模拟，画面在跳步（模拟本身仍按实时跑）。\n\n相对主线程 JS 的平均 FPS 提升（同一外壳内比较）：\n\n";
    const ns = Array.from(new Set(rs.map((r) => r.query.bench))).sort((a, b) => a - b);
    const srow = [];
    for (const n of ns) for (const s of SH) {
      const fps = (b) => { const g = rs.filter((r) => r.query.bench === n && r.shell === s && (r.query.sim || "main") === b); return g.length ? avg(g.map((r) => r.res.avgFps)) : null; };
      const m = fps("main");
      if (m == null) continue;
      const pc = (v) => (v == null ? "–" : `${v >= m ? "+" : ""}${((v / m - 1) * 100).toFixed(0)}%`);
      srow.push([`${n} 兵`, NAME[s], m.toFixed(1), pc(fps("worker")), pc(fps("rust")), pc(fps("workerp")), pc(fps("rustp"))]);
    }
    body += table(["场景", "外壳", "主线程 JS 的 FPS", "Worker", "Rust", "Worker + 流水线", "Rust + 流水线"], srow);
    sec("八、模拟后端对比：把模拟搬离主线程", body);
  }
}
{
  const rs = all.filter((r) => r.group.startsWith("backlimit-") || (r.group.startsWith("backend-") && r.shell === "tauri"));
  if (rs.some((r) => r.group.startsWith("backlimit-"))) {
    let body = table(BHEAD, backRows(rs.filter((r) => r.query.sim !== "main" || r.query.bench >= 20000)));
    const pts = (b) => {
      const src = rs.filter((r) => (r.query.sim || "main") === b);
      return Array.from(new Set(src.map((r) => r.query.bench))).sort((x, y) => x - y).map((n) => {
        const g = src.filter((r) => r.query.bench === n);
        return { n: avg(g.map((r) => r.res.avgSoldiers)), fps: avg(g.map((r) => r.res.avgFps)), low: avg(g.map((r) => r.res.low1Fps)), sim: avg(g.map((r) => (r.res.simSpeed != null ? r.res.simSpeed : 1))), hz: b === "main" ? 30 : avg(g.map((r) => (r.res.remote && r.res.remote.snapHz) || 0)),
          // 每步耗时取负值，这样“超过预算”和其他几条线一样是“跌破”
          step: -avg(g.map((r) => (b === "main" ? (r.res.avgSimMs * r.res.avgFps) / (30 * (r.res.simSpeed || 1)) : r.res.remote ? r.res.remote.backendStepMs : 0))) };
      });
    };
    const cross = (p, key, level) => {
      if (!p.length) return "未测";
      const top = (p[p.length - 1].n / 10000).toFixed(1);
      for (let i = 1; i < p.length; i++) { const a = p[i - 1]; const b = p[i]; if (a[key] >= level && b[key] < level) return Math.round((a.n + ((a[key] - level) / (a[key] - b[key])) * (b.n - a.n)) / 100) * 100; }
      return p[0][key] < level ? "<" + Math.round(p[0].n / 100) * 100 : "≤" + top;
    };
    const say = (v) => (v === "未测" ? "未测" : typeof v === "string" && v[0] === "≤" ? `测到 ${v.slice(1)} 万兵为止没有` : typeof v === "string" ? "最低一档已经低于此线（" + v.slice(1) + " 兵）" : "约 " + v + " 兵");
    body += "\n各后端的边界（Tauri，相邻档位线性插值，横轴为实际士兵数）：\n\n" + table(["界线", ...BK.map((b) => BKNAME[b])], [
      ["平均帧率跌破 60 FPS", ...BK.map((b) => say(cross(pts(b), "fps", 60)))],
      ["平均帧率跌破 30 FPS", ...BK.map((b) => say(cross(pts(b), "fps", 30)))],
      ["最差 1% 帧跌破 30 FPS", ...BK.map((b) => say(cross(pts(b), "low", 30)))],
      ["每个模拟步超过 33.3 ms 的步长预算", ...BK.map((b) => say(cross(pts(b), "step", -1000 / 30)))],
      ["模拟跟不上实时（低于 95%）", ...BK.map((b) => say(cross(pts(b), "sim", 0.95)))],
      ["画面拿到快照低于 27 次/秒", "（不适用）", ...BK.slice(1).map((b) => say(cross(pts(b), "hz", 27)))],
    ]);
    body += "\n主线程 JS 一列只有 1 万 / 2 万 / 3 万三档，不加流水线的 Worker / Rust 只测到 3 万兵，插值较粗。“模拟速度”取的是页面镜像世界的步数，模拟后端掉速时它也跟着掉。\n";
    sec("九、离开主线程之后的新边界", body);
  }
}

// ---- IPC 基准 ----
{
  const rs = grp("ipc").filter((r) => r.res && r.res.rows);
  if (rs.length) {
    const KN = { "tauri-blob": "Tauri invoke，Rust→页面，二进制", "tauri-json": "Tauri invoke，Rust→页面，JSON", "tauri-sink": "Tauri invoke，页面→Rust，二进制", "worker-xfer": "Worker postMessage，转移", "worker-clone": "Worker postMessage，克隆", "fill-only": "（对照）页面只填数据不发送" };
    const sizes = Array.from(new Set(rs.flatMap((r) => r.res.rows.map((x) => x.size)))).sort((a, b) => a - b);
    const fmt = (b) => (b >= 1 << 20 ? b / 1048576 + " MB" : b / 1024 + " KB");
    const rows = [];
    for (const s of SH) for (const k of Object.keys(KN)) {
      const g = rs.filter((r) => r.shell === s);
      if (!g.some((r) => r.res.rows.some((x) => x.kind === k))) continue;
      rows.push([NAME[s], KN[k], g.length, ...sizes.map((z) => { const v = g.map((r) => r.res.rows.find((x) => x.kind === k && x.size === z)).filter((x) => x && x.p50Ms != null).map((x) => x.p50Ms); return v.length ? (v.length > 1 ? pm(v, 2) : v[0].toFixed(2)) : "–"; })]);
    }
    let body = table(["外壳", "方式", "轮数", ...sizes.map(fmt)], rows);
    body += "\n每格是一次往返的中位数耗时（ms），多轮时给均值 ± 标准差。往返 = 主线程发请求 → 对方造出指定大小的数据 → 数据回到主线程（页面→Rust 那一行反过来：页面造数据发给 Rust，Rust 回一个数）。小块每档测 60 次，16 MB 测 10 次，各先热身 3 次。JSON 只测到 4 MB。页面计时器精度是 0.1 ms，Worker 的小块往返已经低于这个精度。测试时页面空闲，没有在跑游戏。\n\nTauri 里按中位数折算的吞吐（MB/s，取最大一档）：";
    const thr = (s, k) => { const g = rs.filter((r) => r.shell === s).map((r) => r.res.rows.filter((x) => x.kind === k && x.mbps).sort((a, b) => b.size - a.size)[0]).filter(Boolean); return g.length ? f0(avg(g.map((x) => x.mbps))) : null; };
    body += ["tauri-blob", "tauri-json", "tauri-sink", "worker-xfer", "worker-clone"].map((k) => { const v = thr("tauri", k); return v ? `${KN[k]} ${v}` : ""; }).filter(Boolean).join("；") + "。\n";
    sec("十、IPC 基准：一段数据过一次边界要多久（空载）", body);
  }
}

// 图：从数据现画，放在 bench/figs/，notes.md 里按相对报告的路径引用
const figs = require("./figs.js")(all, path.join(ROOT, "bench", "figs"));
console.log("图：" + Object.keys(figs).join(" ") + " → bench/figs/");

const notes = path.join(ROOT, "bench", "notes.md");
const out = (fs.existsSync(notes) ? fs.readFileSync(notes, "utf8").trim() + "\n" : "# 对比实验报告\n") + "\n---\n\n# 数据表\n" + md + `\n\n原始数据在 \`bench/results/\`；本文件由 \`node tools/report.js\` 生成。\n`;
fs.writeFileSync(path.join(ROOT, "对比实验报告.md"), out);
console.log(md);
console.log("\n共 " + all.length + " 轮有效结果 → 对比实验报告.md");
