/* 端到端測試：把真正的 app/index.html、app/view.html 放進 iframe 執行，只把對雲端 API 的 fetch 換成假的伺服器。
 * 帳號密碼都是測試用的假值，不會連到正式 API。 */
(function(){
  const API = "https://alexledger.netlify.app";
  const APP = new URL("../app/", location.href).href;
  const TEST_USER = "e2e-test-user", TEST_PW = "e2e-fake-password";   // 假帳密，只存在測試瀏覽器的 localStorage
  let SERVER = null;   // 目前情境的假伺服器

  // 假伺服器：handler({method, path, query, body}) → {status, body}
  window.__mockFetch = async (url, opts, real) => {
    if(!url.startsWith(API)) return real(url, opts);
    const u = new URL(url), method = (opts.method || "GET").toUpperCase();
    const req = {method, path:u.pathname, query:Object.fromEntries(u.searchParams), body:opts.body ? JSON.parse(opts.body) : null};
    SERVER.calls.push(req);
    const r = SERVER.handler(req) || {status:404, body:{error:"not mocked"}};
    return new Response(JSON.stringify(r.body), {status:r.status, headers:{"content-type":"application/json"}});
  };
  function server(handler){ SERVER = {handler, calls:[]}; return SERVER; }
  const puts = () => SERVER.calls.filter(c => c.method === "PUT" && c.path === "/api/ledger");
  // 共用的路由：帳號資訊、卡片資料庫
  const common = req => {
    if(req.path === "/api/ledger" && req.query.action === "account") return {status:200, body:{hasRecovery:true}};
    if(req.path === "/api/catalog") return {status:404, body:{}};
    return null;
  };

  function resetStorage(extra){
    Object.keys(localStorage).filter(k => /^(cf-|ll-)/.test(k)).forEach(k => localStorage.removeItem(k));
    localStorage.setItem("cf-user", TEST_USER); localStorage.setItem("cf-pw", TEST_PW); localStorage.setItem("cf-page", "rec");
    Object.entries(extra || {}).forEach(([k, v]) => localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v)));
  }
  const cache = () => JSON.parse(localStorage.getItem("cf-sync-cache") || "null");

  let frame = null;
  async function boot(page){
    if(frame) frame.remove();
    const html = await (await fetch(APP + page, {cache:"no-store"})).text();
    const inject = '<base href="' + APP + '"><script>(function(){var real=window.fetch.bind(window);window.fetch=function(u,o){return parent.__mockFetch(String(u),o||{},real)};})()<\/script>';
    frame = document.createElement("iframe"); frame.style.cssText = "width:420px;height:700px;border:1px solid #ccc";
    document.getElementById("stage").appendChild(frame);
    const loaded = new Promise(r => frame.addEventListener("load", r, {once:true}));
    frame.srcdoc = html.replace(/<head([^>]*)>/i, "<head$1>" + inject);
    await loaded;
    return frame.contentWindow;
  }
  const $ = (w, id) => w.document.getElementById(id);
  const ready = w => waitFor(() => /已同步/.test($(w, "saveInfo").textContent), 6000, "app 同步完成");

  const card = (id, name) => ({id, bank:"玉山", name, cap:null, cycleDay:null, cats:[], note:""});
  const ledger = (o) => Object.assign({version:1, budget:null, cards:[card("c1","卡一")], records:[{id:"r1", date:"2026-11-01", amount:100, cardId:"c1", cardName:"卡一", bank:"玉山", category:"餐飲", note:"", ts:1}]}, o || {});
  const getLedger = (rev, data) => req => common(req) || (req.method === "GET" && req.path === "/api/ledger" && !req.query.page ? {status:200, body:{rev, data}} : null);

  async function addExpense(w, amt){ $(w, "amount").value = String(amt); $(w, "saveBtn").click(); }

  /* ---------- 帳本：index.html ---------- */
  test("E2E 帳本：409 沒有附資料 → 只送出一次、沒有用預設帳本、目前資料保留、顯示錯誤", async () => {
    resetStorage();
    const base = getLedger(5, ledger());
    server(req => base(req) || (req.method === "PUT" ? {status:409, body:{error:"conflict"}} : null));
    const w = await boot("index.html"); await ready(w);
    await addExpense(w, 120);
    await waitFor(() => !$(w, "banner").hidden, 4000, "錯誤提示");
    await sleep(300);
    eq(puts().length, 1, "只能送出一次");
    eq(puts()[0].body.base, 5);
    eq(puts()[0].body.data.records.length, 2, "送出的是完整帳本＋新的一筆");
    eq(puts()[0].body.data.cards.map(c => c.name), ["卡一"], "沒有換成預設卡片");
    eq(cache().data.records.map(r => r.id), ["r1"], "本機資料沒有被改動");
    // 錯誤提示要一直留著（不會因為背景同步而消失）；下方同步狀態列可能被背景同步改成「已同步」，所以不以它判斷
    assert(/沒有存到/.test($(w, "banner").textContent), "錯誤訊息要說明沒有存到");
    assert(!$(w, "banner").hidden, "錯誤提示要留著");
  });

  test("E2E 帳本：409 附完整最新資料 → 重送一次，別台裝置的記錄保留", async () => {
    resetStorage();
    const base = getLedger(5, ledger());
    const remote = ledger(); remote.records.push({id:"rX", date:"2026-11-01", amount:9, cardId:"c1", cardName:"卡一", bank:"玉山", category:"餐飲", note:"別台", ts:2});
    let n = 0;
    server(req => base(req) || (req.method === "PUT" ? (++n === 1 ? {status:409, body:{rev:7, data:remote}} : {status:200, body:{rev:8}}) : null));
    const w = await boot("index.html"); await ready(w);
    await addExpense(w, 120);
    await waitFor(() => cache() && cache().rev === 8, 4000, "存檔完成");
    eq(puts().length, 2); eq(puts()[1].body.base, 7);
    eq(puts()[1].body.data.records.map(r => r.id).slice(0, 2), ["r1", "rX"]);
    eq(puts()[1].body.data.records.length, 3);
    assert($(w, "banner").hidden, "成功時不顯示錯誤");
  });

  test("E2E 讀取：本機已有帳本、雲端卻回傳空資料 → 不建立初始帳本、不送出", async () => {
    resetStorage({"cf-sync-cache": {rev:5, data:ledger()}});
    server(getLedger(6, null));
    const w = await boot("index.html");
    await waitFor(() => /無法連線雲端/.test($(w, "saveInfo").textContent), 6000, "讀取失敗訊息");
    await sleep(300);
    eq(puts().length, 0, "不能送出");
    eq(cache().data.records.map(r => r.id), ["r1"], "本機資料保留");
  });

  test("E2E 讀取：全新帳號（沒有本機資料、雲端是空的）→ 照舊建立初始帳本", async () => {
    resetStorage();
    server(req => getLedger(0, null)(req) || (req.method === "PUT" ? {status:200, body:{rev:1}} : null));
    const w = await boot("index.html"); await ready(w);
    eq(puts().length, 1);
    eq(puts()[0].body.data.cards.map(c => c.name), ["現金／其他"]);
  });

  test("E2E 帳本：一開始讀不到雲端、本機也沒資料 → 不允許存檔", async () => {
    resetStorage();
    server(req => common(req) || (req.method === "GET" && req.path === "/api/ledger" ? {status:500, body:{error:"down"}} : null));
    const w = await boot("index.html");
    await waitFor(() => /無法連線雲端/.test($(w, "saveInfo").textContent), 6000, "讀取失敗訊息");
    // 空白暫存帳本沒有卡片，記帳表單會先擋下；改用「儲存總預算」走同一條存檔流程
    $(w, "budgetAll").value = "1000"; $(w, "budgetSave").click();
    await waitFor(() => !$(w, "banner").hidden, 4000, "錯誤提示");
    assert(/還沒讀到完整的帳本/.test($(w, "banner").textContent));
    eq(puts().length, 0, "不能用空白暫存資料覆蓋雲端");
  });

  /* ---------- 卡片設定：index.html ---------- */
  async function openCards(w){
    w.document.querySelector('#bnav button[data-pg="cards"]').click();
    await waitFor(() => w.document.querySelector('#cardEdit details[data-id="c1"]'), 3000, "卡片編輯");
  }
  function renameCard(w, id, name){ w.document.querySelector('#cardEdit details[data-id="' + id + '"] .f-name').value = name; }
  const twoCards = () => ledger({cards:[card("c1","卡一"), card("c2","卡二")]});

  test("E2E 卡片：409 附最新資料（別台改了卡二、新增卡三）→ 合併後重送，兩邊的修改都在", async () => {
    resetStorage();
    const base = getLedger(5, twoCards());
    const remote = ledger({cards:[card("c1","卡一"), card("c2","卡二（別台改）"), card("c3","卡三（別台新增）")]});
    let n = 0;
    server(req => base(req) || (req.method === "PUT" ? (++n === 1 ? {status:409, body:{rev:7, data:remote}} : {status:200, body:{rev:8}}) : null));
    const w = await boot("index.html"); await ready(w); await openCards(w);
    renameCard(w, "c1", "卡一改"); $(w, "cardsSave").click();
    await waitFor(() => cache() && cache().rev === 8, 4000, "存檔完成");
    eq(puts().length, 2);
    const sent = puts()[1].body.data;
    eq(sent.cards.map(c => c.id + ":" + c.name), ["c1:卡一改", "c2:卡二（別台改）", "c3:卡三（別台新增）"]);
    eq(sent.records[0].cardName, "卡一改", "記錄上的卡名跟著更新");
  });

  test("E2E 卡片：409 後發現兩邊改了同一張卡 → 不重送、資料保留、畫面上的修改還在、顯示錯誤", async () => {
    resetStorage();
    const base = getLedger(5, twoCards());
    const remote = ledger({cards:[card("c1","卡一（別台改）"), card("c2","卡二")]});
    server(req => base(req) || (req.method === "PUT" ? {status:409, body:{rev:7, data:remote}} : null));
    const w = await boot("index.html"); await ready(w); await openCards(w);
    renameCard(w, "c1", "卡一改"); $(w, "cardsSave").click();
    await waitFor(() => !$(w, "banner").hidden, 4000, "錯誤提示");
    await sleep(300);
    eq(puts().length, 1, "衝突後不能再送出");
    assert(/別台裝置也改了/.test($(w, "banner").textContent));
    eq(cache().data.cards.map(c => c.name), ["卡一", "卡二"], "本機快取沒有被這次失敗的修改改動");
    eq(w.document.querySelector('#cardEdit details[data-id="c1"] .f-name').value, "卡一改", "畫面上的修改還在");
  });

  test("E2E 卡片：409 沒有附資料 → 只送出一次、不送空清單、顯示錯誤", async () => {
    resetStorage();
    const base = getLedger(5, twoCards());
    server(req => base(req) || (req.method === "PUT" ? {status:409, body:{}} : null));
    const w = await boot("index.html"); await ready(w); await openCards(w);
    renameCard(w, "c2", "卡二改"); $(w, "cardsSave").click();
    await waitFor(() => !$(w, "banner").hidden, 4000, "錯誤提示");
    await sleep(300);
    eq(puts().length, 1);
    eq(puts()[0].body.data.cards.length, 2);
    eq(cache().data.cards.map(c => c.name), ["卡一", "卡二"]);
  });

  test("E2E 卡片：一般儲存（沒有衝突）照舊成功", async () => {
    resetStorage();
    const base = getLedger(5, twoCards());
    server(req => base(req) || (req.method === "PUT" ? {status:200, body:{rev:6}} : null));
    const w = await boot("index.html"); await ready(w); await openCards(w);
    renameCard(w, "c2", "卡二改"); $(w, "cardsSave").click();
    await waitFor(() => cache() && cache().rev === 6, 4000, "存檔完成");
    eq(puts().length, 1);
    eq(puts()[0].body.data.cards.map(c => c.name), ["卡一", "卡二改"]);
  });

  /* ---------- 月報的「⟳ 更新」：view.html ---------- */
  const b64 = u8 => btoa(String.fromCharCode(...new Uint8Array(u8)));
  async function encBlob(pw, html){
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
    const k = await crypto.subtle.deriveKey({name:"PBKDF2", salt, iterations:1000, hash:"SHA-256"}, km, {name:"AES-GCM", length:256}, false, ["encrypt"]);
    const ct = await crypto.subtle.encrypt({name:"AES-GCM", iv}, k, new TextEncoder().encode(html));
    return {salt:b64(salt), iv:b64(iv), ct:b64(ct), iter:1000, gz:false};
  }
  async function bootReport(ledgerRes, putRes){
    resetStorage();
    const blob = await encBlob(TEST_PW, "<!doctype html><html><head><title>t</title></head><body><p id='rpt'>測試月報</p></body></html>");
    server(req => {
      if(req.path === "/api/ledger" && req.query.page === "report") return {status:200, body:{blob, savedAt:"2026-11-21T00:00:00Z"}};
      if(req.path === "/api/ledger" && req.method === "GET") return ledgerRes();
      if(req.path === "/api/ledger" && req.method === "PUT") return putRes(req);
      return null;
    });
    const w = await boot("view.html");
    await waitFor(() => w.document.querySelector("#ll-sw .rf"), 6000, "月報切換列");
    await sleep(100);
    return w;
  }
  const rf = w => w.document.querySelector("#ll-sw .rf");
  const msg = w => (w.document.getElementById("ll-msg") || {}).textContent || "";

  test("E2E 月報更新鍵：讀不到完整帳本 → 不送出、說明沒有送出", async () => {
    const w = await bootReport(() => ({status:200, body:{rev:3}}), () => ({status:200, body:{rev:4}}));
    rf(w).click();
    await waitFor(() => /沒送出/.test(msg(w)), 4000, "錯誤訊息");
    eq(puts().length, 0, "不能用空資料覆蓋帳本");
    assert(!rf(w).classList.contains("busy"));
  });

  test("E2E 月報更新鍵：連續 409 → 最多送三次，不會誤報「已請電腦更新」", async () => {
    const w = await bootReport(() => ({status:200, body:{rev:3, data:ledger()}}), () => ({status:409, body:{error:"conflict"}}));
    rf(w).click();
    await waitFor(() => /沒送出/.test(msg(w)), 4000, "錯誤訊息");
    eq(puts().length, 3);
    assert(!rf(w).classList.contains("busy"), "不能顯示成更新中");
  });

  test("E2E 月報更新鍵：正常送出 → 帳本完整、只多 refreshReq", async () => {
    const w = await bootReport(() => ({status:200, body:{rev:3, data:ledger()}}), () => ({status:200, body:{rev:4}}));
    rf(w).click();
    await waitFor(() => rf(w).classList.contains("busy"), 4000, "更新中");
    eq(puts().length, 1);
    const d = puts()[0].body.data;
    eq(d.records.map(r => r.id), ["r1"]); assert(d.refreshReq > 0); eq(puts()[0].body.base, 3);
  });

  window.__e2eCleanup = () => { if(frame) frame.remove(); Object.keys(localStorage).filter(k => /^(cf-|ll-)/.test(k)).forEach(k => localStorage.removeItem(k)); };
})();
