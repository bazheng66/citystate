// 界面：各屏幕、对局 HUD、输入
(function (root) {
  "use strict";
  const CS = root.CS;
  const $ = (s) => document.querySelector(s);
  const UI = (CS.ui = {
    screen: "title", faction: "duchy", mission: 0, world: null, sel: new Set(), selStruct: null, slot: null,
    aim: null, markers: [], box: null, mouse: null, hoverSlot: null, paused: false, speed: 1, perf: false,
    drag: null, lastPanel: "", lastSpells: "", lastHud: "", bench: null, missionDef: null,
    keys: {}, hoverStruct: null, conqDef: null,
  });

  // ---------- DOM 差量更新：保持按钮元素稳定，避免点击落空 ----------
  const tpl = document.createElement("template");
  function morph(el, html) {
    if (el.__html === html) return;
    el.__html = html;
    tpl.innerHTML = html;
    syncChildren(el, tpl.content);
  }
  function syncChildren(dst, src) {
    const a = Array.from(dst.childNodes);
    const b = Array.from(src.childNodes);
    for (let i = 0; i < b.length; i++) {
      const n = b[i];
      const o = a[i];
      if (!o) { dst.appendChild(n.cloneNode(true)); continue; }
      if (o.nodeType !== n.nodeType || o.nodeName !== n.nodeName || (n.nodeType === 1 && n.dataset && (n.dataset.a !== o.dataset.a || n.dataset.k !== o.dataset.k))) {
        dst.replaceChild(n.cloneNode(true), o);
        continue;
      }
      if (n.nodeType === 3) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; continue; }
      if (n.nodeType !== 1) continue;
      for (const at of Array.from(o.attributes)) if (!n.hasAttribute(at.name)) o.removeAttribute(at.name);
      for (const at of Array.from(n.attributes)) if (o.getAttribute(at.name) !== at.value) o.setAttribute(at.name, at.value);
      if (n.nodeName === "BUTTON") o.disabled = n.hasAttribute("disabled");
      syncChildren(o, n);
    }
    for (let i = a.length - 1; i >= b.length; i--) dst.removeChild(a[i]);
  }

  // ---------- 图标 ----------
  const iconCache = new Map();
  function icon(faction, type, tier) {
    const key = faction + type + (tier || 0);
    if (iconCache.has(key)) return iconCache.get(key);
    const s = CS.unitSprite(faction, type, "idle", 0, 1);
    const b = s.box;
    const k = Math.max(1, Math.floor(36 / Math.max(b.w, b.h)));
    const c = document.createElement("canvas");
    c.width = b.w * k; c.height = b.h * k;
    const g = c.getContext("2d");
    g.imageSmoothingEnabled = false;
    g.drawImage(s.c, s.sx + b.x, s.sy + b.y, b.w, b.h, 0, 0, c.width, c.height);
    if (tier) { g.fillStyle = "#ffd96a"; for (let i = 0; i < tier; i++) g.fillRect(1 + i * 4, 1, 3, 3); }
    const url = c.toDataURL();
    iconCache.set(key, url);
    return url;
  }
  const SPELL_ICON = { heal: "✚", smite: "☀", advent: "✦", lust: "✊", fire: "☄", worms: "❂", frost: "❄", freeze: "✱", blizzard: "❆",
    bloom: "❀", thorns: "♣", gale: "≋", dread: "☠", plague: "☣", legion: "♜" };

  // ---------- 屏幕切换 ----------
  UI.show = function (name) {
    for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== name;
    UI.screen = name;
    if (name === "campaign") renderCampaign();
    if (name === "edicts") renderEdicts();
    if (name === "conquest") renderConquest();
    if (name === "title") CS.main.titleAnim(true); else CS.main.titleAnim(false);
  };

  document.addEventListener("click", (e) => {
    CS.audio.unlock();
    const go = e.target.closest("[data-go]");
    if (!go) return;
    CS.audio.play("click");
    const where = go.dataset.go;
    if (where === "settings") return openSettings();
    if (where === "help") return openHelp();
    if (where === "bench") return openBench();
    UI.show(where);
  });

  // ---------- 战役 ----------
  const NODE_POS = [[120, 420], [250, 300], [400, 380], [520, 230], [660, 330], [790, 170]];
  function renderCampaign() {
    const save = CS.save.get();
    const tabs = $("#fac-tabs");
    tabs.innerHTML = CS.CAMPAIGN_ORDER.map((f) => {
      const F = CS.FACTIONS[f];
      const open = CS.save.unlocked(f);
      return `<button data-fac="${f}" class="${UI.faction === f ? "on" : ""}" ${open ? "" : "disabled title='完成前一个战役第 " + CS.UNLOCK_AT + " 关解锁'"}><span class="dot" style="background:${F.color}"></span>${F.name}${open ? "" : " 🔒"}</button>`;
    }).join("");
    if (!CS.save.unlocked(UI.faction)) UI.faction = "duchy";
    const list = CS.CAMPAIGNS[UI.faction];
    if (!CS.save.unlocked(UI.faction, UI.mission)) UI.mission = 0;
    // 默认选中第一个未完成且已解锁的关卡
    $("#edict-pts").textContent = CS.save.points(UI.faction);
    $("#fac-note").textContent = CS.FACTIONS[UI.faction].motto;
    drawCampMap();
    const m = list[UI.mission];
    const L = CS.LAYOUTS[m.layout];
    $("#m-title").textContent = `第 ${UI.mission + 1} 关 · ${L.name}`;
    const foes = [m.a, m.b].filter(Boolean).map((f) => `<span style="color:${CS.FACTIONS[f].light}">${CS.FACTIONS[f].name}</span>`).join(" 与 ");
    $("#m-meta").innerHTML = `对手：${foes} · 难度 ${"★".repeat(m.diff + 1)}${"☆".repeat(5 - m.diff)}`;
    $("#m-brief").textContent = m.brief;
    const rec = save.missions[CS.missionId(UI.faction, UI.mission)];
    $("#m-best").innerHTML = rec ? `最佳：<b style="color:${CS.RATING[rec.rating].color}">${CS.RATING[rec.rating].name}</b> · ${fmt(rec.time)}（完美线 ${fmt(CS.PAR[0])}）` : `未通关 · 完美线 ${fmt(CS.PAR[0])}，优秀线 ${fmt(CS.PAR[1])}`;
    $("#m-go").disabled = !CS.save.unlocked(UI.faction, UI.mission);
  }

  function drawCampMap() {
    const c = $("#camp-map");
    const g = c.getContext("2d");
    const F = CS.FACTIONS[UI.faction];
    const save = CS.save.get();
    // 羊皮纸
    const gr = g.createRadialGradient(450, 280, 80, 450, 280, 560);
    gr.addColorStop(0, "#e8d3a2");
    gr.addColorStop(1, "#b48e57");
    g.fillStyle = gr;
    g.fillRect(0, 0, 900, 560);
    const rand = CS.rng(UI.faction.length * 99);
    // 海岸、山、林
    g.fillStyle = "rgba(90,130,150,0.35)";
    g.beginPath();
    g.moveTo(900, 0);
    for (let y = 0; y <= 560; y += 40) g.lineTo(840 + Math.sin(y / 70) * 30 + rand() * 10, y);
    g.lineTo(900, 560);
    g.fill();
    for (let i = 0; i < 26; i++) {
      const x = 40 + rand() * 780;
      const y = 40 + rand() * 480;
      g.strokeStyle = "rgba(90,62,30,0.55)";
      g.lineWidth = 2;
      g.beginPath();
      if (rand() < 0.5) { g.moveTo(x - 12, y + 8); g.lineTo(x, y - 8); g.lineTo(x + 12, y + 8); }
      else { g.arc(x, y, 5, 0, Math.PI * 2); g.moveTo(x + 10, y + 2); g.arc(x + 8, y + 2, 4, 0, Math.PI * 2); }
      g.stroke();
    }
    // 路线
    g.setLineDash([6, 7]);
    g.strokeStyle = "rgba(100,50,20,0.7)";
    g.lineWidth = 3;
    g.beginPath();
    NODE_POS.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.stroke();
    g.setLineDash([]);
    // 关卡点
    CS.CAMPAIGNS[UI.faction].forEach((m, i) => {
      const [x, y] = NODE_POS[i];
      const open = CS.save.unlocked(UI.faction, i);
      const rec = save.missions[CS.missionId(UI.faction, i)];
      const enemy = CS.FACTIONS[m.a];
      g.fillStyle = "rgba(60,30,10,0.3)";
      g.beginPath(); g.ellipse(x, y + 22, 26, 8, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = open ? (rec ? F.color : enemy.color) : "#8b7b62";
      g.strokeStyle = i === UI.mission ? "#fff3c4" : "#4a2a10";
      g.lineWidth = i === UI.mission ? 4 : 2;
      g.beginPath(); g.arc(x, y, 22, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = "#fff6dc";
      g.font = "bold 20px Microsoft YaHei, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(open ? String(i + 1) : "🔒", x, y + 1);
      g.font = "bold 14px Microsoft YaHei, sans-serif";
      g.fillStyle = "#3d2410";
      g.fillText(CS.LAYOUTS[m.layout].name, x, y + 40);
      if (rec) {
        g.fillStyle = CS.RATING[rec.rating].color;
        g.strokeStyle = "#3d2410";
        g.lineWidth = 3;
        g.strokeText(CS.RATING[rec.rating].name, x, y - 34);
        g.fillText(CS.RATING[rec.rating].name, x, y - 34);
      }
    });
    g.textBaseline = "alphabetic";
    g.font = "bold 26px Microsoft YaHei, sans-serif";
    g.textAlign = "left";
    g.fillStyle = "#4a2a10";
    g.fillText(F.name + " 战役", 24, 40);
  }

  $("#camp-map").addEventListener("click", (e) => {
    const c = e.currentTarget;
    const r = c.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * c.width;
    const y = (e.clientY - r.top) / r.height * c.height;
    NODE_POS.forEach(([nx, ny], i) => {
      if (Math.hypot(nx - x, ny - y) < 30 && CS.save.unlocked(UI.faction, i)) { UI.mission = i; CS.audio.play("click"); renderCampaign(); }
    });
  });
  $("#camp-map").addEventListener("dblclick", () => { if (!$("#m-go").disabled) startMission(UI.faction, UI.mission); });
  $("#fac-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-fac]");
    if (!b || b.disabled) return;
    UI.faction = b.dataset.fac;
    UI.mission = 0;
    // 跳到第一个没打过的关
    const list = CS.CAMPAIGNS[UI.faction];
    for (let i = 0; i < list.length; i++) {
      if (CS.save.unlocked(UI.faction, i)) UI.mission = i;
      if (!CS.save.get().missions[CS.missionId(UI.faction, i)]) break;
    }
    renderCampaign();
  });
  $("#m-go").addEventListener("click", () => startMission(UI.faction, UI.mission));
  $("#open-edicts").addEventListener("click", () => UI.show("edicts"));

  // ---------- 敕令 ----------
  function renderEdicts() {
    const f = UI.faction;
    const ed = CS.save.get().edicts[f];
    $("#ed-title").textContent = CS.FACTIONS[f].name + " · 敕令";
    $("#ed-pts").textContent = CS.save.points(f);
    $("#ed-grid").innerHTML = CS.EDICTS.map((e) => {
      const rank = ed[e.id] || 0;
      const cost = rank < e.max ? CS.EDICT_COST[rank] : null;
      return `<div class="edict"><h3>${e.name}</h3><div class="pips">${Array.from({ length: e.max }, (_, i) => `<i class="${i < rank ? "on" : ""}"></i>`).join("")}</div><p>${e.desc}</p>
        <button data-ed="${e.id}" ${cost == null || CS.save.points(f) < cost ? "disabled" : ""}>${cost == null ? "已满" : "颁布（" + cost + " 点）"}</button></div>`;
    }).join("");
  }
  $("#ed-grid").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ed]");
    if (!b) return;
    if (CS.save.buyEdict(UI.faction, b.dataset.ed)) CS.audio.play("gold");
    renderEdicts();
  });
  $("#ed-reset").addEventListener("click", () => { CS.save.resetEdicts(UI.faction); renderEdicts(); });

  // ---------- 开局 ----------
  function startMission(faction, idx) {
    const m = CS.CAMPAIGNS[faction][idx];
    UI.missionDef = { faction, idx, m };
    UI.conqDef = null;
    const shift = CS.save.get().settings.diff || 0;
    const world = CS.createWorld({
      player: faction, layout: CS.LAYOUTS[m.layout], flip: m.flip, diff: Math.max(0, Math.min(5, m.diff + shift)), gold: m.gold + (shift < 0 ? 60 : 0),
      enemies: { a: m.a, b: m.b }, edicts: CS.save.get().edicts[faction],
    });
    beginWorld(world, `${CS.FACTIONS[faction].name} · 第 ${idx + 1} 关 ${CS.LAYOUTS[m.layout].name}`);
    UI.tutorial = idx === 0 && !CS.save.get().missions[CS.missionId(faction, 0)] ? 0 : -1;
    for (const step of TUT) step.shown = false;
  }
  UI.startMission = startMission;

  function beginWorld(world, title) {
    UI.world = world;
    UI.sel.clear();
    UI.selStruct = world.structs.find((s) => s.owner === "p") || null;
    UI.slot = null;
    UI.aim = null;
    UI.markers = [];
    UI.paused = false;
    UI.speed = 1;
    UI.lastPanel = "";
    UI.lastSpells = "";
    $("#h-mission").textContent = title;
    UI.banner = { text: title, sub: UI.bench ? "" : "目标：摧毁或占领全部敌方据点", t: performance.now() };
    $("#h-speed").textContent = "×1";
    $("#h-pause").textContent = "❚❚";
    closeModal();
    $("#techpop").hidden = true;
    UI.keys = {};
    UI.hoverStruct = null;
    UI.show("game");
    CS.main.fit();
    CS.render.setWorld(world);
    CS.main.fitMinimap();
    CS.main.resetClock();
  }
  UI.beginWorld = beginWorld;

  // ---------- 提示 ----------
  function toast(text, cls, ms) {
    const d = document.createElement("div");
    d.textContent = text;
    if (cls) d.className = cls;
    if (ms) d.style.animationDuration = ms / 1000 + "s";
    $("#toast").appendChild(d);
    setTimeout(() => d.remove(), ms || 2600);
    while ($("#toast").children.length > 4) $("#toast").firstChild.remove();
  }
  UI.toast = toast;

  function fmt(s) {
    s = Math.max(0, Math.floor(s));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  UI.fmt = fmt;

  // ---------- 世界事件 ----------
  UI.consumeEvents = function (world) {
    const evs = world.events;
    if (!evs.length) return;
    const P = "p";
    const Rn = CS.render;
    // 大地图上到处在打仗：只有镜头里、且没被迷雾盖住的事件才出声、出粒子
    const near = (ev) => Rn.inView(ev.x, ev.y, 60) && Rn.visible(ev.x, ev.y);
    let fxBudget = 60;
    for (const ev of evs) {
      switch (ev.e) {
        case "hit":
          if (near(ev)) { CS.audio.play("hit"); if (fxBudget-- > 0) Rn.burst(ev.type === "siege" ? "debris" : "spark", ev.x, ev.y - 8, 1); }
          break;
        case "shoot": if (near(ev)) CS.audio.play(ev.k === "stone" ? "stone" : ev.k === "bolt" ? "bolt" : "shoot"); break;
        case "impact":
          if (!near(ev)) break;
          if (ev.k === "stone") { CS.audio.play("stone"); Rn.shake(1.5); Rn.burst("debris", ev.x, ev.y - 4, 1); Rn.burst("smoke", ev.x, ev.y - 4, 0.6); }
          else if (fxBudget-- > 0) Rn.burst("magic", ev.x, ev.y - 6, 1);
          break;
        case "die":
          if (near(ev)) { CS.audio.play("die"); if (fxBudget-- > 0) Rn.burst(ev.type === "siege" ? "debris" : ev.type === "bone" ? "dust" : "blood", ev.x, ev.y - 6, 1); }
          break;
        case "ruin":
          if (near(ev) || ev.owner === P || ev.by === P) CS.audio.play("ruin");
          if (near(ev)) { Rn.shake(3); Rn.burst("debris", ev.x, ev.y - 14, 3); Rn.burst("smoke", ev.x, ev.y - 20, 4); Rn.burst("dust", ev.x, ev.y, 8); }
          if (ev.owner === P) toast("我们的据点被摧毁了！", "warn");
          else if (ev.by === P) toast("敌方据点倒塌 —— 派部队进去重建就能占领", "good");
          if (UI.selStruct && UI.selStruct.id === ev.id) UI.lastPanel = "";
          break;
        case "capture":
          if (ev.owner === P || near(ev)) CS.audio.play("capture");
          if (near(ev)) {
            world.fx.push({ k: "text", text: ev.owner === P ? "占领！" : "易手", x: ev.x, y: ev.y - 50, t: world.t, life: 1.6, color: ev.owner === P ? "#bff59c" : "#ffb0a0" });
            Rn.burst("star", ev.x, ev.y - 30, 1.5);
          }
          if (ev.owner === P) toast("据点已重建，归我方所有", "good");
          UI.lastPanel = "";
          break;
        case "spawn": if (ev.owner === P) CS.audio.play("spawn"); break;
        case "build": if (ev.owner === P) { CS.audio.play("build"); world.fx.push({ k: "build", x: ev.x, y: ev.y, t: world.t, life: 0.6 }); Rn.burst("dust", ev.x, ev.y, 4); } break;
        case "upgrade": if (ev.owner === P) { CS.audio.play("capture"); world.fx.push({ k: "text", text: "升级！", x: ev.x, y: ev.y - 50, t: world.t, life: 1.4 }); Rn.burst("star", ev.x, ev.y - 30, 1); } break;
        case "tech":
          if (ev.owner === P) { CS.audio.play("capture"); const tc = CS.TECHS.find((t) => t.id === ev.id); toast("科技完成：" + tc.name + " " + world.owners.p.tech[ev.id] + " 级", "good"); }
          break;
        case "cast": {
          if (!near(ev) && ev.owner !== P) break;
          CS.audio.play("cast");
          const shake = { smite: 5, freeze: 3, advent: 4, worms: 4, blizzard: 3, fire: 2, thorns: 3, legion: 4, gale: 3 }[ev.key];
          if (shake) Rn.shake(shake);
          Rn.burst({ heal: "heal", bloom: "heal", freeze: "ice", frost: "ice", blizzard: "ice", fire: "fire", lust: "fire", thorns: "leaf", gale: "leaf", smite: "star" }[ev.key] || "magic", ev.x, ev.y - 6, 2);
          break;
        }
        case "chest":
          if (near(ev) || ev.owner === P) {
            CS.audio.play("gold");
            world.fx.push({ k: "text", text: "+" + ev.gold + " 金", x: ev.x, y: ev.y - 14, t: world.t, life: 1.6, color: "#ffd96a" });
            Rn.burst("gold", ev.x, ev.y - 6, 1);
          }
          if (ev.owner === P) toast(`打开宝箱，获得 ${ev.gold} 金`, "good");
          break;
        case "sortie": if (ev.owner === P) CS.audio.play("alarm"); break;
        case "eliminated": toast(`${CS.FACTIONS[world.owners[ev.owner].faction].name} 已被击溃`, "good", 3500); break;
        case "win": onEnd(true); break;
        case "lose": onEnd(false); break;
        default: break;
      }
    }
    evs.length = 0;
  };

  function onEnd(won) {
    const w = UI.world;
    if (UI.bench) return;
    CS.audio.play(won ? "win" : "lose");
    const md = UI.missionDef;
    let gained = 0;
    let rating = 2;
    if (won && md) {
      rating = w.t < CS.PAR[0] ? 0 : w.t < CS.PAR[1] ? 1 : 2;
      const r = CS.save.record(md.faction, md.idx, rating, w.t);
      gained = r.gained;
    }
    const Rt = CS.RATING[rating];
    const mine = w.structs.filter((st) => st.owner === "p" && !st.ruined).length;
    const body = `<h2>${won ? "胜利" : "战败"}</h2>
      ${won ? (md ? `<div class="rating" style="color:${Rt.color}">${Rt.name}</div>` : `<div class="rating" style="color:#ffd96a">大陆一统</div>`) : `<p class="muted">所有据点和部队都没了。换个打法再来。</p>`}
      <div class="stats">
        <span>用时 <b>${fmt(w.t)}</b></span><span>击杀 <b>${w.stats.kills}</b></span>
        <span>阵亡 <b>${w.stats.lost}</b></span><span>占领 <b>${w.stats.captured}</b></span>
        <span>花费 <b>${w.stats.spent} 金</b></span>${md ? `<span>敕令点 <b>+${gained}</b></span>` : `<span>据点 <b>${mine}/${w.structs.length}</b></span>`}
      </div>
      ${won && md ? `<p class="muted">完美线 ${fmt(CS.PAR[0])} · 优秀线 ${fmt(CS.PAR[1])}</p>` : ""}
      <div class="btns">
        <button data-m="retry">再打一次</button>
        <button data-m="map">${md ? "返回战役" : "返回"}</button>
        ${won && md && md.idx < CS.CAMPAIGNS[md.faction].length - 1 ? `<button class="big" data-m="next">下一关</button>` : ""}
      </div>`;
    openModal(body);
  }

  // ---------- 弹窗 ----------
  function openModal(html) {
    $("#modal-card").className = "card";
    $("#modal-card").innerHTML = html;
    $("#modal").hidden = false;
  }
  function closeModal() { $("#modal").hidden = true; }
  UI.closeModal = closeModal;
  UI.modalOpen = () => !$("#modal").hidden;

  $("#modal").addEventListener("click", (e) => {
    const sg = e.target.closest("[data-bs] [data-v]");
    if (sg) { // 压力测试面板里的选项
      const v = sg.dataset.v;
      UI.benchSel[sg.parentNode.dataset.bs] = isNaN(Number(v)) ? v : Number(v);
      openBench();
      return;
    }
    const b = e.target.closest("[data-m]");
    if (!b) return;
    CS.audio.play("click");
    const md = UI.missionDef;
    switch (b.dataset.m) {
      case "resume": closeModal(); UI.paused = false; break;
      case "retry": if (md) startMission(md.faction, md.idx); else if (UI.bench) CS.main.startBench(UI.bench.cfg); else if (UI.conqDef) startConquest(UI.conqDef); break;
      case "map": closeModal(); UI.world = null; UI.bench = null; UI.show(md ? "campaign" : UI.conqDef ? "conquest" : "title"); break;
      case "next": startMission(md.faction, md.idx + 1); UI.mission = md.idx + 1; break;
      case "help": openHelp(true); break;
      case "settings": openSettings(true); break;
      case "close": closeModal(); if (UI.screen === "game") UI.paused = false; break;
      case "back": openPause(); break;
      case "bench": closeModal(); CS.main.startBench(Object.assign({}, UI.benchSel)); break;
      case "reset-save": if (confirm("清空所有进度与敕令？")) { CS.save.reset(); closeModal(); UI.show("title"); } break;
      default: break;
    }
  });

  function openPause() {
    UI.paused = true;
    openModal(`<h2>暂停</h2><p class="muted">${$("#h-mission").textContent}</p>
      <div class="btns" style="justify-content:flex-start">
        <button class="big" data-m="resume">继续</button><button data-m="retry">重新开始</button>
        <button data-m="help">操作说明</button><button data-m="settings">设置</button><button data-m="map">退出</button>
      </div>`);
  }
  UI.openPause = openPause;

  function openHelp(inGame) {
    if (inGame) UI.paused = true;
    openModal(`<h2>操作说明</h2>
      <table>
        <tr><td>视角</td><td>滚轮缩放（以鼠标位置为中心）· 按住<b>右键或中键</b>拖动地图 · 方向键平移 · 点小地图跳转 · <kbd>Home</kbd> 回都城</td></tr>
        <tr><td>出兵</td><td>点己方城，再点下方兵种图标。部队练好后站在城旁</td></tr>
        <tr><td>拖旗下令</td><td>按住部队头顶的<b>旗标</b>（或部队本身）拖到目标松开：敌城 = 进攻，废墟 = 占领，己方城 = 进驻，空地 = 移动。拖动时会显示将要做什么</td></tr>
        <tr><td>守军</td><td>城头的小旗是城里的守军，拖出来就能派走。守军会回血，敌人靠近时自动出城迎战</td></tr>
        <tr><td>建造</td><td>点城旁的木牌：金矿（金币）、方尖碑（法力）、农场（部队上限）、箭楼（城防火力）</td></tr>
        <tr><td>科技</td><td>右上角「科技」或按 <kbd>K</kbd>：锻造、甲胄、驿道、城防、税制，花金币立刻生效</td></tr>
        <tr><td>升级</td><td>选中城点「升级」。升级后训练出的部队是老兵 / 精锐</td></tr>
        <tr><td>占领</td><td>先打掉城的耐久，城会变成废墟；派部队进废墟重建，修好就归你</td></tr>
        <tr><td>多选（可选）</td><td>在空地拖出方框选中多队，再拖其中一队的旗标，整组一起走</td></tr>
        <tr><td>法术</td><td><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> 选法术，左键施放，右键取消。第三个法术需要控制法塔</td></tr>
        <tr><td>快捷键（可选）</td><td><kbd>Q</kbd><kbd>W</kbd><kbd>E</kbd><kbd>R</kbd><kbd>T</kbd><kbd>Y</kbd> 出兵 · <kbd>U</kbd> 升级 · <kbd>空格</kbd> 暂停 · <kbd>F</kbd> 加速 · <kbd>F3</kbd> 性能面板 · <kbd>Esc</kbd> 取消/菜单</td></tr>
        <tr><td>克制</td><td>步兵 › 骑兵 › 弓手 › 步兵；投石车砸城；法师无视护甲；骑兵冲锋第一击 ×2.6</td></tr>
      </table>
      <div class="btns">${inGame ? '<button data-m="back">返回</button>' : '<button data-m="close">知道了</button>'}</div>`);
  }

  function openSettings(inGame) {
    if (inGame) UI.paused = true;
    const st = CS.save.get().settings;
    openModal(`<h2>设置</h2>
      <div class="field"><span>音量</span><input type="range" id="s-vol" min="0" max="1" step="0.05" value="${st.vol}"></div>
      <div class="field"><span>背景音乐</span><input type="checkbox" id="s-music" ${st.music !== false ? "checked" : ""}></div>
      <div class="field"><span>静音</span><input type="checkbox" id="s-mute" ${st.muted ? "checked" : ""}></div>
      <div class="field"><span>难度</span><select id="s-diff">${["简单", "普通", "困难"].map((n, i) => `<option value="${i - 1}" ${(st.diff || 0) === i - 1 ? "selected" : ""}>${n}</option>`).join("")}</select></div>
      <div class="field"><span>昼夜与光照</span><input type="checkbox" id="s-light" ${st.dayNight !== false ? "checked" : ""}></div>
      <div class="field"><span>粒子、天气与云影</span><input type="checkbox" id="s-fx" ${st.fx !== false ? "checked" : ""}></div>
      <div class="field"><span>显示性能面板（F3）</span><input type="checkbox" id="s-perf" ${st.perf ? "checked" : ""}></div>
      <div class="field"><span>解锁全部战役与关卡</span><input type="checkbox" id="s-unlock" ${st.unlockAll ? "checked" : ""}></div>
      <div class="btns"><button data-m="reset-save">清空进度</button>${inGame ? '<button data-m="back">返回</button>' : '<button data-m="close">完成</button>'}</div>`);
    const sync = () => {
      st.vol = Number($("#s-vol").value);
      st.muted = $("#s-mute").checked;
      st.perf = $("#s-perf").checked;
      st.unlockAll = $("#s-unlock").checked;
      st.diff = Number($("#s-diff").value);
      st.music = $("#s-music").checked;
      st.dayNight = $("#s-light").checked;
      st.fx = $("#s-fx").checked;
      UI.applyGfx(st);
      CS.audio.music.enabled = st.music;
      CS.audio.musicPlay(UI.screen === "game" && !UI.paused);
      CS.audio.setVolume(st.vol);
      CS.audio.setMuted(st.muted);
      UI.perf = st.perf;
      CS.save.write();
    };
    for (const id of ["#s-vol", "#s-mute", "#s-perf", "#s-unlock", "#s-diff", "#s-music", "#s-light", "#s-fx"]) $(id).addEventListener("input", sync);
  }
  // 画面设置 → 渲染开关
  UI.applyGfx = function (st) {
    const fx = st.fx === false ? 0 : 1;
    CS.RF.light = st.dayNight === false ? 0 : 1;
    CS.RF.particles = fx;
    CS.RF.weather = fx;
    CS.RF.clouds = fx;
  };

  UI.benchSel = { n: 3000, map: "l", cam: "tour", secs: 30 };
  function openBench() {
    const S = UI.benchSel;
    const seg = (key, opts) => `<div class="seg" data-bs="${key}">` + opts.map(([v, label]) => `<button data-v="${v}" class="${String(S[key]) === String(v) ? "on" : ""}">${label}</button>`).join("") + "</div>";
    openModal(`<h2>压力测试</h2>
      <p class="muted">程序生成的大陆上多方混战：据点打不坏、兵死了会补，负载稳定。记录帧时间、卡顿帧、模拟与渲染耗时、地形块烘焙和内存。同一个页面在浏览器、Tauri（WebView2）和 Electron 里各跑一次，就能直接对比。</p>
      <div class="bench-grid">
        <span>士兵数</span>${seg("n", [[1000, "1000"], [3000, "3000"], [6000, "6000"], [10000, "10000"], [20000, "20000"]])}
        <span>地图</span>${seg("map", CS.MAP_SIZES.map((m) => [m.id, m.name]))}
        <span>相机</span>${seg("cam", [["tour", "巡游 + 俯瞰"], ["close", "只近景"], ["overview", "只俯瞰"]])}
        <span>时长</span>${seg("secs", [[30, "30 秒"], [120, "2 分钟"], [600, "10 分钟浸泡"]])}
      </div>
      <div class="btns"><button data-m="close">取消</button><button class="big" data-m="bench">开始</button></div>`);
    $("#modal-card").className = "card wide";
  }

  // ---------- 对局 HUD ----------
  UI.updateHud = function () {
    const w = UI.world;
    if (!w) return;
    const P = w.owners.p;
    let rate = 0;
    for (const st of w.structs) {
      if (st.owner !== "p" || st.ruined) continue;
      rate += CS.STRUCTS[st.type].gold;
      for (const a of st.addons) if (a === "mine") rate += CS.ADDONS.mine.income.gold;
    }
    rate *= P.income * (1 + 0.1 * (P.tech.tax || 0));
    const foes = w.structs.filter((s) => s.owner && s.owner !== "p" && s.owner !== "n" && !s.ruined).length;
    const hud = `${Math.floor(P.gold)}|${rate.toFixed(1)}|${Math.floor(P.mana)}|${P.used}/${P.supply}|${fmt(w.t)}|${foes}`;
    if (hud !== UI.lastHud) {
      UI.lastHud = hud;
      $("#h-gold").textContent = Math.floor(P.gold);
      $("#h-gold-rate").textContent = "+" + rate.toFixed(1) + "/秒";
      $("#h-mana").textContent = Math.floor(P.mana);
      $("#h-supply").textContent = P.used + "/" + P.supply;
      $(".res.supply").classList.toggle("full", P.used >= P.supply);
      $("#h-clock").textContent = fmt(w.t);
      $("#h-goal").textContent = UI.bench ? "" : UI.conqDef ? `对手 ${w.foeIds.filter((id) => w.owners[id].alive).length} 家 · 敌方据点 ${foes}` : `剩余敌方据点 ${foes}`;
    }
    renderPanel(w);
    renderSpells(w);
    UI.refreshBuild();
    renderTech();
    for (const st of w.structs) {
      if (st.owner !== "p" || st.ruined) continue;
      if (w.t - st.lastHit < 1 && w.t - (st.alertT || -99) > 15) {
        st.alertT = w.t;
        toast(`${CS.STRUCTS[st.type].name}正在遭到攻击！`, "warn");
        CS.audio.play("alarm");
      }
    }
    $("#h-speed").textContent = "×" + UI.speed;
    tutorialStep(w);
  };

  // 第一关的分步提示
  const TUT = [
    { msg: "① 你的城镇已选中。点下方「步兵 / 弓手」出兵。", done: (w) => w.squads.some((q) => q.owner === "p" && !q.inside) },
    { msg: "② 按住部队头顶的旗标，拖到下方的废墟上松开 —— 进去重建就归你。", done: (w) => w.structs.filter((s) => s.owner === "p" && !s.ruined).length >= 2 || w.squads.some((q) => q.owner === "p" && q.order === "rebuild") },
    { msg: "③ 点城旁的木牌建「金矿」(加金币) 或「农场」(加部队上限)。", done: (w) => w.structs.some((s) => s.owner === "p" && s.addons.some(Boolean)) },
    { msg: "④ 攒几队兵，把旗标拖到敌城上进攻。城塌了再拖进废墟占领。按 1 放法术。", done: (w) => w.outcome },
  ];
  function tutorialStep(w) {
    if (UI.tutorial == null || UI.tutorial < 0 || UI.tutorial >= TUT.length) return;
    const step = TUT[UI.tutorial];
    if (!step.shown) { step.shown = true; toast(step.msg, "good", 9000); step.t = w.t; }
    else if (w.t - step.t > 20 && !step.done(w)) { step.t = w.t; toast(step.msg, "good", 7000); }
    if (step.done(w)) { step.shown = false; UI.tutorial++; }
  }

  function selected(w) {
    const out = [];
    for (const sq of w.squads) if (UI.sel.has(sq.id) && !sq.inside && sq.units.length) out.push(sq);
    if (out.length !== UI.sel.size) { UI.sel = new Set(out.map((s) => s.id)); for (const sq of w.squads) sq.sel = UI.sel.has(sq.id); }
    return out;
  }
  UI.selected = selected;

  function renderPanel(w) {
    const P = w.owners.p;
    const fac = P.faction;
    const sqs = selected(w);
    let sel = "";
    let acts = "";
    const st = UI.selStruct && w.structs.includes(UI.selStruct) ? UI.selStruct : null;
    if (sqs.length) {
      let hp = 0;
      let max = 0;
      for (const s of sqs) { const h = CS.squadHp(s); hp += h.hp; max += s.st.hp * Math.max(s.units.length, 1); }
      const by = {};
      for (const s of sqs) { const key = s.type + s.tier; by[key] = by[key] || { s, n: 0, men: 0 }; by[key].n++; by[key].men += s.units.length; }
      sel = `<h3>${sqs.length === 1 ? sqs[0].st.name : sqs.length + " 支部队"}</h3>
        <div class="hpbar"><i style="width:${Math.round(hp / Math.max(1, max) * 100)}%"></i></div>
        <div class="chips">${Object.values(by).map((b) => `<span class="chip" data-type="${b.s.type}"><img src="${icon(w.owners[b.s.owner].faction, b.s.type, b.s.tier)}" width="18">${b.n > 1 ? b.n + "队 " : ""}${b.men}人</span>`).join("")}</div>
        ${sqs.length === 1 ? `<div class="row"><span>${CS.UNITS[sqs[0].type].tip}</span></div>` : ""}`;
      acts = `<div class="hint">拖动部队头顶的<b>旗标</b>到目标松开即可下令；也可以直接点地面 / 敌城 / 废墟。右键取消选择。</div>`;
    } else if (st) {
      const def = CS.STRUCTS[st.type];
      const mineSt = st.owner === "p" && !st.ruined;
      const ownerName = st.ruined ? "废墟" : CS.FACTIONS[w.owners[st.owner].faction].name;
      const lvName = ["", " · 1 级", " · 2 级"][st.level];
      if (st.ruined) {
        const p = Math.round(st.rebuild / (st.maxHp * 0.45) * 100);
        sel = `<h3>${def.name}废墟</h3><div class="row"><span>${st.rebuild > 0 ? "重建进度 " + p + "%" : "派部队进去即可重建并占领"}</span></div>`;
      } else {
        sel = `<h3>${def.name}${lvName} <span class="muted" style="font-size:13px">${ownerName}</span></h3>
          <div class="hpbar"><i style="width:${Math.round(st.hp / st.maxHp * 100)}%"></i></div>
          <div class="row"><span>耐久 ${Math.ceil(st.hp)}/${Math.round(st.maxHp)}</span><span>守军 ${st.garrison.length}/${CS.GARRISON_MAX}</span></div>
          <div class="row"><span>金 +${def.gold}</span>${def.mana ? `<span>法力 +${def.mana}</span>` : ""}<span>上限 +${def.supply}</span></div>`;
      }
      if (mineSt) {
        {
          acts = def.recruit.map((type) => {
            const s = CS.stats(w, "p", type, st.level);
            const why = CS.canRecruit(w, "p", st, type);
            const queued = st.queue.filter((q) => q.type === type).length;
            const prog = st.queue.length && st.queue[0].type === type ? st.queue[0].t / st.queue[0].total : 0;
            return `<button class="act" data-a="recruit" data-k="${type}" ${why ? "disabled" : ""} data-tip="${type}">
              <span class="key">${CS.UNITS[type].key}</span><img src="${icon(fac, type, st.level)}" width="36"><span>${s.name}${queued ? " ×" + queued : ""}</span><span class="cost">${s.gold} 金</span>
              ${prog ? `<i class="prog" style="width:${Math.round(prog * 100)}%"></i>` : ""}</button>`;
          }).join("");
          const up = CS.upgradeCost(st);
          if (up != null) acts += `<button class="act" data-a="upgrade" ${P.gold >= up ? "" : "disabled"} data-tip="upgrade"><span class="key">U</span>⬆<span>升到 ${st.level + 1} 级</span><span class="cost">${up} 金</span></button>`;
          acts += `<div class="hint">练好的部队站在城旁。拖它头顶的旗标去进攻；城头的小旗是守军，也能拖出去。点木牌建金矿 / 方尖碑 / 农场。</div>`;
        }
      }
    } else {
      sel = `<h3>未选择</h3><div class="row"><span>点己方城出兵；拖部队旗标下令。</span></div><div class="row"><span><kbd>H</kbd> 查看操作说明</span></div>`;
    }
    morph($("#p-sel"), sel);
    morph($("#p-acts"), acts);
  }

  function renderSpells(w) {
    const P = w.owners.p;
    const keys = CS.FACTIONS[P.faction].spells;
    const html = keys.map((k, i) => {
      const sp = CS.SPELLS[k];
      const why = CS.canCast(w, "p", k);
      const cdLeft = Math.max(0, (P.cds[k] || 0) - w.t);
      const cdP = cdLeft > 0 ? cdLeft / (sp.cd * (1 - 0.15 * (P.edicts.haste || 0))) : 0;
      const col = CS.FACTIONS[P.faction].color;
      return `<button class="spell ${UI.aim === k ? "on" : ""}" data-a="spell" data-k="${k}" data-tip="spell:${k}" ${why && why !== "冷却中" ? "disabled" : ""}>
        <span class="key">${i + 1}</span><span class="ico" style="background:${col}">${SPELL_ICON[k]}</span><span>${sp.name}</span><span class="cost">${sp.mana} 法力</span>
        ${cdP > 0 ? `<i class="cd" style="height:${Math.round(cdP * 100)}%"></i>` : ""}</button>`;
    }).join("");
    morph($("#p-spells"), html);
  }

  // 面板按钮
  document.querySelector(".panel").addEventListener("click", (e) => {
    const b = e.target.closest("[data-a]");
    const w = UI.world;
    if (!b || !w) return;
    const chip = e.target.closest(".chip");
    if (chip) { // 只保留该兵种
      const type = chip.dataset.type;
      for (const sq of selected(w)) if (sq.type !== type) { UI.sel.delete(sq.id); sq.sel = false; }
      return;
    }
    act(b.dataset.a, b.dataset.k);
  });
  document.querySelector(".panel").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    const w = UI.world;
    if (!chip || !w) return;
    const type = chip.dataset.type;
    for (const sq of selected(w)) if (sq.type !== type) { UI.sel.delete(sq.id); sq.sel = false; }
  });

  function act(a, k) {
    const w = UI.world;
    if (!w || w.outcome) return;
    const st = UI.selStruct;
    let why = null;
    switch (a) {
      case "recruit": why = CS.recruit(w, "p", st, k); if (!why) CS.audio.play("click"); break;
      case "upgrade": why = CS.upgrade(w, "p", st); break;
      case "release": {
        const out = CS.release(w, st);
        UI.sel = new Set(out.map((s) => s.id));
        for (const sq of w.squads) sq.sel = UI.sel.has(sq.id);
        UI.selStruct = null;
        break;
      }
      case "build": why = CS.build(w, "p", st, UI.slot, k); UI.slot = null; break;
      case "slotx": UI.slot = null; break;
      case "spell": setAim(k); return;
      case "stop": for (const sq of selected(w)) { sq.path = []; sq.goal = null; sq.order = "idle"; sq.target = null; } break;
      case "home": {
        for (const sq of selected(w)) {
          let best = null;
          let bd = Infinity;
          for (const s of w.structs) {
            if (s.owner !== "p" || s.ruined) continue;
            const d = Math.hypot(s.x - sq.x, s.y - sq.y);
            if (d < bd) { bd = d; best = s; }
          }
          if (best) CS.orderStruct(w, [sq], best);
        }
        clearSel();
        break;
      }
      case "desel": clearSel(); break;
      default: break;
    }
    if (why) { CS.audio.play("deny"); toast(why, "warn"); }
    UI.lastPanel = "";
  }
  UI.act = act;

  function setAim(k) {
    const w = UI.world;
    const why = CS.canCast(w, "p", k);
    if (why) { CS.audio.play("deny"); toast(why, "warn"); return; }
    UI.aim = UI.aim === k ? null : k;
    $("#view").classList.toggle("aim", !!UI.aim);
    UI.lastSpells = "";
  }

  function clearSel() {
    UI.sel.clear();
    if (UI.world) for (const sq of UI.world.squads) sq.sel = false;
    UI.lastPanel = "";
  }
  UI.clearSel = clearSel;

  // 悬浮提示
  document.querySelector(".panel").addEventListener("mousemove", (e) => {
    const b = e.target.closest("[data-tip]");
    const tip = $("#tip");
    const w = UI.world;
    if (!b || !w) { tip.hidden = true; return; }
    const key = b.dataset.tip;
    let html = "";
    if (key.startsWith("spell:")) {
      const sp = CS.SPELLS[key.slice(6)];
      html = `<b>${sp.name}</b> <span class="c">${sp.mana} 法力 · 冷却 ${sp.cd}s</span><br>${sp.desc}`;
    } else if (key === "upgrade") {
      html = `<b>升级据点</b><br>耐久 +40%，之后训练的部队变成${UI.selStruct && UI.selStruct.level === 0 ? "老兵（生命 ×1.3 伤害 ×1.25）" : "精锐（生命 ×1.65 伤害 ×1.5）"}，价格也更高。`;
    } else if (CS.UNITS[key]) {
      const st = UI.selStruct;
      const s = CS.stats(w, "p", key, st ? st.level : 0);
      html = `<b>${s.name}</b> <span class="c">${s.gold} 金 · ${s.size} 人</span><br>${CS.UNITS[key].tip}<br><span style="color:#c9b48c">生命 ${Math.round(s.hp)} · 伤害 ${s.dmg.toFixed(1)} · 射程 ${Math.round(s.range)} · 速度 ${Math.round(s.speed)}</span>`;
    }
    tip.innerHTML = html;
    tip.hidden = false;
    const r = $("#stage").getBoundingClientRect();
    tip.style.left = Math.min(r.width - 290, e.clientX - r.left + 12) + "px";
    tip.style.top = Math.max(4, r.height - 120) + "px";
  });
  document.querySelector(".panel").addEventListener("mouseleave", () => { $("#tip").hidden = true; });

  // ---------- 画布输入 ----------
  // 操作：点城出兵；按住部队头顶的旗标（或部队本身）拖到目的地松开。
  // 松在敌城上 = 进攻，废墟上 = 占领重建，己方城上 = 进驻，空地 = 移动。
  // 城里的守军旗标显示在城头，同样可以拖出来派走。
  const view = $("#view");
  const BADGE_HIT = 14;
  function worldPt(e) {
    const r = view.getBoundingClientRect();
    return CS.render.screenToWorld(e.clientX - r.left, e.clientY - r.top);
  }
  function screenPt(p) {
    const r = view.getBoundingClientRect();
    const s = $("#stage").getBoundingClientRect();
    const q = CS.render.worldToScreen(p.x, p.y);
    return { x: r.left - s.left + q.x, y: r.top - s.top + q.y };
  }

  // 旗标（含城里守军的旗标）
  function badgeAt(w, p) {
    let best = null;
    let bd = BADGE_HIT * CS.render.tagScale();
    for (const sq of w.squads) {
      if (sq.owner !== "p" || sq.tagX == null || !sq.units.length || sq.st.summon && !sq.units.length) continue;
      if (sq.inside) { const st = CS.structById(w, sq.inside); if (!st || st.owner !== "p") continue; }
      const d = Math.hypot(sq.tagX - p.x, sq.tagY - p.y);
      if (d < bd) { bd = d; best = sq; }
    }
    return best;
  }
  function squadAt(w, p, ownerOnly) {
    const b = badgeAt(w, p);
    if (b) return b;
    let best = null;
    let bd = 13 * Math.max(1, CS.render.tagScale() * 0.8);
    for (const sq of w.squads) {
      if (sq.inside || (ownerOnly && sq.owner !== "p")) continue;
      for (const u of sq.units) {
        const d = Math.hypot(u.x - p.x, u.y - 8 - p.y);
        if (d < bd) { bd = d; best = sq; }
      }
    }
    return best;
  }
  function structAt(w, p) {
    for (const st of w.structs) {
      if (!CS.render.seen(st.x, st.y)) continue;
      const top = CS.artTop(st);
      const half = CS.STRUCTS[st.type].half;
      if (Math.abs(p.x - st.x) < half && p.y < st.y + 22 && p.y > st.y - top) return st;
    }
    return null;
  }
  function slotAt(w, p) {
    for (const st of w.structs) {
      if (st.owner !== "p" || st.ruined) continue;
      for (let i = 0; i < 3; i++) {
        if (st.addons[i]) continue;
        const [ox, oy] = CS.SLOT_OFFSETS[i];
        if (Math.abs(p.x - (st.x + ox)) < 15 && p.y > st.y + oy - 24 && p.y < st.y + oy + 10) return { st, i };
      }
    }
    return null;
  }

  // 拖到这里会发生什么
  function intentAt(w, p) {
    const st = structAt(w, p);
    if (st) {
      const name = CS.STRUCTS[st.type].name;
      if (st.ruined) return { st, label: "占领 " + name + "废墟", color: "#ffd96a" };
      if (st.owner === "p") return { st, label: "进驻 " + name, color: "#9cc6ff" };
      return { st, label: "进攻 " + name, color: "#ff8a72" };
    }
    return { st: null, label: "移动", color: "#ffe79a" };
  }

  function send(sqs, p) {
    const w = UI.world;
    sqs = sqs.filter((s) => s.units.length);
    if (!sqs.length) return false;
    const it = intentAt(w, p);
    if (it.st) {
      CS.orderStruct(w, sqs, it.st);
      UI.markers.push({ x: it.st.x, y: it.st.y + 12, t: performance.now(), color: it.color });
    } else {
      CS.orderMove(w, sqs, p.x, p.y);
      UI.markers.push({ x: p.x, y: p.y, t: performance.now(), color: it.color });
    }
    CS.audio.play("click");
    return true;
  }
  function command(p) { return send(selected(UI.world), p); }

  // 木牌建造菜单（弹在木牌旁边）
  const pop = $("#buildpop");
  function openBuild(st, i) {
    const w = UI.world;
    UI.selStruct = st;
    UI.slot = i;
    UI.lastPanel = "";
    const [ox, oy] = CS.SLOT_OFFSETS[i];
    const sp = screenPt({ x: st.x + ox, y: st.y + oy - 18 });
    pop.innerHTML = Object.entries(CS.ADDONS).map(([k, a]) => {
      const cost = CS.addonCost(w, "p", k);
      return `<button data-b="${k}" ${w.owners.p.gold >= cost ? "" : "disabled"}><b>${a.name}</b><span>${a.desc}</span><em>${cost} 金</em></button>`;
    }).join("");
    pop.hidden = false;
    const sw = $("#stage").clientWidth;
    pop.style.left = Math.max(4, Math.min(sw - pop.offsetWidth - 4, sp.x - pop.offsetWidth / 2)) + "px";
    pop.style.top = Math.max(4, sp.y - pop.offsetHeight - 6) + "px";
    CS.audio.play("click");
  }
  function closeBuild() { if (!pop.hidden) { pop.hidden = true; UI.slot = null; UI.lastPanel = ""; } }
  UI.closeBuild = closeBuild;
  pop.addEventListener("pointerdown", (e) => e.stopPropagation());
  pop.addEventListener("click", (e) => {
    const b = e.target.closest("[data-b]");
    const w = UI.world;
    if (!b || !w || UI.slot == null) return;
    const why = CS.build(w, "p", UI.selStruct, UI.slot, b.dataset.b);
    if (why) { CS.audio.play("deny"); toast(why, "warn"); } else CS.audio.play("click");
    closeBuild();
  });
  // 金币变化时刷新按钮可用状态
  UI.refreshBuild = function () {
    if (pop.hidden || !UI.world) return;
    for (const b of pop.querySelectorAll("[data-b]")) b.disabled = UI.world.owners.p.gold < CS.addonCost(UI.world, "p", b.dataset.b);
  };

  view.addEventListener("contextmenu", (e) => e.preventDefault());
  view.addEventListener("pointerdown", (e) => {
    CS.audio.unlock();
    const w = UI.world;
    if (!w || w.outcome) return;
    const p = worldPt(e);
    try { view.setPointerCapture(e.pointerId); } catch (_) { /* 合成事件没有活动指针 */ }
    closeBuild();
    if (e.button === 2 || e.button === 1) {
      // 右键 / 中键：按住拖动 = 平移地图；右键原地松开 = 取消或下令
      UI.drag = { kind: "pan", lx: e.clientX, ly: e.clientY, dist: 0, moved: false, btn: e.button };
      return;
    }
    if (UI.aim) {
      const why = CS.cast(w, "p", UI.aim, p.x, p.y);
      if (why) { toast(why, "warn"); CS.audio.play("deny"); }
      UI.aim = null;
      view.classList.remove("aim");
      UI.lastSpells = "";
      return;
    }
    // 优先级：旗标 > 木牌 > 士兵身体 > 空地（框选）
    const badge = badgeAt(w, p);
    const slot = badge ? null : slotAt(w, p);
    const sq = badge || (slot ? null : squadAt(w, p, true));
    if (sq) {
      UI.drag = { kind: "flag", sq, x0: p.x, y0: p.y, moved: false };
      return;
    }
    if (slot) { UI.drag = { kind: "slot", slot, x0: p.x, y0: p.y, moved: false }; return; }
    UI.drag = { kind: "box", x0: p.x, y0: p.y, moved: false, shift: e.shiftKey };
  });
  view.addEventListener("pointermove", (e) => {
    const w = UI.world;
    if (!w) return;
    const pan = UI.drag;
    if (pan && pan.kind === "pan") {
      const dx = e.clientX - pan.lx;
      const dy = e.clientY - pan.ly;
      pan.lx = e.clientX;
      pan.ly = e.clientY;
      pan.dist += Math.abs(dx) + Math.abs(dy);
      if (pan.dist > 6) pan.moved = true;
      if (pan.moved) { CS.render.pan(-dx, -dy, true); view.style.cursor = "grabbing"; }
      return;
    }
    const p = worldPt(e);
    UI.mouse = p;
    if (UI.aim) UI.aimOk = !CS.canCast(w, "p", UI.aim);
    UI.hoverSlot = slotAt(w, p);
    UI.hoverStruct = UI.drag ? null : structAt(w, p);
    const d = UI.drag;
    if (d) {
      if (Math.hypot(p.x - d.x0, p.y - d.y0) > 7) d.moved = true;
      if (d.kind === "box" && d.moved) UI.box = { x0: d.x0, y0: d.y0, x1: p.x, y1: p.y };
      if (d.kind === "flag" && d.moved) {
        const it = intentAt(w, p);
        const sqs = dragGroup(w, d.sq);
        UI.flagLine = { from: sqs.map((s) => ({ x: s.inside ? s.tagX : s.x, y: s.inside ? s.tagY : s.y })), x1: p.x, y1: p.y, label: it.label, color: it.color, st: it.st };
      }
    }
    let cur = UI.aim ? "crosshair" : "default";
    if (d && d.kind === "flag" && d.moved) cur = "grabbing";
    else if (!UI.aim && badgeAt(w, p)) cur = "grab";
    else if (!UI.aim && (UI.hoverSlot || squadAt(w, p, true) || structAt(w, p))) cur = "pointer";
    if (view.style.cursor !== cur) view.style.cursor = cur;
  });
  view.addEventListener("pointerleave", () => { UI.hoverSlot = null; UI.hoverStruct = null; });
  view.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
  view.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (!UI.world) return;
    const r = view.getBoundingClientRect();
    CS.render.zoomAt(Math.pow(1.0018, -e.deltaY), e.clientX - r.left, e.clientY - r.top);
    closeBuild();
  }, { passive: false });
  function rightClick(p) {
    if (UI.aim) { UI.aim = null; view.classList.remove("aim"); UI.lastSpells = ""; return; }
    if (UI.sel.size) { if (!command(p)) clearSel(); return; }
    UI.selStruct = null;
    UI.lastPanel = "";
  }

  // 拖一个已选中的部队 = 拖整组选中部队；否则只拖它自己
  function dragGroup(w, sq) {
    if (UI.sel.has(sq.id) && !sq.inside) return selected(w);
    return [sq];
  }

  view.addEventListener("pointerup", (e) => {
    const w = UI.world;
    const d = UI.drag;
    UI.drag = null;
    UI.flagLine = null;
    if (d && d.kind === "pan") {
      if (!d.moved && d.btn === 2 && w && !w.outcome) rightClick(worldPt(e));
      return;
    }
    if (!w || !d || e.button === 2) return;
    const p = worldPt(e);
    if (d.kind === "flag") {
      if (d.moved) {
        send(dragGroup(w, d.sq), p);
        clearSel();
      } else if (d.sq.inside) {
        // 点城里的守军旗标：选中这座城
        UI.selStruct = CS.structById(w, d.sq.inside);
        UI.lastPanel = "";
      } else selectSquad(d.sq, e.shiftKey, e.detail >= 2);
      return;
    }
    if (d.kind === "slot") { clearSel(); openBuild(d.slot.st, d.slot.i); return; }
    if (d.moved && UI.box) {
      const b = UI.box;
      UI.box = null;
      const x0 = Math.min(b.x0, b.x1); const x1 = Math.max(b.x0, b.x1);
      const y0 = Math.min(b.y0, b.y1); const y1 = Math.max(b.y0, b.y1);
      if (!d.shift) clearSel();
      for (const sq of w.squads) {
        if (sq.owner !== "p" || sq.inside) continue;
        if (sq.units.some((u) => u.x >= x0 && u.x <= x1 && u.y >= y0 && u.y <= y1)) { UI.sel.add(sq.id); sq.sel = true; }
      }
      if (UI.sel.size) { UI.selStruct = null; UI.slot = null; }
      UI.lastPanel = "";
      return;
    }
    UI.box = null;
    // 单击
    const slot = slotAt(w, p);
    if (slot) { clearSel(); openBuild(slot.st, slot.i); return; }
    const st = structAt(w, p);
    if (st && st.owner === "p" && !st.ruined) {
      // 点己方城：打开出兵面板（要进驻请拖旗标）
      clearSel();
      UI.selStruct = st; UI.slot = null; UI.lastPanel = ""; CS.audio.play("click");
      return;
    }
    if (UI.sel.size) { command(p); clearSel(); return; }
    if (st) { UI.selStruct = st; UI.slot = null; UI.lastPanel = ""; CS.audio.play("click"); return; }
    UI.selStruct = null;
    UI.slot = null;
    UI.lastPanel = "";
  });

  function selectSquad(sq, add, sameType) {
    const w = UI.world;
    if (!add) clearSel();
    if (sameType) {
      for (const o of w.squads) if (o.owner === "p" && !o.inside && o.type === sq.type) { UI.sel.add(o.id); o.sel = true; }
    } else if (add && UI.sel.has(sq.id)) { UI.sel.delete(sq.id); sq.sel = false; }
    else { UI.sel.add(sq.id); sq.sel = true; }
    UI.selStruct = null;
    UI.slot = null;
    UI.lastPanel = "";
    CS.audio.play("click");
  }
  // ---------- 键盘 ----------
  document.addEventListener("keydown", (e) => {
    if (UI.screen !== "game" || !UI.world) return;
    const w = UI.world;
    const key = e.key.toLowerCase();
    if (key.startsWith("arrow")) { UI.keys[key] = true; e.preventDefault(); return; }
    if (UI.modalOpen()) {
      if (key === "escape" && !w.outcome) { closeModal(); UI.paused = false; }
      return;
    }
    if (key === "escape") {
      if (UI.aim) { UI.aim = null; view.classList.remove("aim"); UI.lastSpells = ""; }
      else if (UI.slot != null) closeBuild();
      else if (UI.sel.size) clearSel();
      else if (UI.selStruct) UI.selStruct = null;
      else openPause();
      UI.lastPanel = "";
      return;
    }
    if (key === " ") { e.preventDefault(); UI.paused = !UI.paused; $("#h-pause").textContent = UI.paused ? "▶" : "❚❚"; return; }
    if (key === "f") { cycleSpeed(); return; }
    if (key === "k") { toggleTech(); return; }
    if (key === "home") { goHome(); return; }
    if (key === "=" || key === "+") { zoomBtn(1.3); return; }
    if (key === "-") { zoomBtn(1 / 1.3); return; }
    if (key === "f3") { e.preventDefault(); UI.perf = !UI.perf; return; }
    if (key === "h") { openHelp(true); return; }
    if (key === "a" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      clearSel();
      for (const sq of w.squads) if (sq.owner === "p" && !sq.inside) { UI.sel.add(sq.id); sq.sel = true; }
      UI.selStruct = null;
      return;
    }
    if (["1", "2", "3"].includes(key)) {
      const k = CS.FACTIONS[w.owners.p.faction].spells[Number(key) - 1];
      if (k) setAim(k);
      return;
    }
    if (UI.sel.size) {
      if (key === "s") act("stop");
      if (key === "b") act("home");
      return;
    }
    let st = UI.selStruct;
    const want = CS.RECRUITABLE.find((t) => CS.UNITS[t].key.toLowerCase() === key);
    if (want && !(st && st.owner === "p" && !st.ruined)) {
      // 没选据点：自动挑一座能训练该兵种、队列最短的己方据点
      const cands = w.structs.filter((s2) => s2.owner === "p" && !s2.ruined && CS.STRUCTS[s2.type].recruit.includes(want)).sort((a, b) => a.queue.length - b.queue.length);
      if (cands.length) { st = UI.selStruct = cands[0]; UI.slot = null; }
    }
    if (st && st.owner === "p" && !st.ruined) {
      const type = want;
      if (type && CS.STRUCTS[st.type].recruit.includes(type)) act("recruit", type);
      if (key === "u") act("upgrade");
      if (key === "g" && st.garrison.length) act("release");
    }
  });

  document.addEventListener("keyup", (e) => { UI.keys[e.key.toLowerCase()] = false; });
  window.addEventListener("blur", () => { UI.keys = {}; });

  function cycleSpeed() {
    UI.speed = UI.speed === 1 ? 2 : UI.speed === 2 ? 3 : 1;
    $("#h-speed").textContent = "×" + UI.speed;
  }
  $("#h-speed").addEventListener("click", cycleSpeed);
  $("#h-pause").addEventListener("click", () => { UI.paused = !UI.paused; $("#h-pause").textContent = UI.paused ? "▶" : "❚❚"; });
  $("#h-menu").addEventListener("click", openPause);

  // ---------- 相机按钮与小地图 ----------
  function goHome() {
    const w = UI.world;
    if (!w) return;
    const st = w.structs.find((q) => q.owner === "p" && !q.ruined && q.type === "castle") || w.structs.find((q) => q.owner === "p" && !q.ruined);
    if (st) CS.render.center(st.x, st.y - 10);
  }
  function zoomBtn(f) {
    const r = view.getBoundingClientRect();
    CS.render.zoomAt(f, r.width / 2, r.height / 2);
  }
  $("#mm-in").addEventListener("click", () => zoomBtn(1.35));
  $("#mm-out").addEventListener("click", () => zoomBtn(1 / 1.35));
  $("#mm-fit").addEventListener("click", () => {
    // 已经是全图就回都城的常用视角，否则拉到全图
    if (CS.render.zoomCss() <= CS.render.fitCss() * 1.05) { CS.render.setZoom(1.5); goHome(); }
    else CS.render.setZoom(CS.render.fitCss());
  });
  const mm = $("#minimap");
  function mmPoint(e) {
    const r = mm.getBoundingClientRect();
    const w = UI.world;
    return { x: ((e.clientX - r.left) / r.width) * w.W, y: ((e.clientY - r.top) / r.height) * w.H };
  }
  mm.addEventListener("contextmenu", (e) => e.preventDefault());
  mm.addEventListener("pointerdown", (e) => {
    const w = UI.world;
    if (!w) return;
    e.stopPropagation();
    const p = mmPoint(e);
    if (e.button === 2) { if (UI.sel.size && !w.outcome) command(p); return; } // 右键点小地图：选中的部队走过去
    try { mm.setPointerCapture(e.pointerId); } catch (_) { /* 合成事件 */ }
    UI.mmDrag = true;
    CS.render.center(p.x, p.y);
  });
  mm.addEventListener("pointermove", (e) => { if (UI.mmDrag && UI.world) { const p = mmPoint(e); CS.render.center(p.x, p.y, true); } });
  mm.addEventListener("pointerup", () => { UI.mmDrag = false; });
  mm.addEventListener("pointercancel", () => { UI.mmDrag = false; });

  // ---------- 科技 ----------
  const techpop = $("#techpop");
  function renderTech() {
    const w = UI.world;
    if (!w || techpop.hidden) return;
    const P = w.owners.p;
    morph(techpop, "<h4>科技 <span style=\"font-size:12px;color:#c9b48c\">花金币立刻生效</span></h4>" + CS.TECHS.map((t) => {
      const lv = P.tech[t.id] || 0;
      const cost = lv < t.cost.length ? t.cost[lv] : null;
      return `<button data-t="${t.id}" data-k="${t.id}" ${cost == null || P.gold < cost ? "disabled" : ""}><b>${t.name} ${"●".repeat(lv)}${"○".repeat(t.cost.length - lv)}</b><span>${t.desc}</span><em>${cost == null ? "已满级" : cost + " 金"}</em></button>`;
    }).join(""));
  }
  function toggleTech() {
    if (!UI.world || UI.bench) return;
    techpop.hidden = !techpop.hidden;
    renderTech();
  }
  $("#h-tech").addEventListener("click", toggleTech);
  techpop.addEventListener("pointerdown", (e) => e.stopPropagation());
  techpop.addEventListener("click", (e) => {
    const b = e.target.closest("[data-t]");
    const w = UI.world;
    if (!b || !w || w.outcome) return;
    const why = CS.research(w, "p", b.dataset.t);
    if (why) { CS.audio.play("deny"); toast(why, "warn"); }
    renderTech();
    UI.lastPanel = "";
  });

  // ---------- 大陆征服 ----------
  const CQ = (UI.conq = { faction: "duchy", size: "m", foes: 3, biome: "temperate", diff: 1, fog: true, seed: 7 });
  function cqFoes(def, size) {
    const n = Math.max(1, Math.min(def.foes || size.foes, size.foes));
    const pool = CS.PLAYABLE.filter((f) => f !== def.faction);
    return Array.from({ length: n }, (_, i) => pool[(i + def.seed) % pool.length]);
  }
  // 和 createWorld 里一样的规则算出各家的归属色（预览用）
  function cqColors(player, foes) {
    const used = new Set();
    return [player].concat(foes).map((f) => {
      let ci = CS.FACTION_CI[f];
      if (used.has(ci)) { ci = 0; while (used.has(ci)) ci++; }
      used.add(ci);
      return CS.PALETTE[ci];
    });
  }
  function renderConquest() {
    const seg = (id, items, cur) => {
      $(id).innerHTML = items.map(([v, label, dot]) => `<button data-v="${v}" class="${String(v) === String(cur) ? "on" : ""}">${dot ? `<span class="dot" style="background:${dot}"></span>` : ""}${label}</button>`).join("");
    };
    const size = CS.MAP_SIZES.find((m) => m.id === CQ.size) || CS.MAP_SIZES[1];
    CQ.foes = Math.max(1, Math.min(CQ.foes, size.foes));
    seg("#cq-fac", CS.PLAYABLE.map((f) => [f, CS.FACTIONS[f].short, CS.FACTIONS[f].color]), CQ.faction);
    seg("#cq-size", CS.MAP_SIZES.map((m) => [m.id, m.name]), CQ.size);
    seg("#cq-foes", Array.from({ length: size.foes }, (_, i) => [i + 1, String(i + 1)]), CQ.foes);
    seg("#cq-biome", Object.keys(CS.BIOMES).map((b) => [b, CS.BIOMES[b].name]), CQ.biome);
    seg("#cq-diff", CS.CONQ_DIFF.map((d, i) => [i, d.name]), CQ.diff);
    $("#cq-fog").checked = CQ.fog;
    $("#cq-seed").value = CQ.seed;
    // 预览：真的把地图生成出来画成缩略图
    const foes = cqFoes(CQ, size);
    const layout = CS.genContinent({ cols: size.cols, rows: size.rows, seed: CQ.seed, foes, biome: CQ.biome });
    const map = CS.buildMap(CS.resolveLayout(layout));
    const cols = cqColors(CQ.faction, foes);
    const c = $("#cq-map");
    const g = c.getContext("2d");
    g.fillStyle = "#14100a";
    g.fillRect(0, 0, c.width, c.height);
    const k = Math.min((c.width - 40) / map.cols, (c.height - 40) / map.rows);
    const ox = (c.width - map.cols * k) / 2;
    const oy = (c.height - map.rows * k) / 2;
    g.imageSmoothingEnabled = false;
    g.drawImage(CS.render.mapThumb(map), ox, oy, map.cols * k, map.rows * k);
    g.strokeStyle = "rgba(240,200,140,0.5)";
    g.lineWidth = 1;
    g.setLineDash([3, 4]);
    for (const road of map.roads) {
      g.beginPath();
      road.forEach((p, i) => { const x = ox + (p.x / CS.TILE) * k; const y = oy + (p.y / CS.TILE) * k; if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.stroke();
    }
    g.setLineDash([]);
    for (const [type, cc, rr, own] of layout.s) {
      const x = ox + (cc + 0.5) * k;
      const y = oy + (rr + 0.5) * k;
      const idx = CS.OWNER_IDS.indexOf(own);
      const r = type === "castle" ? 8 : type === "village" ? 4.5 : 6;
      g.fillStyle = "#1a120c";
      g.beginPath(); g.arc(x, y, r + 2, 0, Math.PI * 2); g.fill();
      g.fillStyle = idx >= 0 ? cols[idx].color : own === "n" ? "#d6c7a5" : "#6b635a";
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      if (own === "p") { g.strokeStyle = "#fff6d8"; g.lineWidth = 2; g.beginPath(); g.arc(x, y, r + 5, 0, Math.PI * 2); g.stroke(); }
    }
    for (const [cc, rr] of layout.o) {
      g.fillStyle = "#e8b84a";
      g.fillRect(ox + (cc + 0.5) * k - 3, oy + (rr + 0.5) * k - 3, 6, 6);
    }
    const names = foes.map((f, i) => `<span style="color:${cols[i + 1].light}">${CS.FACTIONS[f].name}</span>`).join("、");
    $("#cq-info").innerHTML = `${map.cols}×${map.rows} 格 · ${layout.s.length} 座据点 · ${layout.o.length} 处野怪营地<br>对手：${names}<br>图例：<span style="color:#fff6d8">白圈</span> 你的都城 · <span style="color:#d6c7a5">浅色</span> 独立城邦 · <span style="color:#9a9288">灰色</span> 废墟 · <span style="color:#e8b84a">金块</span> 宝箱<br><span style="color:${CS.FACTIONS[CQ.faction].light}">${CS.FACTIONS[CQ.faction].name}</span>：${CS.FACTIONS[CQ.faction].motto}`;
  }
  $("#conquest").addEventListener("click", (e) => {
    const b = e.target.closest(".seg [data-v]");
    if (!b) return;
    const id = b.parentNode.id;
    const v = b.dataset.v;
    if (id === "cq-fac") CQ.faction = v;
    else if (id === "cq-size") { CQ.size = v; CQ.foes = CS.MAP_SIZES.find((m) => m.id === v).foes; }
    else if (id === "cq-foes") CQ.foes = Number(v);
    else if (id === "cq-biome") CQ.biome = v;
    else if (id === "cq-diff") CQ.diff = Number(v);
    CS.audio.play("click");
    renderConquest();
  });
  $("#cq-fog").addEventListener("change", (e) => { CQ.fog = e.target.checked; });
  $("#cq-seed").addEventListener("change", (e) => { CQ.seed = Math.max(1, Math.min(99999, Math.round(Number(e.target.value) || 1))); renderConquest(); });
  $("#cq-roll").addEventListener("click", () => { CQ.seed = 1 + Math.floor(Math.random() * 9999); renderConquest(); });
  $("#cq-go").addEventListener("click", () => startConquest(Object.assign({}, CQ)));

  function startConquest(def) {
    const size = CS.MAP_SIZES.find((m) => m.id === def.size) || CS.MAP_SIZES[1];
    const foes = cqFoes(def, size);
    const layout = CS.genContinent({ cols: size.cols, rows: size.rows, seed: def.seed, foes, biome: def.biome });
    const enemies = {};
    foes.forEach((f, i) => { enemies[CS.OWNER_IDS[i + 1]] = f; });
    const D = CS.CONQ_DIFF[def.diff] || CS.CONQ_DIFF[1];
    const world = CS.createWorld({ player: def.faction, layout, diff: D.diff, gold: D.gold, enemies, edicts: {}, seed: def.seed, noCap: true, fog: def.fog !== false });
    UI.missionDef = null;
    UI.bench = null;
    UI.conqDef = def;
    beginWorld(world, `大陆征服 · ${CS.BIOMES[def.biome].name} · ${foes.length} 家对手`);
    UI.tutorial = -1;
  }
  UI.startConquest = startConquest;
})(typeof window !== "undefined" ? window : globalThis);
