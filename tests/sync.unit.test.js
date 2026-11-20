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
    "整個回應是空的": null,
  };
  Object.entries(badConflicts).forEach(([label, j]) => {
    test("mutate：409 回應不可信（" + label + "）→ 停下、只送出一次、不使用預設資料、目前資料不被改動", async () => {
      const local = ledger(); const before = JSON.stringify(local);
      const api = fakeApi([{status:409, j}]);
      let adopted = 0;
      await rejects(S.mutate({api, data:local, rev:5, fn:addRec("r2"), onAdopt:()=>adopted++}), e => eq(e.code, "conflict_unsafe"));
      eq(api.calls.length, 1, "只能送出一次");
      eq(adopted, 0, "不能採用不可信的資料");
      eq(JSON.stringify(local), before, "目前資料不能被改動");
      // 唯一一次送出的內容是「目前帳本＋這筆修改」，不是空帳本或預設帳本
      eq(api.calls[0].body.data.records.map(x=>x.id), ["r1","r2"]);
    });
  });

  test("mutate：409 帶有完整的最新資料 → 用最新資料重套修改，別台裝置的記錄不會被蓋掉", async () => {
    const remote = ledger(); remote.records.push({id:"rX", date:"2026-11-01", amount:9, cardId:"c1"});
    const api = fakeApi([{status:409, j:{data:remote, rev:8}}, {status:200, j:{rev:9}}]);
    let adopted = null;
    const r = await S.mutate({api, data:ledger(), rev:5, fn:addRec("r2"), onAdopt:c=>adopted=c});
    eq(api.calls.length, 2); eq(api.calls[1].body.base, 8);
    eq(api.calls[1].body.data.records.map(x=>x.id), ["r1","rX","r2"]);
    eq(adopted.rev, 8); eq(r.rev, 9);
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

  /* ---------- checkPull ---------- */
  test("checkPull：完整帳本通過", () => { const p = S.checkPull({data:ledger(), rev:3}); eq(p.rev, 3); eq(p.empty, false); });
  test("checkPull：data 為 null，只有 allowEmpty（全新帳號）才接受", () => {
    eq(S.checkPull({data:null, rev:0}, {allowEmpty:true}).empty, true);
    let e = null; try{ S.checkPull({data:null, rev:4}); }catch(x){ e = x; } assert(e && e.code === "bad_response");
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
})();
