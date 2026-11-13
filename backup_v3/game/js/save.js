// 存档（localStorage；不可用时退回内存）
(function (root) {
  "use strict";
  const CS = root.CS;
  const KEY = "citystate.save.v2";
  const S = (CS.save = {});
  let data = null;

  function blank() {
    return { missions: {}, edicts: { duchy: {}, horde: {}, cult: {} }, spent: { duchy: 0, horde: 0, cult: 0 }, settings: { vol: 0.6, muted: false, unlockAll: false, perf: false, diff: 0 } };
  }
  S.load = function () {
    try {
      const raw = root.localStorage && root.localStorage.getItem(KEY);
      data = raw ? Object.assign(blank(), JSON.parse(raw)) : blank();
    } catch (e) { data = blank(); }
    for (const f of CS.CAMPAIGN_ORDER) { data.edicts[f] = data.edicts[f] || {}; data.spent[f] = data.spent[f] || 0; }
    return data;
  };
  S.write = function () {
    try { root.localStorage && root.localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* 内存模式 */ }
  };
  S.get = () => data || S.load();
  S.reset = function () { data = blank(); S.write(); };

  S.earned = function (faction) {
    let n = 0;
    CS.CAMPAIGNS[faction].forEach((_, i) => {
      const m = data.missions[CS.missionId(faction, i)];
      if (m) n += CS.RATING[m.rating].pts;
    });
    return n;
  };
  S.points = (faction) => S.earned(faction) - (data.spent[faction] || 0);
  S.unlocked = function (faction, idx) {
    if (data.settings.unlockAll) return true;
    const order = CS.CAMPAIGN_ORDER;
    const fi = order.indexOf(faction);
    if (idx === undefined) {
      if (fi === 0) return true;
      return !!data.missions[CS.missionId(order[fi - 1], CS.UNLOCK_AT - 1)];
    }
    if (!S.unlocked(faction)) return false;
    return idx === 0 || !!data.missions[CS.missionId(faction, idx - 1)];
  };
  S.record = function (faction, idx, rating, time) {
    const id = CS.missionId(faction, idx);
    const prev = data.missions[id];
    const before = S.points(faction);
    if (!prev || rating < prev.rating) data.missions[id] = { rating, time: Math.round(time) };
    else if (time < prev.time) prev.time = Math.round(time);
    S.write();
    return { gained: S.points(faction) - before, first: !prev };
  };
  S.buyEdict = function (faction, id) {
    const def = CS.EDICTS.find((e) => e.id === id);
    const rank = data.edicts[faction][id] || 0;
    if (rank >= def.max) return false;
    const cost = CS.EDICT_COST[rank];
    if (S.points(faction) < cost) return false;
    data.edicts[faction][id] = rank + 1;
    data.spent[faction] += cost;
    S.write();
    return true;
  };
  S.resetEdicts = function (faction) {
    data.edicts[faction] = {};
    data.spent[faction] = 0;
    S.write();
  };
})(typeof window !== "undefined" ? window : globalThis);
