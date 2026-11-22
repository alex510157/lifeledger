/* app/sync.js 單元測試：409 衝突、讀取檢查、卡片合併 */
(function(){
  const S = window.LLSync;
  const ledger = (extra) => Object.assign({version:1, budget:null,
    cards:[{id:"c1", bank:"玉山", name:"卡一"}], records:[{id:"r1", date:"2026-11-01", amount:100, cardId:"c1"}]}, extra||{});

  // 假的 API：依序回應，記錄每一次呼叫
  function fakeApi(responses){
    const calls = [];
    const api = async (method, body) => { calls.push({method, body:JSON.parse(JSON.stringify(body))});
      const r = responses.shift(); if(!r) throw new Error("unexpected extra API call #" + calls.length);
      return typeof r === "function" ? r(body) : r; };
    api.calls = calls; return api;
  }
  const addRec = id => d => { d.records.push({id, date:"2026-11-02", amount:50, cardId:"c1"}); };

  /* ---------- mutate：帳本 ---------- */
  test("mutate：200 成功時回傳新資料與版本，送出的 base 是目前版本", async () => {
    const api = fakeApi([{status:200, j:{rev:6}}]);
    const r = await S.mutate({api, data:ledger(), rev:5, fn:addRec("r2")});
    eq(api.calls.length, 1); eq(api.calls[0].body.base, 5);
    eq(r.rev, 6); eq(r.data.records.map(x=>x.id), ["r1","r2"]);
  });

  const badConflicts = {
    "沒有 data": {error:"conflict", rev:7},
    "data 是 null": {data:null, rev:7},
    "data 是空物件": {data:{}, rev:7},
    "data 是陣列": {data:[], rev:7},
    "records 不是陣列": {data:{records:null, cards:[]}, rev:7},
    "缺 cards": {data:{records:[]}, rev:7},
    "incomes 格式錯": {data:{records:[], cards:[], incomes:"x"}, rev:7},
    "沒有 rev": {data:ledger()},
    "rev 和送出的一樣": {data:ledger(), rev:5},
    "rev 是字串": {data:ledger(), rev:"7"},
    "rev 是負數": {data:ledger(), rev:-1},
    "rev 是小數": {data:ledger(), rev:7.5},
    "整個回應是空的": null,
  };
  Object.entries(badConflicts).forEach(([label, j]) => {
    test("mutate：409 回應不可信（" + label + "）→ 停下、只送出一次、不使用預設資料、目前資料不被改動", async () => {
      const local = ledger(); const before = JSON.stringify(local);
      const api = fakeApi([{status:409, j}]);
      await rejects(S.mutate({api, data:local, rev:5, fn:addRec("r2")}), e => eq(e.code, "conflict_unsafe"));
      eq(api.calls.length, 1, "只能送出一次");
      eq(JSON.stringify(local), before, "目前資料不能被改動");
      // 唯一一次送出的內容是「目前帳本＋這筆修改」，不是空帳本或預設帳本
      eq(api.calls[0].body.data.records.map(x=>x.id), ["r1","r2"]);
    });
  });

  test("mutate：409 帶有完整的最新資料 → 用最新資料重套修改，別台裝置的記錄不會被蓋掉", async () => {
    const remote = ledger(); remote.records.push({id:"rX", date:"2026-11-01", amount:9, cardId:"c1"});
    const api = fakeApi([{status:409, j:{data:remote, rev:8}}, {status:200, j:{rev:9}}]);
    const local = ledger(); const before = JSON.stringify(local);
    const r = await S.mutate({api, data:local, rev:5, fn:addRec("r2")});
    eq(api.calls.length, 2); eq(api.calls[1].body.base, 8);
    eq(api.calls[1].body.data.records.map(x=>x.id), ["r1","rX","r2"]);
    eq(r.rev, 9); eq(r.data.records.map(x=>x.id), ["r1","rX","r2"]);
    eq(JSON.stringify(local), before, "傳入的資料本身不被改動，結果只從回傳值拿");
  });

  /* ---------- 409 之後重試失敗：不能提前覆蓋本機資料 ---------- */
  // 模擬 index.html 的外層狀態：只有 mutate 成功時才更新 D、REV、快取
  async function outerSave(responses){
    const outer = {D:ledger(), REV:5}; outer.cache = JSON.stringify({rev:outer.REV, data:outer.D});
    const before = JSON.stringify(outer);
    const api = fakeApi(responses);
    let err = null;
    try{ const r = await S.mutate({api, data:outer.D, rev:outer.REV, fn:addRec("r2")}); outer.D = r.data; outer.REV = r.rev; outer.cache = JSON.stringify({rev:r.rev, data:r.data}); }
    catch(e){ err = e; }
    return {outer, before, api, err};
  }
  const remoteWithX = () => { const d = ledger(); d.records.push({id:"rX", date:"2026-11-01", amount:9, cardId:"c1"}); return d; };
  test("409 收到有效資料後，第二次 PUT 回 200 但缺 rev → 本機資料、版本號、快取都沒有被提前覆蓋", async () => {
    const {outer, before, api, err} = await outerSave([{status:409, j:{data:remoteWithX(), rev:8}}, {status:200, j:{}}]);
    eq(err && err.code, "bad_response"); eq(api.calls.length, 2);
    eq(JSON.stringify(outer), before, "D、REV、快取都要和存檔前一模一樣");
  });
  test("409 收到有效資料後，第二次 PUT 回 HTTP 500 → 本機資料、版本號、快取都沒有被提前覆蓋", async () => {
    const {outer, before, api, err} = await outerSave([{status:409, j:{data:remoteWithX(), rev:8}}, {status:500, j:{error:"server"}}]);
    eq(err && err.code, "save_failed"); eq(api.calls.length, 2);
    eq(JSON.stringify(outer), before);
  });
  test("409 收到有效資料後，第二次 PUT 回 200 但 rev 沒有比 base 新 → 不提前覆蓋", async () => {
    const {outer, before, err} = await outerSave([{status:409, j:{data:remoteWithX(), rev:8}}, {status:200, j:{rev:8}}]);
    eq(err && err.code, "bad_response"); eq(JSON.stringify(outer), before);
  });
  test("409 收到有效資料後，第二次 PUT 回 401 → 不提前覆蓋", async () => {
    const {outer, before, err} = await outerSave([{status:409, j:{data:remoteWithX(), rev:8}}, {status:401, j:{error:"bad"}}]);
    assert(err && err.auth === true); eq(JSON.stringify(outer), before);
  });
  test("409 收到有效資料後，連續 409 用完重試次數 → 不提前覆蓋", async () => {
    const {outer, before, err} = await outerSave([{status:409, j:{data:remoteWithX(), rev:8}}, {status:409, j:{data:remoteWithX(), rev:9}}, {status:409, j:{data:remoteWithX(), rev:10}}]);
    eq(err && err.code, "conflict_retry"); eq(JSON.stringify(outer), before);
  });
  test("409 收到有效資料後，第二次 PUT 時修改函式丟出錯誤 → 不提前覆蓋", async () => {
    const outer = {D:ledger(), REV:5}; const before = JSON.stringify(outer);
    let n = 0; const api = fakeApi([{status:409, j:{data:remoteWithX(), rev:8}}]);
    await rejects(S.mutate({api, data:outer.D, rev:outer.REV, fn:d=>{ if(++n === 2) throw new Error("conflict on retry"); d.records.push({id:"r2"}); }}), e => eq(e.message, "conflict on retry"));
    eq(JSON.stringify(outer), before);
  });
  test("mutate 不再接受 onAdopt：重試期間不會通知外層", async () => {
    let called = 0;
    const api = fakeApi([{status:409, j:{data:remoteWithX(), rev:8}}, {status:500, j:{}}]);
    await rejects(S.mutate({api, data:ledger(), rev:5, fn:addRec("r2"), onAdopt:()=>called++}));
    eq(called, 0, "不能在成功前通知外層更新資料");
  });

  /* ---------- 送出前檢查目前的 rev ---------- */
  const badLocalRevs = {"undefined": undefined, "null": null, "字串": "5", "負數": -1, "小數": 1.5, "NaN": NaN, "物件": {}};
  Object.entries(badLocalRevs).forEach(([label, rev]) => {
    test("mutate：目前的 rev 無效（" + label + "）→ 不送出 PUT、資料不被改動", async () => {
      const local = ledger(); const before = JSON.stringify(local);
      const api = fakeApi([]);
      await rejects(S.mutate({api, data:local, rev, fn:addRec("r2")}), e => eq(e.code, "bad_local_rev"));
      eq(api.calls.length, 0, "不能送出");
      eq(JSON.stringify(local), before);
    });
  });
  test("mutate：目前的 rev 是 0（新帳號）可以送出", async () => {
    const api = fakeApi([{status:200, j:{rev:1}}]);
    const r = await S.mutate({api, data:ledger(), rev:0, fn:addRec("r2")});
    eq(api.calls[0].body.base, 0); eq(r.rev, 1);
  });

  test("mutate：連續 409 三次 → conflict_retry，不會無限重送", async () => {
    const mk = rev => ({status:409, j:{data:ledger(), rev}});
    const api = fakeApi([mk(7), mk(8), mk(9)]);
    await rejects(S.mutate({api, data:ledger(), rev:5, fn:addRec("r2")}), e => eq(e.code, "conflict_retry"));
    eq(api.calls.length, 3);
  });

  test("mutate：第二次 409 才缺資料 → 停下，不會用空帳本送出", async () => {
    const api = fakeApi([{status:409, j:{data:ledger(), rev:7}}, {status:409, j:{error:"conflict"}}]);
    await rejects(S.mutate({api, data:ledger(), rev:5, fn:addRec("r2")}), e => eq(e.code, "conflict_unsafe"));
    eq(api.calls.length, 2);
    api.calls.forEach(c => assert(c.body.data.records.length === 2, "每次送出都必須是完整帳本"));
  });

  test("mutate：沒有讀到本機帳本（data 為 null）→ 不送出", async () => {
    const api = fakeApi([]);
    await rejects(S.mutate({api, data:null, rev:0, fn:addRec("r2")}), e => eq(e.code, "no_local_data"));
    eq(api.calls.length, 0);
  });

  test("mutate：修改函式丟出錯誤 → 不送出", async () => {
    const api = fakeApi([]);
    await rejects(S.mutate({api, data:ledger(), rev:5, fn:()=>{ throw new Error("boom"); }}), e => eq(e.message, "boom"));
    eq(api.calls.length, 0);
  });

  test("mutate：修改後帳本格式壞掉 → 不送出", async () => {
    const api = fakeApi([]);
    await rejects(S.mutate({api, data:ledger(), rev:5, fn:d=>{ d.records = null; }}), e => eq(e.code, "bad_draft"));
    eq(api.calls.length, 0);
  });

  test("mutate：401 → auth 錯誤；500 → 一般錯誤，都只送出一次", async () => {
    const a1 = fakeApi([{status:401, j:{error:"bad"}}]);
    await rejects(S.mutate({api:a1, data:ledger(), rev:5, fn:addRec("r2")}), e => assert(e.auth === true));
    const a2 = fakeApi([{status:500, j:{error:"server"}}]);
    await rejects(S.mutate({api:a2, data:ledger(), rev:5, fn:addRec("r2")}), e => eq(e.code, "save_failed"));
    eq(a1.calls.length + a2.calls.length, 2);
  });

  /* ---------- mutate：HTTP 200 必須帶有效 rev ---------- */
  const bad200 = {
    "沒有 rev": {},
    "rev 是 null": {rev:null},
    "rev 是物件": {rev:{v:6}},
    "rev 是陣列": {rev:[6]},
    "rev 是布林值": {rev:true},
    "rev 是空字串": {rev:""},
    "rev 是 NaN": {rev:NaN},
    "rev 是 Infinity": {rev:Infinity},
    "rev 是字串數字": {rev:"6"},
    "rev 是負數": {rev:-1},
    "rev 是小數": {rev:6.5},
    "rev 等於送出的 base": {rev:5},
    "rev 比送出的 base 舊": {rev:4},
    "整個回應是 null": null,
  };
  Object.entries(bad200).forEach(([label, j]) => {
    test("mutate：200 但 rev 無效（" + label + "）→ 不宣告成功、不回傳新版本、目前資料不被改動", async () => {
      const local = ledger(); const before = JSON.stringify(local);
      const api = fakeApi([{status:200, j}]);
      await rejects(S.mutate({api, data:local, rev:5, fn:addRec("r2")}), e => { eq(e.code, "bad_response"); assert(/無法確認/.test(e.message), "訊息要說明無法確認有沒有存到"); });
      eq(api.calls.length, 1, "不能重送");
      eq(JSON.stringify(local), before, "目前資料不能被改動");
    });
  });
  test("mutate：200 的 rev 是比 base 大的整數 → 接受（後端回 base + 1）", async () => {
    const api = fakeApi([{status:200, j:{rev:6}}]);
    const r = await S.mutate({api, data:ledger(), rev:5, fn:addRec("r2")});
    eq(r.rev, 6);
  });
  test("mutate：409 後重送拿到 200 但缺 rev → 不宣告成功", async () => {
    const api = fakeApi([{status:409, j:{data:ledger(), rev:7}}, {status:200, j:{}}]);
    await rejects(S.mutate({api, data:ledger(), rev:5, fn:addRec("r2")}), e => eq(e.code, "bad_response"));
    eq(api.calls.length, 2);
  });

  /* ---------- checkPull ---------- */
  test("checkPull：完整帳本通過", () => { const p = S.checkPull({data:ledger(), rev:3}); eq(p.rev, 3); eq(p.empty, false); });
  test("checkPull：data 為 null，只有 allowEmpty（全新帳號）才接受", () => {
    eq(S.checkPull({data:null, rev:0}, {allowEmpty:true}).empty, true);
    let e = null; try{ S.checkPull({data:null, rev:4}); }catch(x){ e = x; } assert(e && e.code === "bad_response");
  });
  const badRevs = {"沒有 rev": undefined, "null": null, "物件": {}, "陣列": [], "布林值": false, "空字串": "", "NaN": NaN, "字串數字": "3", "負數": -1, "小數": 1.5, "超過安全整數": 2 ** 60};
  Object.entries(badRevs).forEach(([label, rev]) => {
    test("checkPull：rev 無效（" + label + "）→ 拒絕，包括全新帳號的空資料", () => {
      [{data:ledger(), rev, opt:{}}, {data:ledger(), rev, opt:{allowEmpty:true}}, {data:null, rev, opt:{allowEmpty:true}}].forEach(c => {
        const j = {data:c.data}; if(rev !== undefined) j.rev = rev;
        let e = null; try{ S.checkPull(j, c.opt); }catch(x){ e = x; }
        assert(e && e.code === "bad_response", "應拒絕 data=" + (c.data ? "帳本" : "null") + " allowEmpty=" + !!c.opt.allowEmpty);
      });
    });
  });
  test("checkPull：全新帳號 rev = 0、空資料 → 接受（後端 GET 的預設值）", () => {
    eq(S.checkPull({data:null, rev:0}, {allowEmpty:true}).rev, 0);
  });
  test("isRev：符合後端合約（≥ 0 的安全整數）", () => {
    [0, 1, 42, Number.MAX_SAFE_INTEGER].forEach(v => assert(S.isRev(v), "應接受 " + v));
    [-1, 1.5, "1", "", null, undefined, NaN, Infinity, {}, [], true, 2 ** 60].forEach(v => assert(!S.isRev(v), "應拒絕 " + String(v)));
  });
  // 後端只有「還沒有帳本」時才回 data:null，那時 rev 一定是 0
  [1, 5, 100].forEach(rev => {
    test("checkPull：allowEmpty 但 data:null、rev = " + rev + "（非 0）→ 拒絕，不能當成全新帳號", () => {
      let e = null; try{ S.checkPull({data:null, rev}, {allowEmpty:true}); }catch(x){ e = x; }
      assert(e && e.code === "bad_response", "rev 非 0 的空資料必須拒絕");
    });
  });
  test("checkPull：allowEmpty 不是 true（例如字串 \"yes\"、1）時，data:null、rev = 0 也拒絕", () => {
    ["yes", 1, {}].forEach(v => {
      let e = null; try{ S.checkPull({data:null, rev:0}, {allowEmpty:v}); }catch(x){ e = x; }
      assert(e && e.code === "bad_response", "allowEmpty 必須是 true，實際：" + JSON.stringify(v));
    });
  });
  test("checkPull：allowEmpty 為 true、data:null、rev = 0 → 接受（正常新帳號）", () => {
    const p = S.checkPull({data:null, rev:0}, {allowEmpty:true});
    eq(p.empty, true); eq(p.rev, 0); eq(p.data, null);
  });
  test("checkPull：格式錯的帳本、缺 rev、空回應都拒絕", () => {
    [{data:{}, rev:1}, {data:{records:[], cards:{}}, rev:1}, {data:ledger()}, null, "x"].forEach(j => {
      let e = null; try{ S.checkPull(j, {allowEmpty:true}); }catch(x){ e = x; }
      assert(e && e.code === "bad_response", "應拒絕 " + JSON.stringify(j));
    });
  });

  /* ---------- mergeCards ---------- */
  const card = (id, name, extra) => Object.assign({id, bank:"玉山", name, cap:null, cycleDay:null, cats:[], note:"", rBase:null, rBonus:null, rCap:null}, extra||{});
  const A = card("A","卡A"), B = card("B","卡B"), C = card("C","卡C");
  const names = r => r.cards.map(c=>c.id+":"+c.name);

  test("mergeCards：這台沒改、別台新增一張 → 保留別台新增的卡", () => {
    const r = S.mergeCards({baseRaw:[A,B], baseForm:[A,B], local:[A,B], remote:[A,B,C]});
    assert(r.ok); eq(names(r), ["A:卡A","B:卡B","C:卡C"]); eq(r.changedIds, []);
  });
  test("mergeCards：這台改 A、別台改 B → 兩邊的修改都留下", () => {
    const r = S.mergeCards({baseRaw:[A,B], baseForm:[A,B], local:[card("A","卡A改"),B], remote:[A,card("B","卡B改")]});
    assert(r.ok); eq(names(r), ["A:卡A改","B:卡B改"]); eq(r.changedIds, ["A"]);
  });
  test("mergeCards：兩邊都改 A → 衝突，不合併", () => {
    const r = S.mergeCards({baseRaw:[A], baseForm:[A], local:[card("A","這台")], remote:[card("A","別台")]});
    assert(!r.ok); eq(r.conflicts, ["A"]);
  });
  test("mergeCards：這台刪 B、別台沒動 B → 刪除", () => {
    const r = S.mergeCards({baseRaw:[A,B], baseForm:[A,B], local:[A], remote:[A,B]});
    assert(r.ok); eq(names(r), ["A:卡A"]);
  });
  test("mergeCards：這台刪 B、別台改了 B → 衝突", () => {
    const r = S.mergeCards({baseRaw:[A,B], baseForm:[A,B], local:[A], remote:[A,card("B","別台改")]});
    assert(!r.ok); eq(r.conflicts, ["B"]);
  });
  test("mergeCards：別台刪 B、這台沒動 B → 跟著刪", () => {
    const r = S.mergeCards({baseRaw:[A,B], baseForm:[A,B], local:[A,B], remote:[A]});
    assert(r.ok); eq(names(r), ["A:卡A"]);
  });
  test("mergeCards：別台刪 B、這台改了 B → 衝突", () => {
    const r = S.mergeCards({baseRaw:[A,B], baseForm:[A,B], local:[A,card("B","這台改")], remote:[A]});
    assert(!r.ok); eq(r.conflicts, ["B"]);
  });
  test("mergeCards：這台新增的卡保留在編輯畫面上的位置", () => {
    const r = S.mergeCards({baseRaw:[A,B], baseForm:[A,B], local:[C,A,B], remote:[A,B]});
    assert(r.ok); eq(names(r), ["C:卡C","A:卡A","B:卡B"]); eq(r.changedIds, ["C"]);
  });
  test("mergeCards：這台沒改的卡保留雲端版本（含編輯畫面沒有的欄位）", () => {
    const raw = Object.assign({}, A, {extraField:"keep"});
    const r = S.mergeCards({baseRaw:[raw], baseForm:[A], local:[A], remote:[raw]});
    assert(r.ok); eq(r.cards[0].extraField, "keep");
  });
  test("mergeCards：只有別台調整順序 → 用別台順序，這台新增的卡放在原本前一張卡後面", () => {
    const r = S.mergeCards({baseRaw:[A,B], baseForm:[A,B], local:[A,C,B], remote:[B,A]});
    assert(r.ok); eq(names(r), ["B:卡B","A:卡A","C:卡C"]);
  });
  test("mergeCards：只有這台調整順序 → 用這台順序，別台新增的卡放在它原本前一張卡後面", () => {
    const D2 = card("D","卡D");
    const r = S.mergeCards({baseRaw:[A,B], baseForm:[A,B], local:[B,A], remote:[A,D2,B]});
    assert(r.ok); eq(names(r), ["B:卡B","A:卡A","D:卡D"]);
  });
  test("mergeCards：兩邊都調整了不同的順序 → 衝突", () => {
    const r = S.mergeCards({baseRaw:[A,B,C], baseForm:[A,B,C], local:[C,A,B], remote:[B,C,A]});
    assert(!r.ok);
  });
  test("mergeCards：額度池的主卡被別台刪掉 → 額度池變回一般卡", () => {
    const P = card("P","卡A – 蝦皮", {parentId:"A"});
    const r = S.mergeCards({baseRaw:[A,P], baseForm:[A,P], local:[A,card("P","卡A – 蝦皮改",{parentId:"A"})], remote:[P]});
    assert(r.ok); eq(r.cards.length, 1); eq(r.cards[0].parentId, undefined);
  });

  test("卡片儲存流程：409 帶最新資料 → 合併後重送，別台新增的卡沒有被蓋掉", async () => {
    const baseL = ledger({cards:[A,B]});
    const remote = ledger({cards:[A,B,C]});
    const local = [card("A","卡A改"), B];
    const fn = d => { const m = S.mergeCards({baseRaw:baseL.cards, baseForm:baseL.cards, local, remote:d.cards}); if(!m.ok) throw S.SyncError("cards_conflict"); d.cards = m.cards; };
    const api = fakeApi([{status:409, j:{data:remote, rev:8}}, {status:200, j:{rev:9}}]);
    const r = await S.mutate({api, data:baseL, rev:5, fn});
    eq(api.calls.length, 2); eq(r.data.cards.map(c=>c.id+":"+c.name), ["A:卡A改","B:卡B","C:卡C"]);
  });
  test("卡片儲存流程：409 缺資料 → 不送出空卡片清單、停下", async () => {
    const baseL = ledger({cards:[A,B]});
    const fn = d => { const m = S.mergeCards({baseRaw:baseL.cards, baseForm:baseL.cards, local:[A,B], remote:d.cards}); d.cards = m.cards; };
    const api = fakeApi([{status:409, j:{error:"conflict"}}]);
    await rejects(S.mutate({api, data:baseL, rev:5, fn}), e => eq(e.code, "conflict_unsafe"));
    eq(api.calls.length, 1); eq(api.calls[0].body.data.cards.length, 2);
  });
  test("卡片儲存流程：409 後兩邊改到同一張卡 → 停下、不再送出", async () => {
    const baseL = ledger({cards:[A,B]});
    const remote = ledger({cards:[card("A","別台改"),B]});
    const fn = d => { const m = S.mergeCards({baseRaw:baseL.cards, baseForm:baseL.cards, local:[card("A","這台改"),B], remote:d.cards}); if(!m.ok) throw S.SyncError("cards_conflict"); d.cards = m.cards; };
    // 第一次送出時雲端還是舊的（合併成功），伺服器回 409 + 別台的新版；重套時發現衝突
    const api = fakeApi([{status:409, j:{data:remote, rev:8}}]);
    await rejects(S.mutate({api, data:baseL, rev:5, fn}), e => eq(e.code, "cards_conflict"));
    eq(api.calls.length, 1);
  });

  /* ---------- 登入資料：記住這台裝置（credLoad／credSave／cacheStore／credDropPw／credClear） ---------- */
  function mem(init){ const m = new Map(Object.entries(init||{}));
    return {getItem:k => m.has(k) ? m.get(k) : null, setItem:(k,v) => { m.set(k, String(v)); }, removeItem:k => { m.delete(k); }, obj:() => Object.fromEntries(m)}; }
  const broken = {getItem(){ throw new Error("blocked"); }, setItem(){ throw new Error("blocked"); }, removeItem(){ throw new Error("blocked"); }};

  test("登入資料：勾「記住」→ 密碼存在 localStorage，sessionStorage 沒有密碼", () => {
    const ls = mem(), ss = mem();
    assert(S.credSave(ls, ss, "u1", "pw1", true));
    eq(ls.obj(), {"cf-user":"u1", "cf-remember":"1", "cf-pw":"pw1"});
    eq(ss.obj(), {});
  });
  test("登入資料：不勾「記住」→ 密碼只存在 sessionStorage，localStorage 只留帳號名稱和選擇", () => {
    const ls = mem(), ss = mem();
    assert(S.credSave(ls, ss, "u1", "pw1", false));
    eq(ls.obj(), {"cf-user":"u1", "cf-remember":"0"});
    eq(ss.obj(), {"cf-pw":"pw1"});
  });
  test("登入資料：從「記住」改成「不記住」→ localStorage 的密碼和帳本快取都刪掉", () => {
    const ls = mem({"cf-user":"u1", "cf-pw":"old", "cf-sync-cache":"{}", "cf-theme":"x"}), ss = mem();
    S.credSave(ls, ss, "u1", "pw1", false);
    eq(ls.obj(), {"cf-user":"u1", "cf-theme":"x", "cf-remember":"0"}, "其他設定不動");
    eq(ss.obj(), {"cf-pw":"pw1"});
  });
  test("登入資料：從「不記住」改成「記住」→ sessionStorage 的密碼和帳本快取都刪掉", () => {
    const ls = mem({"cf-remember":"0"}), ss = mem({"cf-pw":"old", "cf-sync-cache":"{}"});
    S.credSave(ls, ss, "u1", "pw1", true);
    eq(ss.obj(), {});
    eq(ls.obj()["cf-pw"], "pw1"); eq(ls.obj()["cf-remember"], "1");
  });
  test("登入資料：沒指定 remember（undefined）時當作「記住」（和改版前相同）", () => {
    const ls = mem(), ss = mem();
    S.credSave(ls, ss, "u1", "pw1");
    eq(ls.obj()["cf-pw"], "pw1"); eq(ss.obj(), {});
  });
  test("登入資料：credLoad 讀取順序與預設值", () => {
    eq(S.credLoad(mem({"cf-user":"u", "cf-pw":"a"}), mem({"cf-pw":"b"})), {user:"u", pw:"a", lk:null, remember:true}, "localStorage 有密碼＝記住，優先");
    eq(S.credLoad(mem({"cf-user":"u"}), mem({"cf-pw":"b"})), {user:"u", pw:"b", lk:null, remember:false}, "只有 sessionStorage 有＝不記住");
    eq(S.credLoad(mem({"cf-user":"u"}), mem()), {user:"u", pw:null, lk:null, remember:true}, "都沒有＝預設記住");
    eq(S.credLoad(mem({"cf-user":"u", "cf-remember":"0"}), mem()), {user:"u", pw:null, lk:null, remember:false}, "都沒有＝照上次的選擇");
    eq(S.credLoad(mem({"cf-remember":"1"}), mem()), {user:null, pw:null, lk:null, remember:true});
  });
  test("登入資料：cacheStore 帳本快取跟著密碼放同一邊", () => {
    const ls = mem(), ss = mem();
    assert(S.cacheStore(ls, ss, true) === ls); assert(S.cacheStore(ls, ss, false) === ss); assert(S.cacheStore(ls, ss, undefined) === ls);
  });
  test("登入資料：密碼不對（credDropPw）→ 兩邊的密碼刪掉，帳本快取和帳號名稱保留", () => {
    const ls = mem({"cf-user":"u", "cf-pw":"a", "cf-sync-cache":"L"}), ss = mem({"cf-pw":"b", "cf-sync-cache":"S"});
    S.credDropPw(ls, ss);
    eq(ls.obj(), {"cf-user":"u", "cf-sync-cache":"L"}); eq(ss.obj(), {"cf-sync-cache":"S"});
  });
  test("登入資料：登出這台裝置（credClear）→ 兩邊的密碼和帳本快取都刪掉，帳號名稱保留", () => {
    const ls = mem({"cf-user":"u", "cf-pw":"a", "cf-sync-cache":"L", "cf-remember":"0"}), ss = mem({"cf-pw":"b", "cf-sync-cache":"S"});
    S.credClear(ls, ss);
    eq(ls.obj(), {"cf-user":"u", "cf-remember":"0"}); eq(ss.obj(), {});
  });
  test("登入資料：storage 無法使用（私密模式丟錯、或是 null）→ 不會丟錯，讀到的是空的", () => {
    eq(S.credLoad(broken, broken), {user:null, pw:null, lk:null, remember:true});
    eq(S.credLoad(null, null), {user:null, pw:null, lk:null, remember:true});
    eq(S.credSave(broken, broken, "u", "p", true), false, "存不進去要回傳 false");
    eq(S.credSave(null, null, "u", "p", false), false);
    S.credDropPw(broken, null); S.credClear(null, broken);
    const ls = mem();
    eq(S.credSave(ls, broken, "u", "p", false), false, "sessionStorage 不能用時不能偷偷改存到 localStorage");
    eq(ls.obj()["cf-pw"], undefined);
  });
  /* ---------- 登入金鑰的儲存（cf-lk） ---------- */
  test("登入金鑰：credSaveLk 存在密碼那一邊；credLoad 只在同一個帳號時讀出（大小寫、前後空白不影響）", () => {
    const ls = mem({"cf-user":" Alex "}), ss = mem();
    S.credSave(ls, ss, " Alex ", "pw1", true);
    eq(S.credSaveLk(ls, ss, " Alex ", "LK1", true), true);
    eq(S.credLoad(ls, ss).lk, "LK1");
    ls.setItem("cf-user", "bob");
    eq(S.credLoad(ls, ss).lk, null, "換了帳號就不用舊的登入金鑰");
    const ls2 = mem(), ss2 = mem();
    S.credSave(ls2, ss2, "u", "pw", false); S.credSaveLk(ls2, ss2, "u", "LK2", false);
    eq(ls2.obj()["cf-lk"], undefined, "不記住：localStorage 不留登入金鑰");
    eq(S.credLoad(ls2, ss2).lk, "LK2");
  });
  test("登入金鑰：credSave（換密碼）、credDropPw、credClear 都會刪掉兩邊的登入金鑰", () => {
    const mk = () => [mem({"cf-user":"u", "cf-pw":"a", "cf-lk":JSON.stringify({u:"u", lk:"X"})}), mem({"cf-pw":"b", "cf-lk":JSON.stringify({u:"u", lk:"Y"})})];
    let [ls, ss] = mk(); S.credSave(ls, ss, "u", "new", true); eq([ls.obj()["cf-lk"], ss.obj()["cf-lk"]], [undefined, undefined], "credSave");
    [ls, ss] = mk(); S.credDropPw(ls, ss); eq([ls.obj()["cf-lk"], ss.obj()["cf-lk"]], [undefined, undefined], "credDropPw");
    [ls, ss] = mk(); S.credClear(ls, ss); eq([ls.obj()["cf-lk"], ss.obj()["cf-lk"]], [undefined, undefined], "credClear");
    eq(S.credLoad(mem({"cf-user":"u", "cf-pw":"a", "cf-lk":"不是 JSON"}), mem()).lk, null, "格式不對就當作沒有");
  });

  /* ---------- 加密 ---------- */
  test("加密：登入金鑰 = PBKDF2-SHA256(密碼, \"login:\"+帳號小寫, 600000)（固定的測試向量，電腦端要算出一樣的值）", async () => {
    eq(await S.loginKey("Test-User", "correct horse"), "VCNxNmNqtlwQLOc/gNLpFlrQx9oitlCqHfXaYeD+4KI=");
    eq(await S.loginKey("  test-user ", "correct horse"), "VCNxNmNqtlwQLOc/gNLpFlrQx9oitlCqHfXaYeD+4KI=", "帳號大小寫、前後空白不影響");
    assert(await S.loginKey("other", "correct horse") !== "VCNxNmNqtlwQLOc/gNLpFlrQx9oitlCqHfXaYeD+4KI=", "不同帳號不同");
  });
  test("加密：資料金鑰用密碼包好再解開 → 一樣；密碼、帳號、用途不對都解不開", async () => {
    const dek = S.newDek(), w = await S.wrapDek(dek, "pw-1", "Alex", "pw");
    eq([w.v, w.iter, typeof w.salt, typeof w.iv, typeof w.ct], [1, 600000, "string", "string", "string"]);
    eq(S.b64e(await S.unwrapDek(w, "pw-1", "alex", "pw")), S.b64e(dek));
    for(const [pw, user, kind, why] of [["pw-2", "alex", "pw", "密碼不對"], ["pw-1", "bob", "pw", "別人的帳號"], ["pw-1", "alex", "rec", "用途不對"]])
      await rejects(S.unwrapDek(w, pw, user, kind), e => eq(e.code, "key_mismatch", why));
  });
  test("加密：救援碼包的資料金鑰，輸入時大小寫和 - 不影響", async () => {
    const dek = S.newDek(), w = await S.wrapDek(dek, "ABCD-EFGH-2345", "u", "rec");
    eq(S.b64e(await S.unwrapDek(w, "abcdefgh2345", "u", "rec")), S.b64e(dek));
  });
  test("加密：伺服器傳來的包裝格式不對（iter 太大或太小、版本不對）→ 不計算、直接拒絕", async () => {
    const w = await S.wrapDek(S.newDek(), "pw", "u", "pw");
    for(const bad of [{iter:1e9}, {iter:1000}, {iter:"600000"}, {v:2}])
      await rejects(S.unwrapDek(Object.assign({}, w, bad), "pw", "u", "pw"), e => eq(e.code, "bad_key", JSON.stringify(bad)));
    await rejects(S.unwrapDek(null, "pw", "u", "pw"), e => eq(e.code, "bad_key"));
  });
  test("加密：帳本加密再解開 → 內容一樣；別人的帳號、被改過的密文、別把金鑰都解不開", async () => {
    const dek = S.newDek(), d = ledger({note:"中文 ✓"}), enc = await S.encLedger(dek, d, "Alex");
    eq(Object.keys(enc).sort(), ["ct", "iv", "v"]); assert(!/中文|"records"/.test(JSON.stringify(enc)), "密文裡看不到內容");
    eq(await S.decLedger(dek, enc, "alex"), d);
    await rejects(S.decLedger(dek, enc, "bob"), e => eq(e.code, "decrypt_failed", "別人的帳號"));
    const ct = S.b64d(enc.ct); ct[0] ^= 1;
    await rejects(S.decLedger(dek, Object.assign({}, enc, {ct:S.b64e(ct)}), "alex"), e => eq(e.code, "decrypt_failed", "被改過"));
    await rejects(S.decLedger(S.newDek(), enc, "alex"), e => eq(e.code, "decrypt_failed", "別把金鑰"));
    await rejects(S.decLedger(dek, {v:2, iv:enc.iv, ct:enc.ct}, "alex"), e => eq(e.code, "decrypt_failed", "不認得的版本"));
  });
  test("加密：格式不完整的帳本不加密；解開後格式不對也不採用", async () => {
    const dek = S.newDek();
    await rejects(S.encLedger(dek, {records:[]}, "u"), e => eq(e.code, "bad_draft"));
    // 用同樣的參數手動加密一份不是帳本的 JSON
    const iv = crypto.getRandomValues(new Uint8Array(12)), k = await crypto.subtle.importKey("raw", dek, {name:"AES-GCM"}, false, ["encrypt"]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM", iv, additionalData:new TextEncoder().encode("cf-ledger:v1:u")}, k, new TextEncoder().encode('{"records":"x"}')));
    await rejects(S.decLedger(dek, {v:1, iv:S.b64e(iv), ct:S.b64e(ct)}, "u"), e => eq(e.code, "bad_response"));
  });

  /* ---------- 帶登入資料的請求 ---------- */
  function fakeFetch(handler){
    const calls = [];
    const f = async (url, o) => { const h = o.headers || {}; const c = {url, method:o.method || "GET", key:decodeURIComponent(h["x-cf-key"] || ""), kind:h["x-cf-kind"] || null, body:o.body ? JSON.parse(o.body) : null};
      calls.push(c); const r = handler(c, calls.length); return new Response(JSON.stringify(r.body || {}), {status:r.status}); };
    return {f, calls};
  }
  test("請求：新版伺服器、帳號有登入金鑰 → 只送登入金鑰（x-cf-kind: lk），不送密碼", async () => {
    const {f, calls} = fakeFetch(() => ({status:200, body:{ok:1}}));
    const c = {user:"u", pw:"PW", lk:"LK", v2:true};
    const r = await S.authFetch(f, "https://x", "/api/ledger", {cache:"no-store"}, c);
    eq(r.status, 200); eq(calls.map(x => [x.key, x.kind]), [["LK", "lk"]]); eq(c.lkOk, true);
  });
  test("請求：舊帳號（no_login_key）→ 改用密碼，成功後自動補上登入金鑰，之後只送登入金鑰", async () => {
    let hasLk = false;
    const {f, calls} = fakeFetch(x => {
      if(/setlogin/.test(x.url)){ hasLk = true; return {status:200, body:{ok:true}}; }
      if(x.kind === "lk") return hasLk ? {status:200} : {status:401, body:{code:"no_login_key"}};
      return x.key === "PW" ? {status:200} : {status:401};
    });
    const c = {user:"u", pw:"PW", lk:"LK", v2:true};
    eq((await S.authFetch(f, "https://x", "/api/ledger", {}, c)).status, 200);
    eq(calls.map(x => [x.key, x.kind, /setlogin/.test(x.url)]), [["LK", "lk", false], ["PW", null, false], ["PW", null, true]]);
    eq(calls[2].body, {loginKey:"LK"}, "setlogin 只補登入金鑰（不停用密碼，電腦端還在用）");
    eq([c.legacy, c.lkOk], [false, true]);
    eq((await S.authFetch(f, "https://x", "/api/ledger", {}, c)).status, 200);
    eq(calls.slice(3).map(x => [x.key, x.kind]), [["LK", "lk"]], "之後只送登入金鑰");
  });
  test("請求：登入金鑰錯了（401、沒有 no_login_key）→ 不改送密碼（不會多算一次錯誤）", async () => {
    const {f, calls} = fakeFetch(() => ({status:401, body:{error:"帳號或密碼不對"}}));
    const r = await S.authFetch(f, "https://x", "/api/ledger", {}, {user:"u", pw:"PW", lk:"LK", v2:true});
    eq(r.status, 401); eq(calls.length, 1);
  });
  test("請求：舊版伺服器（v2 = false）→ 照舊只送密碼，不帶 x-cf-kind", async () => {
    const {f, calls} = fakeFetch(() => ({status:200}));
    await S.authFetch(f, "https://x", "/api/ledger", {}, {user:"u", pw:"PW", lk:"LK", v2:false});
    eq(calls.map(x => [x.key, x.kind]), [["PW", null]]);
  });
  test("請求：probeV2 → 新版 true、舊版 false、連不上 null", async () => {
    eq(await S.probeV2(fakeFetch(() => ({status:200, body:{pubkey:null, kid:null}})).f, "https://x"), true);
    eq(await S.probeV2(fakeFetch(() => ({status:401, body:{error:"請先登入"}})).f, "https://x"), false);
    eq(await S.probeV2(fakeFetch(() => ({status:200, body:{rev:0, data:null}})).f, "https://x"), false);
    eq(await S.probeV2(async () => { throw new TypeError("offline"); }, "https://x"), null);
  });
  /* ---------- 管理者救援（wrap_admin） ---------- */
  test("管理者救援：wrapAdmin 用 RSA-OAEP（SHA-256）包資料金鑰，私鑰解得開；kid = sha256(公鑰 base64) 前 16 碼", async () => {
    const kp = await crypto.subtle.generateKey({name:"RSA-OAEP", modulusLength:2048, publicExponent:new Uint8Array([1, 0, 1]), hash:"SHA-256"}, true, ["encrypt", "decrypt"]);
    const pub = S.b64e(new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey)));
    const dek = S.newDek(), w = await S.wrapAdmin(dek, pub);
    eq([w.v, w.alg, /^[0-9a-f]{16}$/.test(w.kid)], [1, "RSA-OAEP-256", true]);
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pub)));
    eq(w.kid, Array.from(h.slice(0, 8), b => b.toString(16).padStart(2, "0")).join(""));
    eq(S.b64e(new Uint8Array(await crypto.subtle.decrypt({name:"RSA-OAEP"}, kp.privateKey, S.b64d(w.ct)))), S.b64e(dek));
  });
  test("管理者救援：kid 和伺服器、電腦端用同一套算法（固定的測試向量）", async () => {
    eq(await S.pubKid("MIIBIjAN"), "b5e6e01248876daf", "和 Python hashlib.sha256(b\"MIIBIjAN\").hexdigest()[:16] 相同");
  });
  /* ---------- 月報、生活帳本頁的帳本讀寫（pageLedger） ---------- */
  async function encFixture(user, pw){
    const dek = S.newDek();
    return {dek, wrap_pw:await S.wrapDek(dek, pw, user, "pw"), enc:await S.encLedger(dek, ledger(), user)};
  }
  test("月報頁讀寫：明文帳本、有存登入金鑰 → 只送登入金鑰，GET 回明文、PUT 照舊送 data", async () => {
    const ls = mem({"cf-user":"u", "cf-pw":"PW", "cf-lk":JSON.stringify({u:"u", lk:"LK"})});
    const {f, calls} = fakeFetch(c => c.method === "GET" ? {status:200, body:{rev:3, data:ledger()}} : {status:200, body:{rev:4}});
    const api = S.pageLedger(f, "https://x", ls, mem());
    const g = await api("GET"); eq([g.status, g.j.rev, g.j.data.records.length], [200, 3, 1]);
    const p = await api("PUT", {base:3, data:ledger({note:"x"})}); eq(p.j.rev, 4);
    eq(calls.map(c => [c.method, c.key, c.kind]), [["GET", "LK", "lk"], ["PUT", "LK", "lk"]]);
    eq(Object.keys(calls[1].body).sort(), ["base", "data"]);
  });
  test("月報頁讀寫：沒有登入金鑰（舊版網站登入的）→ 照舊送密碼", async () => {
    const {f, calls} = fakeFetch(() => ({status:200, body:{rev:1, data:ledger()}}));
    await S.pageLedger(f, "https://x", mem({"cf-user":"u"}), mem({"cf-pw":"SPW"}))("GET");
    eq(calls.map(c => [c.key, c.kind]), [["SPW", null]], "密碼只在 sessionStorage 也讀得到");
  });
  test("月報頁讀寫：加密帳本 → GET 在頁面裡解開；PUT 只送密文，解開是修改後的帳本", async () => {
    const fx = await encFixture("u", "PW");
    let saved = null;
    const {f, calls} = fakeFetch(c => /action=keys/.test(c.url) ? {status:200, body:{wrap_pw:fx.wrap_pw}}
      : c.method === "GET" ? {status:200, body:{rev:7, enc:fx.enc}} : (saved = c.body, {status:200, body:{rev:8}}));
    const api = S.pageLedger(f, "https://x", mem({"cf-user":"u", "cf-pw":"PW", "cf-lk":JSON.stringify({u:"u", lk:"LK"})}), mem());
    const g = await api("GET"); eq(g.j.data, ledger());
    const d = g.j.data; d.paidMarks = [{k:"h1", r:1, t:"2026-11-22"}];
    eq((await api("PUT", {base:7, data:d})).status, 200);
    eq(Object.keys(saved).sort(), ["base", "enc"], "只送密文");
    eq((await S.decLedger(fx.dek, saved.enc, "u")).paidMarks, [{k:"h1", r:1, t:"2026-11-22"}]);
    assert(calls.every(c => c.kind === "lk"), "全部用登入金鑰");
  });
  test("月報頁讀寫：加密帳本 409（附最新密文）→ 解開成 data，頁面可以照舊重試", async () => {
    const fx = await encFixture("u", "PW"), newer = await S.encLedger(fx.dek, ledger({note:"別台"}), "u");
    const {f} = fakeFetch(c => /action=keys/.test(c.url) ? {status:200, body:{wrap_pw:fx.wrap_pw}}
      : c.method === "GET" ? {status:200, body:{rev:7, enc:fx.enc}} : {status:409, body:{error:"conflict", rev:8, enc:newer}});
    const api = S.pageLedger(f, "https://x", mem({"cf-user":"u", "cf-pw":"PW"}), mem());
    await api("GET");
    const p = await api("PUT", {base:7, data:ledger()});
    eq([p.status, p.j.rev, p.j.data.note], [409, 8, "別台"]);
  });
  test("月報頁讀寫：資料金鑰解不開這本帳 → GET 丟錯；之後的 PUT 不送出（不會用錯的金鑰蓋掉帳本）", async () => {
    const fx = await encFixture("u", "PW"), wrongWrap = await S.wrapDek(S.newDek(), "PW", "u", "pw");
    const {f, calls} = fakeFetch(c => /action=keys/.test(c.url) ? {status:200, body:{wrap_pw:wrongWrap}} : {status:200, body:{rev:7, enc:fx.enc}});
    const api = S.pageLedger(f, "https://x", mem({"cf-user":"u", "cf-pw":"PW"}), mem());
    await rejects(api("GET"), e => eq(e.code, "decrypt_failed"));
    await rejects(api("PUT", {base:7, data:ledger()}), e => eq(e.code, "key_unverified"));
    eq(calls.filter(c => c.method === "PUT").length, 0, "沒有送出任何寫入");
  });
})();
