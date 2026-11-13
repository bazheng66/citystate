// 跨外壳对比实验：同一份页面分别在 Tauri（WebView2）、Electron、Edge 里跑压力测试，
// 页面把结果 POST 回本脚本起的本地服务；同时每 2 秒采样一次整棵进程树的内存和 CPU。
//
//   node tools/experiment.js smoke            每个外壳跑一个 10 秒的小测试，确认流程通
//   node tools/experiment.js scale            士兵数阶梯（1000 / 3000 / 6000 / 10000，大地图）
//   node tools/experiment.js base             改造前（backup_v3）对比改造后，同屏 2000 兵（baseold = 只跑改造前）
//   node tools/experiment.js xl               巨型地图 10000 兵
//   node tools/experiment.js ablate           Tauri 下逐项关掉画面特性
//   node tools/experiment.js soak [秒]         长时间浸泡（默认 480 秒）
//   node tools/experiment.js soakclose [秒]    只近景巡游的浸泡：地形缓存一直顶着预算淘汰，看内存会不会一直涨
//   node tools/experiment.js occlude          测到一半用一个最大化的置顶窗口盖住，看被遮挡时还出不出帧
//   node tools/experiment.js startup          冷启动到可交互的时间、空闲内存
//   node tools/experiment.js all              以上全部
//   可加 --only=tauri,electron,edge 只跑部分外壳
// 结果写到 bench/results/*.json，再用 node tools/report.js 生成报告。
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PORT = 8791;
const OUT = path.join(ROOT, "bench", "results");
const TMP = path.join(ROOT, "bench", "tmp");
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const EXE = {
  tauri: path.join(ROOT, "src-tauri", "target", "release", "citystate.exe"),
  electron: path.join(ROOT, "electron", "dist", "win-unpacked", "城邦演武.exe"),
  edge: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
};
// 三个外壳都加上同样的开关：窗口被挡住或失去焦点时不要降帧
const FLAGS = ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"];

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith("--")) || "smoke";
const only = (args.find((a) => a.startsWith("--only=")) || "--only=tauri,electron,edge").slice(7).split(",");
const soakSecs = Number(args.filter((a) => !a.startsWith("--"))[1]) || 480;

// ---------- 本地服务：静态文件 + 结果上报 ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".txt": "text/plain" };
// 改造前的页面不会上报，由服务端在 index.html 末尾注入一小段上报脚本
const INJECT = `<script>(function(){var q=new URLSearchParams(location.search);function post(o){o.run=q.get('run');o.shell=q.get('shell');fetch('/report',{method:'POST',body:JSON.stringify(o)}).catch(function(){});}
var w=(q.get('win')||'').split('x').map(Number);if(w[0]&&w[1]){try{resizeTo(w[0]+(outerWidth-innerWidth),w[1]+(outerHeight-innerHeight));}catch(e){}}
var r=setInterval(function(){if(document.body&&document.body.dataset.ready){clearInterval(r);post({event:'ready',bootMs:performance.now()});}},50);
var n=0;(function tick(){n++;requestAnimationFrame(tick);})();setInterval(function(){var c=document.querySelector('#view');post({event:'diag',vis:document.visibilityState,focus:document.hasFocus(),raf:n,iw:innerWidth,ih:innerHeight,cw:c&&c.width,ch:c&&c.height,perf:(document.querySelector('#perf')||{}).textContent});n=0;},3000);
var t=setInterval(function(){var b=document.body&&document.body.dataset.bench;if(b){clearInterval(t);post({event:'bench',res:JSON.parse(b)});}},500);})();</script>`;
const waiters = new Map(); // run id → { ready, bench }
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, "http://x");
  if (req.method === "POST" && url.pathname === "/report") {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      try {
        const msg = JSON.parse(body);
        if (msg.event === "diag") { if (mode === "diag") console.log("  diag " + msg.run + " " + JSON.stringify(msg).slice(0, 420)); res.writeHead(200); res.end("ok"); return; }
        const w = waiters.get(msg.run);
        if (w) { msg.at = Date.now(); if (msg.event === "ready" && !w.ready) w.ready = msg; if (msg.event === "bench") { w.bench = msg; if (w.resolve) w.resolve(); } }
      } catch (e) { /* 忽略坏包 */ }
      res.writeHead(200); res.end("ok");
    });
    return;
  }
  const m = url.pathname.match(/^\/(v3|base)\/(.*)$/);
  if (!m) { res.writeHead(404); res.end(); return; }
  const dir = m[1] === "v3" ? path.join(ROOT, "game") : path.join(ROOT, "backup_v3", "game");
  const file = path.normalize(path.join(dir, decodeURIComponent(m[2] || "index.html")));
  if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  let data = fs.readFileSync(file);
  if (m[1] === "base" && file.endsWith("index.html")) data = Buffer.from(data.toString("utf8").replace("</body>", INJECT + "</body>"));
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  res.end(data);
});

