// IPC 基准（?ipc=1）：不跑游戏，只测“一段数据过一次线程 / 进程边界”要多久。
//   tauri-blob   Rust → 页面，二进制响应（invoke 返回 ArrayBuffer）。sim=rust 取快照走的就是这条路
//   tauri-json   Rust → 页面，默认 JSON 序列化（Vec<f32>，页面拿到的是数组）
//   tauri-sink   页面 → Rust，二进制请求体（Uint8Array 作 invoke 的参数）
//   worker-xfer  Worker → 主线程，postMessage 转移 ArrayBuffer（零拷贝）。sim=worker 取快照走的是这条路
//   worker-clone Worker → 主线程，postMessage 结构化克隆（要拷贝一份）
// 每项都是“一问一答”的往返：主线程发请求 → 对方造一块指定大小的数据 → 回到主线程。对方造数据的时间也算在里面，
// 两边造法相同（逐字节填 i & 255），16 MB 约几毫秒，相对小块的往返可以忽略，大块时要记得它在里面。
(function (root) {
  "use strict";
  const CS = root.CS;

  const SIZES = [1 << 10, 4 << 10, 16 << 10, 64 << 10, 256 << 10, 1 << 20, 4 << 20, 16 << 20];
  const repsFor = (size) => (size <= 64 << 10 ? 60 : size <= 1 << 20 ? 40 : size <= 4 << 20 ? 20 : 10);
  const WARM = 3;

  function workerSrc() {
    return `self.onmessage = (e) => {
      const m = e.data;
      const buf = new ArrayBuffer(m.size);
      const v = new Uint8Array(buf);
      for (let i = 0; i < v.length; i++) v[i] = i & 255;
      if (m.xfer) self.postMessage(buf, [buf]); else self.postMessage(buf);
    };`;
  }

  function makeWorker() {
    const url = URL.createObjectURL(new Blob([workerSrc()], { type: "text/javascript" }));
    const wk = new Worker(url);
    let res = null;
    wk.onmessage = (e) => { const r = res; res = null; if (r) r(e.data); };
    return {
      call(size, xfer) { return new Promise((r) => { res = r; wk.postMessage({ size, xfer }); }); },
      stop() { wk.terminate(); URL.revokeObjectURL(url); },
    };
  }

  function stats(times, size, bytesOf) {
    const s = times.slice().sort((a, b) => a - b);
    const avg = s.reduce((a, b) => a + b, 0) / s.length;
    const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
    return {
      size, n: s.length, bytes: bytesOf,
      avgMs: +avg.toFixed(3), p50Ms: +q(0.5).toFixed(3), p95Ms: +q(0.95).toFixed(3), minMs: +s[0].toFixed(3), maxMs: +s[s.length - 1].toFixed(3),
      mbps: +((size / 1048576) / (q(0.5) / 1000)).toFixed(1), // 按中位数算的吞吐（MB/s）
    };
  }

  async function measure(fn, size) {
    for (let i = 0; i < WARM; i++) await fn(size);
    const times = [];
    let bytes = 0;
    for (let i = 0, n = repsFor(size); i < n; i++) {
      const t0 = performance.now();
      const got = await fn(size);
      times.push(performance.now() - t0);
      bytes = got;
    }
    return stats(times, size, bytes);
  }

  CS.ipcBench = async function (post, show) {
    const T = root.__TAURI_INTERNALS__;
    const kinds = {};
    if (T && T.invoke) {
      kinds["tauri-blob"] = async (size) => { const b = await T.invoke("ipc_blob", { size }); return b.byteLength; };
      // JSON 很慢：4 MB 以上不测（4 MB = 100 万个 f32，JSON 文本约 8–10 MB）
      kinds["tauri-json"] = async (size) => { if (size > 4 << 20) return -1; const a = await T.invoke("ipc_json", { n: size >> 2 }); return a.length * 4; };
      kinds["tauri-sink"] = async (size) => { const u = new Uint8Array(size); for (let i = 0; i < size; i++) u[i] = i & 255; return T.invoke("ipc_sink", u); };
    }
    let wk = null;
    try { wk = makeWorker(); } catch (e) { CS.main.errors.push("ipc worker: " + String(e)); }
    if (wk) {
      kinds["worker-xfer"] = async (size) => (await wk.call(size, true)).byteLength;
      kinds["worker-clone"] = async (size) => (await wk.call(size, false)).byteLength;
    }
    // tauri-sink 的计时里含页面填数据的时间，单独量一下好扣掉
    kinds["fill-only"] = async (size) => { const u = new Uint8Array(size); for (let i = 0; i < size; i++) u[i] = i & 255; return u.length; };
    const rows = [];
    for (const [kind, fn] of Object.entries(kinds)) {
      for (const size of SIZES) {
        if (kind === "tauri-json" && size > 4 << 20) continue;
        show(`IPC 基准：${kind} ${size >= 1 << 20 ? size / 1048576 + " MB" : size / 1024 + " KB"}…`);
        try {
          const r = await measure(fn, size);
          r.kind = kind;
          rows.push(r);
        } catch (e) {
          rows.push({ kind, size, error: String(e) });
          CS.main.errors.push(kind + " " + size + ": " + String(e));
        }
      }
    }
    if (wk) wk.stop();
    const res = { ipc: true, shell: CS.main.shell(), rows, errors: CS.main.errors.slice(0, 5), errorCount: CS.main.errors.length, ua: navigator.userAgent };
    root.__bench = res;
    document.body.dataset.bench = JSON.stringify(res);
    post({ event: "bench", res });
    const fmt = (s) => (s >= 1 << 20 ? s / 1048576 + " MB" : s / 1024 + " KB");
    show(`IPC 基准完成（${res.shell}）\n` + rows.map((r) => `${r.kind.padEnd(13)} ${fmt(r.size).padStart(7)}  ` + (r.error ? r.error : `p50 ${r.p50Ms} ms  P95 ${r.p95Ms} ms  ${r.mbps} MB/s`)).join("\n"));
  };
})(typeof window !== "undefined" ? window : globalThis);
