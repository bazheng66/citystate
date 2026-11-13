// WebAudio 合成音效（无音频文件）
(function (root) {
  "use strict";
  const CS = root.CS;
  const A = (CS.audio = { vol: 0.6, muted: false });
  let ac = null;
  let master = null;
  let noiseBuf = null;
  const last = {};

  A.unlock = function () {
    if (ac) { if (ac.state === "suspended") ac.resume(); return; }
    const Ctx = root.AudioContext || root.webkitAudioContext;
    if (!Ctx) return;
    ac = new Ctx();
    master = ac.createGain();
    master.gain.value = A.muted ? 0 : A.vol;
    master.connect(ac.destination);
    noiseBuf = ac.createBuffer(1, ac.sampleRate * 0.5, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  };
  A.setVolume = function (v) { A.vol = v; if (master) master.gain.value = A.muted ? 0 : v; };
  A.setMuted = function (m) { A.muted = m; if (master) master.gain.value = m ? 0 : A.vol; };

  function gate(name, gap) {
    if (!ac) return false;
    const t = ac.currentTime;
    if (last[name] && t - last[name] < gap) return false;
    last[name] = t;
    return true;
  }

  function tone(freq, dur, type, gain, slide) {
    const t = ac.currentTime;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  function noise(dur, gain, freq, q, type) {
    const t = ac.currentTime;
    const s = ac.createBufferSource();
    s.buffer = noiseBuf;
    const f = ac.createBiquadFilter();
    f.type = type || "bandpass";
    f.frequency.value = freq;
    f.Q.value = q || 1;
    const g = ac.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f);
    f.connect(g);
    g.connect(master);
    s.start(t, Math.random() * 0.3);
    s.stop(t + dur + 0.02);
  }

  const SFX = {
    click: () => gate("click", 0.03) && tone(660, 0.06, "square", 0.04),
    deny: () => gate("deny", 0.15) && tone(180, 0.12, "square", 0.05, 120),
    hit: () => gate("hit", 0.07) && noise(0.06, 0.08, 2400 + Math.random() * 1500, 4),
    shoot: () => gate("shoot", 0.09) && noise(0.05, 0.05, 900, 2, "highpass"),
    stone: () => gate("stone", 0.2) && noise(0.25, 0.16, 180, 0.8, "lowpass"),
    bolt: () => gate("bolt", 0.12) && tone(880, 0.14, "sine", 0.04, 1320),
    die: () => gate("die", 0.12) && tone(220, 0.12, "triangle", 0.04, 110),
    ruin: () => { if (!gate("ruin", 0.3)) return; noise(0.9, 0.3, 120, 0.6, "lowpass"); tone(90, 0.7, "sawtooth", 0.06, 40); },
    capture: () => { if (!gate("cap", 0.3)) return; [523, 659, 784].forEach((f, i) => setTimeout(() => ac && tone(f, 0.18, "square", 0.05), i * 90)); },
    spawn: () => gate("spawn", 0.2) && tone(392, 0.1, "square", 0.035, 523),
    build: () => gate("build", 0.2) && noise(0.12, 0.08, 600, 2),
    cast: () => { if (!gate("cast", 0.2)) return; tone(330, 0.5, "sine", 0.06, 990); noise(0.4, 0.05, 3000, 1); },
    gold: () => { if (!gate("gold", 0.2)) return; [988, 1319].forEach((f, i) => setTimeout(() => ac && tone(f, 0.12, "square", 0.04), i * 70)); },
    win: () => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => ac && tone(f, 0.32, "square", 0.06), i * 150)),
    lose: () => [392, 330, 262, 196].forEach((f, i) => setTimeout(() => ac && tone(f, 0.4, "triangle", 0.07), i * 200)),
    alarm: () => gate("alarm", 3) && [880, 660, 880].forEach((f, i) => setTimeout(() => ac && tone(f, 0.12, "square", 0.05), i * 130)),
  };
  // ---- 背景音乐：多利亚调式的拨弦旋律 + 持续低音，程序生成 ----
  const SCALE = [0, 2, 3, 5, 7, 9, 10]; // D 多利亚
  const ROOT = 146.83; // D3
  let musicOn = false;
  let musicGain = null;
  let nextT = 0;
  let step = 0;
  let deg = 0;
  let timer = null;
  A.music = { enabled: true };
  function note(deg) {
    const oct = Math.floor(deg / 7);
    const i = ((deg % 7) + 7) % 7;
    return ROOT * Math.pow(2, oct + SCALE[i] / 12);
  }
  function pluck(t, f, dur, gain, type) {
    const o = ac.createOscillator();
    const g = ac.createGain();
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1800;
    o.type = type || "triangle";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp); lp.connect(g); g.connect(musicGain);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function schedule() {
    if (!ac || !musicOn) return;
    const beat = 60 / 84 / 2;
    while (nextT < ac.currentTime + 0.4) {
      const bar = Math.floor(step / 8) % 8;
      const chordRoot = [0, 0, 3, 4, 0, 5, 3, 4][bar];
      if (step % 8 === 0) {
        pluck(nextT, note(chordRoot - 7), beat * 8, 0.05, "sine");
        pluck(nextT, note(chordRoot - 3), beat * 8, 0.025, "sine");
      }
      // 旋律：围绕和弦音的随机游走，偶尔休止
      const r = Math.random();
      if (step % 2 === 0 || r < 0.35) {
        if (r < 0.15) { /* 休止 */ } else {
          deg += r < 0.5 ? 1 : r < 0.85 ? -1 : (Math.random() < 0.5 ? 2 : -2);
          if (deg > 9) deg -= 2;
          if (deg < -1) deg += 2;
          if (step % 8 === 0) deg = chordRoot + (Math.random() < 0.5 ? 0 : 2);
          pluck(nextT, note(deg), beat * 1.8, 0.045);
          if (step % 16 === 0) pluck(nextT, note(deg + 4), beat * 1.6, 0.02);
        }
      }
      if (step % 8 === 4) noise2(nextT, 0.08, 0.035);
      nextT += beat;
      step++;
    }
  }
  function noise2(t, dur, gain) {
    const s = ac.createBufferSource();
    s.buffer = noiseBuf;
    const f = ac.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 220;
    const g = ac.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(musicGain);
    s.start(t); s.stop(t + dur + 0.02);
  }
  A.musicPlay = function (on) {
    on = on && A.music.enabled;
    if (!ac) return;
    if (!musicGain) {
      musicGain = ac.createGain();
      musicGain.gain.value = 0.55;
      musicGain.connect(master);
    }
    if (on === musicOn) return;
    musicOn = on;
    if (on) {
      nextT = ac.currentTime + 0.1;
      timer = setInterval(schedule, 120);
    } else if (timer) { clearInterval(timer); timer = null; }
  };

  A.play = function (name) {
    if (!ac || A.muted) return;
    const f = SFX[name];
    if (f) f();
  };
})(typeof window !== "undefined" ? window : globalThis);