// ---------- 进程树采样 ----------
function startSampler() {
  const ps1 = path.join(TMP, "sampler.ps1");
  fs.writeFileSync(ps1, `while ($true) {
  $rows = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime,Name | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.WorkingSetSize),$($_.PrivatePageCount),$([uint64]$_.KernelModeTime + [uint64]$_.UserModeTime),$($_.Name)" }
  [Console]::Out.WriteLine("S|" + ($rows -join ";"))
  Start-Sleep -Milliseconds 1800
}`);
  const ps = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], { stdio: ["ignore", "pipe", "ignore"] });
  const state = { root: 0, samples: [], buf: "" };
  ps.stdout.on("data", (d) => {
    state.buf += d.toString();
    let i;
    while ((i = state.buf.indexOf("\n")) >= 0) {
      const line = state.buf.slice(0, i).trim();
      state.buf = state.buf.slice(i + 1);
      if (!line.startsWith("S|") || !state.root) continue;
      const procs = line.slice(2).split(";").map((r) => r.split(","));
      const kids = new Map();
      for (const p of procs) { if (!kids.has(p[1])) kids.set(p[1], []); kids.get(p[1]).push(p); }
      const self = procs.find((p) => p[0] === String(state.root));
      if (!self) continue;
      let ws = 0; let priv = 0; let cpu = 0; let n = 0;
      const stack = [self];
      const seen = new Set();
      while (stack.length) {
        const p = stack.pop();
        if (seen.has(p[0])) continue;
        seen.add(p[0]);
        ws += Number(p[2]); priv += Number(p[3]); cpu += Number(p[4]); n++;
        for (const k of kids.get(p[0]) || []) stack.push(k);
      }
      state.samples.push({ at: Date.now(), wsMB: +(ws / 1048576).toFixed(1), privMB: +(priv / 1048576).toFixed(1), cpuS: +(cpu / 1e7).toFixed(2), procs: n });
    }
  });
  state.stop = () => { try { ps.kill(); } catch (e) { /* 已退出 */ } };
  return state;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function killTree(pid) {
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch (e) { /* 已退出 */ }
}

