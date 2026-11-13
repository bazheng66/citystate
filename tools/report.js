// 把 bench/results/*.json 汇总成 Markdown 报告：node tools/report.js
// 同一组实验有多份结果时用最新的一份。bench/notes.md（人工写的结论）会放在数据表前面。
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "bench", "results");

const byKey = new Map();
for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith(".json")).sort()) {
  const d = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
  if (d.mode === "smoke") continue;
  for (const r of d.results) {
    if (!r.ok) continue;
    let key = r.group + "|" + r.shell + "|" + JSON.stringify(r.query);
    if (r.group === "startup") key += "|" + r.id; // 启动测试每轮都保留
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

const notes = path.join(ROOT, "bench", "notes.md");
const out = (fs.existsSync(notes) ? fs.readFileSync(notes, "utf8").trim() + "\n" : "# 对比实验报告\n") + "\n---\n\n# 数据表\n" + md + `\n\n原始数据在 \`bench/results/\`；本文件由 \`node tools/report.js\` 生成。\n`;
fs.writeFileSync(path.join(ROOT, "对比实验报告.md"), out);
console.log(md);
console.log("\n共 " + all.length + " 轮有效结果 → 对比实验报告.md");