// ---------- 启动一个外壳并等结果 ----------
// run: { id, shell, page: "v3" | "base", query: {…}, timeout, idle }
async function runOne(run, sampler) {
  const q = Object.assign({}, run.query, { run: run.id, shell: run.shell, win: "1360x900", report: `http://127.0.0.1:${PORT}/report` });
  const qs = Object.entries(q).map(([k, v]) => `${k}=${v}`).join("&");
  const env = Object.assign({}, process.env);
  let exe = EXE[run.shell];
  let argv = [];
  if (run.shell === "tauri") {
    env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = FLAGS.join(" ");
    if (run.page === "base") env.CS_URL = `http://127.0.0.1:${PORT}/base/index.html?${qs}`;
    else env.CS_QUERY = qs; // 改造后的页面走内嵌资源
  } else if (run.shell === "electron") {
    env.CS_FLAGS = FLAGS.join(",");
    if (run.page === "base") env.CS_URL = `http://127.0.0.1:${PORT}/base/index.html?${qs}`;
    else { env.CS_GAME = path.join(ROOT, "game"); env.CS_QUERY = qs; }
  } else {
    const prof = path.join(TMP, "edge-" + run.id);
    argv = [`--app=http://127.0.0.1:${PORT}/${run.page}/index.html?${qs}`, `--user-data-dir=${prof}`, "--window-size=1376,940", "--window-position=120,40",
      "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync"].concat(FLAGS);
  }
  const w = { ready: null, bench: null, resolve: null };
  waiters.set(run.id, w);
  sampler.root = 0;
  sampler.samples = [];
  const t0 = Date.now();
  const child = spawn(exe, argv, { env, stdio: "ignore", detached: false });
  let rootPid = child.pid;
  sampler.root = rootPid;
  let exited = false;
  // Edge 的启动进程会把活交给另一个浏览器进程然后自己退出：按用户数据目录找到真正的那个
  if (run.shell === "edge") {
    await sleep(1500);
    try {
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*edge-${run.id}*' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -ExpandProperty ProcessId`]).toString().trim().split(/s+/).filter(Boolean);
      if (out.length) { rootPid = Number(out[0]); sampler.root = rootPid; }
    } catch (e) { /* 找不到就用启动进程 */ }
  } else child.on("exit", () => { exited = true; if (w.resolve) w.resolve(); });
  const done = new Promise((r) => { w.resolve = r; });
  // 遮挡测试：到点弹出一个最大化、置顶的空窗口盖住测试窗口，测完按 PID 关掉
  let cover = null;
  let coverTimer = null;
  if (run.occludeAt) {
    coverTimer = setTimeout(() => {
      cover = spawn("powershell.exe", ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form; $f.Text = 'occlusion test'; $f.WindowState = 'Maximized'; $f.TopMost = $true; $f.Add_Shown({ $f.Activate() }); [Windows.Forms.Application]::Run($f)"], { stdio: "ignore" });
    }, run.occludeAt);
  }
  if (run.idle) await sleep(run.idle); // 只测启动：等到空闲后直接收工
  else await Promise.race([done, sleep(run.timeout || 240000)]);
  const samples = sampler.samples.slice();
  clearTimeout(coverTimer);
  if (cover) killTree(cover.pid);
  killTree(rootPid);
  if (rootPid !== child.pid) killTree(child.pid);
  await sleep(2500);
  waiters.delete(run.id);
  // 进程级指标只取测量阶段（收到 ready 之后）的样本
  const tail = samples.filter((s) => !w.ready || s.at >= w.ready.at);
  const peak = (k) => tail.reduce((m, s) => Math.max(m, s[k]), 0);
  const avgOf = (k) => (tail.length ? +(tail.reduce((a, s) => a + s[k], 0) / tail.length).toFixed(1) : 0);
  let cpuPct = null;
  if (tail.length >= 2) cpuPct = +(((tail[tail.length - 1].cpuS - tail[0].cpuS) / ((tail[tail.length - 1].at - tail[0].at) / 1000)) * 100).toFixed(0);
  const out = {
    id: run.id, group: run.group, shell: run.shell, page: run.page, query: run.query, ok: !!w.bench || !!run.idle, exitedEarly: exited && !w.bench && !run.idle,
    startMs: w.ready ? w.ready.at - t0 : null, bootMs: w.ready ? w.ready.bootMs : null, atlasMs: w.ready ? w.ready.atlasMs : null,
    proc: { peakWsMB: peak("wsMB"), avgWsMB: avgOf("wsMB"), peakPrivMB: peak("privMB"), avgPrivMB: avgOf("privMB"), cpuPct, procs: peak("procs"), samples: tail.length },
    memTimeline: tail.filter((_, i) => i % 5 === 0).map((s) => ({ t: Math.round((s.at - t0) / 1000), wsMB: s.wsMB, privMB: s.privMB })),
    res: w.bench ? w.bench.res : null,
  };
  const r = out.res;
  console.log(`[${run.id}] ${out.ok ? "ok" : "FAILED"}  start ${out.startMs}ms  ` + (r ? `fps ${r.avgFps} low1 ${r.low1Fps} sim ${r.avgSimMs} render ${r.avgRenderMs} soldiers ${r.avgSoldiers || r.peakSoldiers} ` : "") + `ws ${out.proc.peakWsMB}MB priv ${out.proc.peakPrivMB}MB cpu ${cpuPct}%`);
  return out;
}

// ---------- 实验计划 ----------
function plan() {
  const runs = [];
  const add = (group, shell, page, query, extra) => { if (only.includes(shell)) runs.push(Object.assign({ id: `${group}-${shell}-${runs.length}`, group, shell, page, query }, extra)); };
  const shells = ["tauri", "electron", "edge"];
  const want = (g) => mode === g || mode === "all";
  if (mode === "smoke") for (const s of shells) add("smoke", s, "v3", { bench: 800, map: "m", secs: 10, cam: "tour" });
  if (want("startup")) for (let i = 0; i < 3; i++) for (const s of shells) add("startup", s, "v3", {}, { idle: 9000 });
  if (want("scale")) for (const n of [1000, 3000, 6000, 10000]) for (const s of shells) add("scale", s, "v3", { bench: n, map: "l", secs: 30, cam: "tour" });
  if (want("base")) {
    for (const s of shells) add("base-old", s, "base", { bench: 2000 }); // 改造前：40×25 单屏，2000 兵
    for (const s of shells) add("base-new", s, "v3", { bench: 2000, map: "s", secs: 30, cam: "overview", rf: "lod:0" }); // 改造后：同屏 2000 兵全画成精灵
    for (const s of shells) add("base-new-lod", s, "v3", { bench: 2000, map: "s", secs: 30, cam: "overview" }); // 改造后默认设置（俯瞰时用 LOD）
  }
  if (want("xl")) for (const s of shells) add("xl", s, "v3", { bench: 10000, map: "xl", secs: 30, cam: "tour" });
  if (want("ablate")) {
    const variants = { full: "", nolight: "light:0", nofx: "particles:0,weather:0,clouds:0,water:0", noshadow: "shadow:0", notags: "tags:0", nolod: "lod:0" };
    for (const [name, rf] of Object.entries(variants)) add("ablate-" + name, "tauri", "v3", Object.assign({ bench: 6000, map: "l", secs: 30, cam: "tour" }, rf ? { rf } : {}));
  }
  if (mode === "soakclose") for (const s of shells) add("soak-close", s, "v3", { bench: 4000, map: "l", secs: soakSecs, cam: "close" }, { timeout: (soakSecs + 150) * 1000 });
  if (mode === "baseold") for (const s of shells) add("base-old", s, "base", { bench: 2000 });
  if (mode === "diag") for (const s of shells) add("diag", s, "base", { bench: 2000 }, { timeout: 26000 });
  if (mode === "occlude") for (const s of shells) add("occlude", s, "v3", { bench: 3000, map: "l", secs: 40, cam: "close" }, { occludeAt: 26000 });
  if (want("soak")) for (const s of shells) add("soak", s, "v3", { bench: 4000, map: "l", secs: soakSecs, cam: "tour" }, { timeout: (soakSecs + 150) * 1000 });
  return runs;
}

(async () => {
  for (const s of only) if (!fs.existsSync(EXE[s])) { console.error("找不到 " + s + "：" + EXE[s]); process.exit(1); }
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const sampler = startSampler();
  await sleep(2500);
  const runs = plan();
  console.log(`模式 ${mode}：共 ${runs.length} 轮`);
  const results = [];
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const file = path.join(OUT, `${mode}-${stamp}.json`);
  for (const run of runs) {
    let out = await runOne(run, sampler);
    // 整棵进程树的 CPU 占用低得不正常（或者干脆没跑完），说明窗口中途停止了渲染：这一轮作废，最多重跑两次
    for (let retry = 1; retry <= 2 && !run.idle && !run.occludeAt && mode !== "diag" && (!out.ok || (out.proc.cpuPct != null && out.proc.cpuPct < 60)); retry++) {
      console.log(`  ↑ 这一轮无效（CPU ${out.proc.cpuPct}%），第 ${retry} 次重跑`);
      out = await runOne(Object.assign({}, run, { id: run.id + "r" + retry }), sampler);
      out.retries = retry;
    }
    results.push(out);
    fs.writeFileSync(file, JSON.stringify({ mode, at: stamp, results }, null, 1));
  }
  sampler.stop();
  server.close();
  for (const d of fs.readdirSync(TMP)) if (d.startsWith("edge-")) { try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (e) { /* 占用中 */ } }
  console.log("写入 " + file);
  process.exit(0);
})();
