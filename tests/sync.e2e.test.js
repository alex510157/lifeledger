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
    const hk = (opts.headers || {})["x-cf-key"];
    const req = {method, path:u.pathname, query:Object.fromEntries(u.searchParams), body:opts.body ? JSON.parse(opts.body) : null, key:hk == null ? null : decodeURIComponent(hk), kind:(opts.headers || {})["x-cf-kind"] || null};
    SERVER.calls.push(req);
    const r = SERVER.handler(req) || {status:404, body:{error:"not mocked"}};
    return new Response(JSON.stringify(r.body), {status:r.status, headers:{"content-type":"application/json"}});
  };
  function server(handler){ SERVER = {handler, calls:[]}; return SERVER; }
  // 帳本的寫入（不含 ?page=、?action= 的請求，例如「立即更新」狀態、資料金鑰）
  const puts = () => SERVER.calls.filter(c => c.method === "PUT" && c.path === "/api/ledger" && !c.query.page && !c.query.action);
  // 共用的路由：帳號資訊、卡片資料庫
  const common = req => {
    if(req.path === "/api/ledger" && req.query.action === "account") return {status:200, body:{hasRecovery:true}};
    if(req.path === "/api/catalog") return {status:404, body:{}};
    return null;
  };

  function resetStorage(extra){
    Object.keys(localStorage).filter(k => /^(cf-|ll-)/.test(k)).forEach(k => localStorage.removeItem(k));
    Object.keys(sessionStorage).filter(k => /^cf-/.test(k)).forEach(k => sessionStorage.removeItem(k));
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
  // 記錄日期放在「本月 1 號」（台北時間），app 開啟時顯示本月，明細列表才看得到這些記錄
  const DAY1 = new Date().toLocaleDateString("sv-SE", {timeZone:"Asia/Taipei"}).slice(0, 7) + "-01";
  const ledger = (o) => Object.assign({version:1, budget:null, cards:[card("c1","卡一")], records:[{id:"r1", date:DAY1, amount:100, cardId:"c1", cardName:"卡一", bank:"玉山", category:"餐飲", note:"", ts:1}]}, o || {});
  // 重新畫面（切到下個月再切回來），回傳明細列表的筆數：用來確認 app 記憶體中的帳本 D 沒有被換掉
  const shownItems = w => { $(w, "nextM").click(); $(w, "prevM").click(); return w.document.querySelectorAll("#ledger .item").length; };
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
    eq(puts()[0].body.base, 0, "初始帳本以 rev 0 為 base 送出");
    eq(cache().rev, 1, "成功後本機快取更新為伺服器回傳的 rev");
  });

  [1, 5].forEach(rev => {
    test("E2E 讀取：沒有本機快取、GET 回 data:null 但 rev = " + rev + " → 不建立初始帳本、不送出 PUT", async () => {
      resetStorage();
      server(req => getLedger(rev, null)(req) || (req.method === "PUT" ? {status:200, body:{rev:rev + 1}} : null));
      const w = await boot("index.html");
      await waitFor(() => /無法連線雲端/.test($(w, "saveInfo").textContent), 6000, "讀取失敗訊息");
      await sleep(300);
      eq(puts().length, 0, "不能送出初始帳本");
      assert(!/已同步/.test($(w, "saveInfo").textContent), "不能顯示已同步");
      eq(cache(), null, "不能把預設帳本寫進本機快取");
      // 使用者想存檔也會被擋下（還沒讀到完整帳本）
      $(w, "budgetAll").value = "1000"; $(w, "budgetSave").click();
      await waitFor(() => !$(w, "banner").hidden, 4000, "錯誤提示");
      eq(puts().length, 0, "存檔也不能送出");
    });
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

  /* ---------- 版本號（rev）驗證：index.html ---------- */
  test("E2E 帳本：PUT 回 200 但缺 rev → 不宣告成功、本機資料和版本號不變、顯示無法確認", async () => {
    resetStorage();
    const base = getLedger(5, ledger());
    server(req => base(req) || (req.method === "PUT" ? {status:200, body:{ok:true}} : null));
    const w = await boot("index.html"); await ready(w);
    await addExpense(w, 120);
    await waitFor(() => !$(w, "banner").hidden, 4000, "錯誤提示");
    await sleep(300);
    eq(puts().length, 1, "不能重送");
    assert(/無法確認/.test($(w, "banner").textContent), "提示要說明無法確認有沒有存到");
    assert(!/已記下/.test($(w, "toast").textContent), "不能顯示「已記下」");
    eq(cache().rev, 5, "本機版本號不變");
    eq(cache().data.records.map(r => r.id), ["r1"], "本機資料不變");
  });

  test("E2E 帳本：PUT 回 200 但 rev 是 null → 不宣告成功", async () => {
    resetStorage();
    const base = getLedger(5, ledger());
    server(req => base(req) || (req.method === "PUT" ? {status:200, body:{rev:null}} : null));
    const w = await boot("index.html"); await ready(w);
    await addExpense(w, 80);
    await waitFor(() => !$(w, "banner").hidden, 4000, "錯誤提示");
    eq(puts().length, 1); eq(cache().rev, 5); eq(cache().data.records.length, 1);
  });

  test("E2E 讀取：全新帳號但 GET 缺 rev → 不建立初始帳本、不送出", async () => {
    resetStorage();
    server(req => common(req) || (req.method === "GET" && req.path === "/api/ledger" && !req.query.page ? {status:200, body:{data:null}} : null));
    const w = await boot("index.html");
    await waitFor(() => /無法連線雲端/.test($(w, "saveInfo").textContent), 6000, "讀取失敗訊息");
    await sleep(300);
    eq(puts().length, 0, "不能送出");
    assert(!/已同步/.test($(w, "saveInfo").textContent), "不能顯示已同步");
  });

  test("E2E 讀取：本機有帳本、GET 的 rev 是物件 → 不採用、本機資料和版本號保留", async () => {
    const remote = ledger(); remote.records = [];
    resetStorage({"cf-sync-cache": {rev:5, data:ledger()}});
    server(getLedger({v:6}, remote));
    const w = await boot("index.html");
    await waitFor(() => /無法連線雲端/.test($(w, "saveInfo").textContent), 6000, "讀取失敗訊息");
    await sleep(300);
    eq(puts().length, 0);
    eq(cache().rev, 5); eq(cache().data.records.map(r => r.id), ["r1"]);
  });

  /* ---------- 409 之後重試失敗：本機資料不能被提前覆蓋 ---------- */
  function remoteWithX(){ const d = ledger(); d.records.push({id:"rX", date:DAY1, amount:9, cardId:"c1", cardName:"卡一", bank:"玉山", category:"餐飲", note:"別台", ts:2}); return d; }
  async function conflictThen(second){
    resetStorage();
    const base = getLedger(5, ledger());
    let n = 0;
    server(req => base(req) || (req.method === "PUT" ? (++n === 1 ? {status:409, body:{error:"conflict", rev:8, data:remoteWithX()}} : second) : null));
    const w = await boot("index.html"); await ready(w);
    await addExpense(w, 120);
    await waitFor(() => !$(w, "banner").hidden, 4000, "錯誤提示");
    await sleep(300);
    return w;
  }
  test("E2E 帳本：409 收到有效資料後，第二次 PUT 回 200 但缺 rev → 本機資料、版本號、快取都沒有被提前覆蓋，輸入的金額還在", async () => {
    const w = await conflictThen({status:200, body:{}});
    eq(puts().length, 2);
    eq(cache().rev, 5, "快取的版本號沒變");
    eq(cache().data.records.map(r => r.id), ["r1"], "快取沒有被換成雲端資料");
    eq($(w, "amount").value, "120", "還沒存成功的修改還在表單上");
    assert(/無法確認/.test($(w, "banner").textContent));
    eq(shownItems(w), 1, "app 記憶體中的帳本仍是原本的 1 筆，沒有被換成雲端的 2 筆");
  });
  test("E2E 帳本：409 收到有效資料後，第二次 PUT 回 HTTP 500 → 本機資料、版本號、快取都沒有被提前覆蓋，輸入的金額還在", async () => {
    const w = await conflictThen({status:500, body:{error:"server error"}});
    eq(puts().length, 2);
    eq(cache().rev, 5); eq(cache().data.records.map(r => r.id), ["r1"]);
    eq($(w, "amount").value, "120");
    eq(shownItems(w), 1, "app 記憶體中的帳本仍是原本的 1 筆");
  });
  test("E2E 帳本：上面的失敗之後再存一次 → 用雲端最新資料重套，成功後才更新快取", async () => {
    resetStorage();
    const base = getLedger(5, ledger());
    let n = 0;
    server(req => base(req) || (req.method === "PUT" ? (++n === 1 ? {status:409, body:{rev:8, data:remoteWithX()}} : n === 2 ? {status:500, body:{}} : n === 3 ? {status:409, body:{rev:8, data:remoteWithX()}} : {status:200, body:{rev:9}}) : null));
    const w = await boot("index.html"); await ready(w);
    await addExpense(w, 120);
    await waitFor(() => !$(w, "banner").hidden, 4000, "第一次失敗");
    eq(cache().rev, 5);
    $(w, "saveBtn").click();   // 金額還在表單上，直接再按一次
    await waitFor(() => cache() && cache().rev === 9, 4000, "第二次成功");
    eq(cache().data.records.map(r => r.id).slice(0, 2), ["r1", "rX"]); eq(cache().data.records.length, 3);
    assert($(w, "banner").hidden, "成功後錯誤提示消失");
  });

  /* ---------- 本機快取的 rev 不符合 API 合約 ---------- */
  const downServer = () => server(req => common(req) || (req.method === "GET" && req.path === "/api/ledger" ? {status:500, body:{error:"down"}} : null));
  [["缺少 rev", {}], ["rev 是 null", {rev:null}], ["rev 是字串", {rev:"5"}], ["rev 是負數", {rev:-1}], ["rev 是小數", {rev:5.5}]].forEach(([label, extra]) => {
    test("E2E 快取：" + label + "、又讀不到雲端 → 不採用快取、不送出 PUT", async () => {
      const c = Object.assign({data:ledger()}, extra);
      resetStorage({"cf-sync-cache": c});
      downServer();
      const w = await boot("index.html");
      await waitFor(() => /無法連線雲端/.test($(w, "saveInfo").textContent), 6000, "讀取失敗訊息");
      $(w, "budgetAll").value = "1000"; $(w, "budgetSave").click();
      await waitFor(() => !$(w, "banner").hidden, 4000, "錯誤提示");
      await sleep(200);
      eq(puts().length, 0, "不能送出");
      eq(JSON.stringify(cache()), JSON.stringify(c), "快取原封不動，沒有被覆蓋或刪除");
    });
  });
  test("E2E 快取：rev 無效、雲端回傳空帳本 → 不建立初始帳本（這台本來有資料）", async () => {
    resetStorage({"cf-sync-cache": {rev:"5", data:ledger()}});
    server(getLedger(0, null));
    const w = await boot("index.html");
    await waitFor(() => /無法連線雲端/.test($(w, "saveInfo").textContent), 6000, "讀取失敗訊息");
    await sleep(300);
    eq(puts().length, 0, "不能送出初始帳本");
  });
  test("E2E 快取：rev 無效、但雲端正常 → 改用雲端資料，之後可以正常存檔", async () => {
    resetStorage({"cf-sync-cache": {rev:-1, data:ledger()}});
    const base = getLedger(6, ledger());
    server(req => base(req) || (req.method === "PUT" ? {status:200, body:{rev:7}} : null));
    const w = await boot("index.html"); await ready(w);
    eq(cache().rev, 6, "快取換成雲端的有效版本");
    await addExpense(w, 30);
    await waitFor(() => cache().rev === 7, 4000, "存檔完成");
    eq(puts()[0].body.base, 6);
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

  test("E2E 卡片：PUT 回 200 但缺 rev → 不宣告成功、本機卡片和版本號不變", async () => {
    resetStorage();
    const base = getLedger(5, twoCards());
    server(req => base(req) || (req.method === "PUT" ? {status:200, body:{}} : null));
    const w = await boot("index.html"); await ready(w); await openCards(w);
    renameCard(w, "c2", "卡二改"); $(w, "cardsSave").click();
    await waitFor(() => !$(w, "banner").hidden, 4000, "錯誤提示");
    await sleep(300);
    eq(puts().length, 1);
    assert(/無法確認/.test($(w, "banner").textContent));
    eq(cache().rev, 5); eq(cache().data.cards.map(c => c.name), ["卡一", "卡二"]);
    eq(w.document.querySelector('#cardEdit details[data-id="c2"] .f-name').value, "卡二改", "畫面上的修改還在");
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

  test("E2E 月報更新鍵：GET 的 rev 是物件 → 不送出", async () => {
    const w = await bootReport(() => ({status:200, body:{rev:{v:3}, data:ledger()}}), () => ({status:200, body:{rev:4}}));
    rf(w).click();
    await waitFor(() => /沒送出/.test(msg(w)), 4000, "錯誤訊息");
    eq(puts().length, 0);
  });

  test("E2E 月報更新鍵：PUT 回 200 但缺 rev → 不誤報「已請電腦更新」", async () => {
    const w = await bootReport(() => ({status:200, body:{rev:3, data:ledger()}}), () => ({status:200, body:{}}));
    rf(w).click();
    await waitFor(() => /沒送出/.test(msg(w)), 4000, "錯誤訊息");
    assert(/無法確認/.test(msg(w)), "要說明無法確認");
    eq(puts().length, 1);
    assert(!rf(w).classList.contains("busy"), "不能顯示成更新中");
  });

  // 月報／帳本頁的 rev 規則要和 app/sync.js 完全相同：≥ 0 的安全整數；PUT 成功的 rev 要大於送出的 base
  [["字串", "3"], ["字串數字 0", "0"], ["負數", -1], ["小數", 3.5], ["null", null]].forEach(([label, rev]) => {
    test("E2E 月報更新鍵：GET 的 rev 是" + label + " → 不送出 PUT", async () => {
      const w = await bootReport(() => ({status:200, body:{rev, data:ledger()}}), () => ({status:200, body:{rev:4}}));
      rf(w).click();
      await waitFor(() => /沒送出/.test(msg(w)), 4000, "錯誤訊息");
      eq(puts().length, 0, "不能送出");
      assert(!rf(w).classList.contains("busy"));
    });
  });
  [["字串", "4"], ["和 base 相同", 3], ["比 base 小", 2], ["負數", -1], ["小數", 3.5]].forEach(([label, rev]) => {
    test("E2E 月報更新鍵：PUT 成功但回傳的 rev 是" + label + " → 不宣告「已請電腦更新」", async () => {
      const w = await bootReport(() => ({status:200, body:{rev:3, data:ledger()}}), () => ({status:200, body:{rev}}));
      rf(w).click();
      await waitFor(() => /沒送出/.test(msg(w)), 4000, "錯誤訊息");
      assert(/無法確認/.test(msg(w)), "要說明無法確認");
      assert(!/已請電腦更新/.test(msg(w)), "不能宣告成功");
      eq(puts().length, 1, "不重送");
      assert(!rf(w).classList.contains("busy"), "不能顯示成更新中");
    });
  });
  test("E2E 月報更新鍵：GET rev = 0（全新帳號）、PUT 回 1 → 正常送出", async () => {
    const w = await bootReport(() => ({status:200, body:{rev:0, data:ledger()}}), () => ({status:200, body:{rev:1}}));
    rf(w).click();
    await waitFor(() => rf(w).classList.contains("busy"), 4000, "更新中");
    eq(puts().length, 1); eq(puts()[0].body.base, 0);
    assert(/已請電腦更新/.test(msg(w)));
  });

  test("E2E 月報更新鍵：正常送出 → 帳本完整、只多 refreshReq", async () => {
    const w = await bootReport(() => ({status:200, body:{rev:3, data:ledger()}}), () => ({status:200, body:{rev:4}}));
    rf(w).click();
    await waitFor(() => rf(w).classList.contains("busy"), 4000, "更新中");
    eq(puts().length, 1);
    const d = puts()[0].body.data;
    eq(d.records.map(r => r.id), ["r1"]); assert(d.refreshReq > 0); eq(puts()[0].body.base, 3);
    assert(/已請電腦更新/.test(msg(w)), "正常流程要顯示已送出");
  });

  /* ---------- 登入：記住這台裝置 ---------- */
  // 沒有存密碼的狀態（只留帳號名稱），sessionPw：只放在 sessionStorage 的密碼（＝上次沒勾「記住」）
  function noPwStorage(sessionPw){
    resetStorage(); localStorage.removeItem("cf-pw");
    if(sessionPw) sessionStorage.setItem("cf-pw", sessionPw);
  }
  const lsHas = k => localStorage.getItem(k) != null, ssHas = k => sessionStorage.getItem(k) != null;
  async function loginVia(w, remember){
    await waitFor(() => !$(w, "gate").hidden, 4000, "登入畫面");
    $(w, "uName").value = TEST_USER; $(w, "pw").value = TEST_PW; $(w, "remember").checked = remember;
    $(w, "pwBtn").click();
    await ready(w);
  }

  test("E2E 登入：不勾「記住這台裝置」→ 密碼和帳本快取只在 sessionStorage，localStorage 不留", async () => {
    noPwStorage();
    server(getLedger(5, ledger()));
    const w = await boot("index.html");
    await waitFor(() => !$(w, "gate").hidden, 4000, "登入畫面");
    assert($(w, "remember").checked, "第一次登入預設勾「記住這台裝置」（和改版前的行為相同）");
    await loginVia(w, false);
    assert(!lsHas("cf-pw"), "localStorage 不能有密碼");
    assert(!lsHas("cf-sync-cache"), "localStorage 不能有帳本");
    eq(sessionStorage.getItem("cf-pw"), TEST_PW);
    eq(JSON.parse(sessionStorage.getItem("cf-sync-cache")).rev, 5, "帳本快取在 sessionStorage");
    eq(localStorage.getItem("cf-remember"), "0");
    eq(localStorage.getItem("cf-user"), TEST_USER, "帳號名稱保留，方便下次預先填好");
    assert(SERVER.calls.some(c => c.method === "GET" && c.key === TEST_PW), "讀取時有帶密碼");
  });

  test("E2E 登入：勾「記住這台裝置」→ 密碼和帳本快取在 localStorage（和改版前相同）", async () => {
    noPwStorage("old-session-pw"); sessionStorage.setItem("cf-sync-cache", "{}");
    server(getLedger(5, ledger()));
    const w = await boot("index.html");
    // sessionStorage 有密碼時會直接進入；先登出再用「記住」登入
    await ready(w); $(w, "forgetBtn").click();
    await loginVia(w, true);
    eq(localStorage.getItem("cf-pw"), TEST_PW);
    eq(cache().rev, 5);
    assert(!ssHas("cf-pw") && !ssHas("cf-sync-cache"), "sessionStorage 不留舊的密碼和帳本");
    eq(localStorage.getItem("cf-remember"), "1");
  });

  test("E2E 登入：上次沒勾「記住」、分頁還開著（sessionStorage 有密碼）→ 直接進入，不寫到 localStorage", async () => {
    noPwStorage(TEST_PW);
    server(getLedger(5, ledger()));
    const w = await boot("index.html"); await ready(w);
    assert($(w, "gate").hidden, "不用再登入");
    assert(!lsHas("cf-pw") && !lsHas("cf-sync-cache"), "localStorage 不留密碼和帳本");
    assert(ssHas("cf-sync-cache"));
    eq($(w, "remember").checked, false, "勾選框顯示上次的選擇");
  });

  test("E2E 登入：上次選「不記住」、分頁關過（都沒有密碼）→ 登入畫面預設不勾", async () => {
    noPwStorage(); localStorage.setItem("cf-remember", "0");
    server(getLedger(5, ledger()));
    const w = await boot("index.html");
    await waitFor(() => !$(w, "gate").hidden, 4000, "登入畫面");
    eq($(w, "remember").checked, false);
    eq($(w, "uName").value, TEST_USER, "帳號名稱預先填好");
  });

  test("E2E 登入：「在這台裝置登出」→ 兩邊的密碼和帳本快取都刪掉", async () => {
    resetStorage(); sessionStorage.setItem("cf-pw", "x"); sessionStorage.setItem("cf-sync-cache", "{}");
    server(getLedger(5, ledger()));
    const w = await boot("index.html"); await ready(w);
    assert(lsHas("cf-sync-cache"));
    $(w, "forgetBtn").click();
    await waitFor(() => !$(w, "gate").hidden, 4000, "登入畫面");
    assert(!lsHas("cf-pw") && !lsHas("cf-sync-cache") && !ssHas("cf-pw") && !ssHas("cf-sync-cache"));
  });

  test("E2E 登入：密碼不對（401）→ 兩邊的密碼都刪掉、回到登入畫面", async () => {
    noPwStorage("wrong-pw");
    server(req => common(req) || (req.method === "GET" && req.path === "/api/ledger" ? {status:401, body:{error:"帳號或密碼不對"}} : null));
    const w = await boot("index.html");
    await waitFor(() => !$(w, "gate").hidden, 4000, "登入畫面");
    assert(!ssHas("cf-pw") && !lsHas("cf-pw"));
  });

  test("E2E 月報頁：密碼只在 sessionStorage → 一樣能打開，「⟳ 更新」也帶得到密碼", async () => {
    noPwStorage(TEST_PW);
    const blob = await encBlob(TEST_PW, "<!doctype html><html><head><title>t</title></head><body><p id='rpt'>測試月報</p></body></html>");
    server(req => {
      if(req.path === "/api/ledger" && req.query.page === "report") return {status:200, body:{blob, savedAt:"2026-11-21T00:00:00Z"}};
      if(req.path === "/api/ledger" && req.method === "GET") return {status:200, body:{rev:3, data:ledger()}};
      if(req.path === "/api/ledger" && req.method === "PUT") return {status:200, body:{rev:4}};
      return null;
    });
    const w = await boot("view.html");
    await waitFor(() => w.document.getElementById("rpt") && rf(w), 6000, "月報打開");
    assert(!lsHas("cf-pw"), "打開後也不能寫到 localStorage");
    rf(w).click();
    await waitFor(() => rf(w).classList.contains("busy"), 4000, "更新中");
    eq(puts().length, 1); eq(puts()[0].key, TEST_PW, "更新鍵用 sessionStorage 的密碼");
  });

  test("E2E 月報頁：在月報頁登入、不勾「記住」→ 密碼只存在 sessionStorage", async () => {
    noPwStorage();
    const blob = await encBlob(TEST_PW, "<!doctype html><html><head><title>t</title></head><body><p id='rpt'>測試月報</p></body></html>");
    server(req => req.path === "/api/ledger" && req.query.page === "report" ? {status:200, body:{blob, savedAt:""}}
      : (req.path === "/api/ledger" && req.method === "GET" ? {status:200, body:{rev:3, data:ledger()}} : null));
    const w = await boot("view.html");
    await waitFor(() => !w.document.getElementById("f").hidden, 4000, "登入表單");
    assert(w.document.getElementById("rm").checked, "預設勾選");
    w.document.getElementById("u").value = TEST_USER; w.document.getElementById("pw").value = TEST_PW; w.document.getElementById("rm").checked = false;
    w.document.querySelector("#f button[type=submit]").click();
    await waitFor(() => w.document.getElementById("rpt"), 6000, "月報打開");
    assert(!lsHas("cf-pw")); eq(sessionStorage.getItem("cf-pw"), TEST_PW); eq(localStorage.getItem("cf-remember"), "0");
  });

  test("E2E 月報頁：在月報頁登入、勾「記住」→ 密碼存在 localStorage（和改版前相同）", async () => {
    noPwStorage();
    const blob = await encBlob(TEST_PW, "<!doctype html><html><head><title>t</title></head><body><p id='rpt'>測試月報</p></body></html>");
    server(req => req.path === "/api/ledger" && req.query.page === "report" ? {status:200, body:{blob, savedAt:""}}
      : (req.path === "/api/ledger" && req.method === "GET" ? {status:200, body:{rev:3, data:ledger()}} : null));
    const w = await boot("view.html");
    await waitFor(() => !w.document.getElementById("f").hidden, 4000, "登入表單");
    w.document.getElementById("u").value = TEST_USER; w.document.getElementById("pw").value = TEST_PW;
    w.document.querySelector("#f button[type=submit]").click();
    await waitFor(() => w.document.getElementById("rpt"), 6000, "月報打開");
    eq(localStorage.getItem("cf-pw"), TEST_PW); assert(!ssHas("cf-pw"));
  });

  /* ---------- 用戶端加密、登入金鑰（新版伺服器） ---------- */
  const L = window.LLSync;
  const NEW_PW = "e2e-new-password", REC = "ABCD-EFGH-2345";
  const others = r => SERVER.calls.filter(c => !(c.query.action === "pubkey") && c.path !== "/api/catalog" && !["register", "reset", "recwrap"].includes(c.query.action));
  /* 假的新版伺服器：有 pubkey、照帳號的登入方式驗證、帳本可以是加密的。st 是伺服器上的狀態，測試直接檢查它 */
  async function v2Server(o){
    o = o || {};
    const st = {rev:3, hasLk:o.hasLk !== false, hasPw:true, lk:await L.loginKey(TEST_USER, TEST_PW), wrap_pw:null, wrap_rec:null, rf:{refreshReq:0, refreshDone:0, refreshOk:null, refreshMsg:""}, puts:0};
    if(o.encrypted){
      st.dek = L.newDek();
      st.wrap_pw = await L.wrapDek(o.wrongKey ? L.newDek() : st.dek, TEST_PW, TEST_USER, "pw");
      st.enc = await L.encLedger(st.dek, o.data || ledger(), TEST_USER);
      if(o.recWrap) st.wrap_rec = await L.wrapDek(st.dek, REC, TEST_USER, "rec");
    } else st.data = o.data || ledger();
    const ok = b => ({status:200, body:Object.assign({ok:true}, b || {})});
    server(req => {
      const A = req.query.action, P = req.query.page;
      if(req.path === "/api/catalog") return {status:404, body:{}};
      if(A === "pubkey") return ok({pubkey:null, kid:null});
      if(o.route){ const x = o.route(req, st); if(x) return x; }
      if(A === "recwrap") return L.normCode(req.body.code) === L.normCode(REC) ? ok({wrap_rec:st.wrap_rec}) : {status:403, body:{error:"救援碼不對"}};
      if(A === "reset"){ st.reset = req.body; return ok(); }
      // 驗證：照登入方式比對
      if(req.kind === "lk"){ if(!st.hasLk) return {status:401, body:{error:"這個帳號還沒有設定登入金鑰", code:"no_login_key"}}; if(req.key !== st.lk) return {status:401, body:{error:"帳號或密碼不對"}}; }
      else if(!st.hasPw || req.key !== TEST_PW) return {status:401, body:{error:"帳號或密碼不對"}};
      if(A === "setlogin"){ st.hasLk = true; st.lk = req.body.loginKey; st.setlogin = req.body; return ok({hasPassword:true, hasLoginKey:true}); }
      if(A === "account") return ok({hasRecovery:true, recAt:"2026-11-01", hasPassword:st.hasPw, hasLoginKey:st.hasLk});
      if(A === "keys" && req.method === "GET") return ok({wrap_pw:st.wrap_pw, hasRecWrap:!!st.wrap_rec, adminKid:null});
      if(A === "keys" && req.method === "PUT"){ if(req.body.wrap_rec) st.wrap_rec = req.body.wrap_rec; return ok(); }
      if(A === "recovery"){ st.wrap_rec = null; return ok({code:REC, at:"2026-11-22"}); }
      if(A === "changepw"){ st.changed = req.body; return ok(); }
      if(P === "refresh"){ if(req.method === "PUT") Object.assign(st.rf, req.body); return {status:200, body:st.rf}; }
      if(P) return ok({blob:null});
      if(req.method === "GET") return {status:200, body:st.enc ? {rev:st.rev, enc:st.enc} : {rev:st.rev, data:st.data}};
      if(req.method === "PUT"){
        st.puts++;
        if(o.put){ const x = o.put(req, st); if(x) return x; }
        if(req.body.base !== st.rev) return {status:409, body:st.enc ? {error:"conflict", rev:st.rev, enc:st.enc} : {error:"conflict", rev:st.rev, data:st.data}};
        if(req.body.enc) st.enc = req.body.enc; else { if(st.enc) return {status:400, body:{error:"帳本已經加密", code:"encrypted"}}; st.data = req.body.data; }
        st.rev++; return {status:200, body:{rev:st.rev}};
      }
      return null;
    });
    return st;
  }
  const lkStored = () => JSON.parse(localStorage.getItem("cf-lk") || "null");

  test("E2E 加密：新版伺服器、帳號有登入金鑰 → 每個請求都只送登入金鑰（沒有密碼原文），登入金鑰存在 cf-lk", async () => {
    resetStorage();
    const st = await v2Server();
    const w = await boot("index.html"); await ready(w);
    await addExpense(w, 120);
    await waitFor(() => puts().length === 1, 6000, "存檔");
    const cs = others();
    assert(cs.length >= 2, "至少有讀取和存檔");
    cs.forEach(c => { eq([c.kind, c.key], ["lk", st.lk], c.method + " " + JSON.stringify(c.query)); });
    eq(lkStored(), {u:TEST_USER, lk:st.lk});
  });

  test("E2E 加密：舊帳號（還沒有登入金鑰）→ 先用密碼讀到，自動補上登入金鑰（不停用密碼），之後只送登入金鑰", async () => {
    resetStorage();
    const st = await v2Server({hasLk:false});
    const expect = st.lk;
    const w = await boot("index.html"); await ready(w);
    await waitFor(() => st.setlogin, 6000, "setlogin");
    eq(st.setlogin, {loginKey:expect}, "只補登入金鑰，沒有 dropPassword");
    await addExpense(w, 120);
    await waitFor(() => puts().length === 1, 6000, "存檔");
    eq([puts()[0].kind, puts()[0].key], ["lk", expect], "補上之後存檔只送登入金鑰");
    eq(lkStored(), {u:TEST_USER, lk:expect});
  });

  test("E2E 加密：舊版伺服器（沒有 pubkey）→ 照舊送密碼、不帶 x-cf-kind、不存登入金鑰（不會因為送錯金鑰被鎖）", async () => {
    resetStorage();
    server(getLedger(5, ledger()));
    const w = await boot("index.html"); await ready(w);
    others().forEach(c => eq([c.kind, c.key], [null, TEST_PW]));
    eq(localStorage.getItem("cf-lk"), null);
  });

  test("E2E 加密：加密的帳本 → 讀得到；新增一筆只送密文（沒有 data），解開後是完整帳本＋新的一筆", async () => {
    resetStorage();
    const st = await v2Server({encrypted:true});
    const w = await boot("index.html"); await ready(w);
    eq(shownItems(w), 1, "解開後顯示雲端的記錄");
    await addExpense(w, 120);
    await waitFor(() => puts().length === 1, 6000, "存檔");
    const b = puts()[0].body;
    assert(b.enc && !("data" in b), "只送密文"); eq(Object.keys(b).sort(), ["base", "enc"]); assert(!/卡一|餐飲|"records"/.test(JSON.stringify(b)), "送出的內容看不到明文（中文和 JSON 欄位名稱不會出現在 base64 裡）");
    const d = await L.decLedger(st.dek, st.enc, TEST_USER);
    eq(d.records.length, 2); eq(d.cards.map(c => c.name), ["卡一"]);
    eq(cache().data.records.length, 2, "本機快取（這台裝置）是解開後的帳本");
  });

  test("E2E 加密：加密帳本 409（附最新密文）→ 解開、重套、用密文重送，別台裝置的記錄保留", async () => {
    resetStorage();
    const st = await v2Server({encrypted:true});
    const w = await boot("index.html"); await ready(w);
    st.enc = await L.encLedger(st.dek, remoteWithX(), TEST_USER); st.rev = 4;   // 別台裝置存過一次（加了 rX）
    await addExpense(w, 120);
    await waitFor(() => puts().length === 2, 6000, "重送");
    eq(puts().map(p => [p.body.base, !!p.body.enc, "data" in p.body]), [[3, true, false], [4, true, false]]);
    const d = await L.decLedger(st.dek, st.enc, TEST_USER);
    eq(d.records.map(r => r.id).filter(id => id === "r1" || id === "rX"), ["r1", "rX"]); eq(d.records.length, 3);
  });

  test("E2E 加密：資料金鑰解不開（密碼對、但 wrap_pw 不是這本帳的）→ 不送出任何寫入、顯示錯誤、本機資料不動", async () => {
    resetStorage({"cf-sync-cache":{rev:3, data:ledger()}});
    const st = await v2Server({encrypted:true, wrongKey:true});
    const w = await boot("index.html");
    await waitFor(() => /無法連線雲端/.test($(w, "saveInfo").textContent), 6000, "讀取失敗訊息");
    await addExpense(w, 120);
    await waitFor(() => !$(w, "banner").hidden, 6000, "錯誤提示");
    await sleep(300);
    eq(st.puts, 0, "不能送出");
    eq(cache().data.records.map(r => r.id), ["r1"], "本機資料沒有被改動");
  });

  test("E2E 加密：改密碼 → 一起送新密碼、新的登入金鑰、用新密碼包的資料金鑰（解開是同一把），之後用新的登入金鑰", async () => {
    resetStorage();
    const st = await v2Server({encrypted:true});
    const w = await boot("index.html"); await ready(w);
    $(w, "npw1").value = $(w, "npw2").value = NEW_PW; $(w, "npwGo").click();
    await waitFor(() => st.changed, 8000, "changepw");
    const nlk = await L.loginKey(TEST_USER, NEW_PW);
    eq([st.changed.newPassword, st.changed.newLoginKey], [NEW_PW, nlk], "電腦端還用密碼登入，所以密碼也一起改");
    eq(L.b64e(await L.unwrapDek(st.changed.wrap_pw, NEW_PW, TEST_USER, "pw")), L.b64e(st.dek), "新密碼解得開同一把資料金鑰");
    await waitFor(() => localStorage.getItem("cf-pw") === NEW_PW, 4000, "存新密碼");
    // 伺服器換成新的登入方式後，下一次存檔用新的登入金鑰，而且照舊加密
    st.lk = nlk; st.wrap_pw = st.changed.wrap_pw;
    await addExpense(w, 50);
    await waitFor(() => puts().length === 1, 6000, "存檔");
    eq([puts()[0].kind, puts()[0].key, !!puts()[0].body.enc], ["lk", nlk, true]);
  });

  test("E2E 加密：產生救援碼 → 用救援碼包一份資料金鑰存回去（伺服器只拿到包好的）", async () => {
    resetStorage();
    const st = await v2Server({encrypted:true});
    const w = await boot("index.html"); await ready(w);
    $(w, "recBtn").click();
    await waitFor(() => st.wrap_rec, 8000, "存 wrap_rec");
    eq(L.b64e(await L.unwrapDek(st.wrap_rec, REC, TEST_USER, "rec")), L.b64e(st.dek));
    await waitFor(() => /ABCD-EFGH-2345/.test($(w, "recShow").textContent), 4000, "顯示救援碼");
    assert(!/⚠/.test($(w, "recShow").textContent), "沒有警告");
  });

  test("E2E 加密：忘記密碼用救援碼 → 在這台裝置解開資料金鑰、用新密碼重新包，重設時一起送", async () => {
    noPwStorage();
    const st = await v2Server({encrypted:true, recWrap:true});
    const w = await boot("index.html");
    await waitFor(() => !$(w, "gate").hidden, 4000, "登入畫面");
    $(w, "fgBtn").click(); $(w, "fgUser").value = TEST_USER; $(w, "fgCode").value = REC.toLowerCase(); $(w, "fgPw").value = NEW_PW;
    $(w, "fgGo").click();
    await waitFor(() => st.reset, 10000, "reset");
    eq([st.reset.user, st.reset.code, st.reset.newPassword, st.reset.newLoginKey], [TEST_USER, REC.toLowerCase(), NEW_PW, await L.loginKey(TEST_USER, NEW_PW)]);
    eq(L.b64e(await L.unwrapDek(st.reset.wrap_pw, NEW_PW, TEST_USER, "pw")), L.b64e(st.dek), "新密碼解得開同一把資料金鑰");
    await waitFor(() => /新密碼設好了/.test($(w, "fgMsg").textContent), 4000, "成功訊息");
  });

  test("E2E 加密：忘記密碼、但救援碼沒有保管資料金鑰 → 伺服器回 wrap_required 時說明清楚", async () => {
    noPwStorage();
    const st = await v2Server({encrypted:true, route:(req) => req.query.action === "reset" ? {status:400, body:{error:"x", code:"wrap_required"}} : null});
    const w = await boot("index.html");
    await waitFor(() => !$(w, "gate").hidden, 4000, "登入畫面");
    $(w, "fgBtn").click(); $(w, "fgUser").value = TEST_USER; $(w, "fgCode").value = REC; $(w, "fgPw").value = NEW_PW;
    $(w, "fgGo").click();
    await waitFor(() => /沒有保管資料金鑰/.test($(w, "fgMsg").textContent), 10000, "說明");
    assert(!("wrap_pw" in SERVER.calls.find(c => c.query.action === "reset").body), "沒有 wrap_rec 就不送 wrap_pw");
  });

  test("E2E 加密：帳本已加密時「請電腦立即更新」→ 只寫 page=refresh，不寫帳本", async () => {
    resetStorage();
    const st = await v2Server({encrypted:true});
    const w = await boot("index.html"); await ready(w);
    w.document.getElementById("rfNow").click();
    await waitFor(() => st.rf.refreshReq > 0, 6000, "page=refresh");
    await sleep(200);
    eq(st.puts, 0, "不寫帳本");
  });

  test("E2E 加密：帳本沒加密時「請電腦立即更新」→ 帳本照舊寫 refreshReq（目前的電腦端讀這裡），page=refresh 也寫", async () => {
    resetStorage();
    const st = await v2Server();
    const w = await boot("index.html"); await ready(w);
    w.document.getElementById("rfNow").click();
    await waitFor(() => puts().length === 1 && st.rf.refreshReq > 0, 6000, "兩邊都寫");
    eq(puts()[0].body.data.refreshReq, st.rf.refreshReq);
  });

  test("E2E 加密：月報頁（新版伺服器）→ 用登入金鑰下載；帳本已加密時「⟳ 更新」只寫 page=refresh", async () => {
    resetStorage();
    const blob = await encBlob(TEST_PW, "<!doctype html><html><head><title>t</title></head><body><p id='rpt'>測試月報</p></body></html>");
    const st = await v2Server({encrypted:true, route:(req, st) => req.query.page === "report" && req.kind === "lk" && req.key === st.lk ? {status:200, body:{blob, savedAt:""}} : null});
    const w = await boot("view.html");
    await waitFor(() => w.document.getElementById("rpt") && rf(w), 8000, "月報打開");
    eq(lkStored(), {u:TEST_USER, lk:st.lk}, "伺服器接受後存登入金鑰");
    rf(w).click();
    await waitFor(() => st.rf.refreshReq > 0, 6000, "page=refresh");
    await waitFor(() => rf(w).classList.contains("busy"), 4000, "更新中");
    eq(st.puts, 0, "不寫帳本");
    others().forEach(c => eq([c.kind, c.key], ["lk", st.lk], "月報頁和切換列都只送登入金鑰：" + JSON.stringify(c.query)));
  });

  window.__e2eCleanup =() => { if(frame) frame.remove(); Object.keys(localStorage).filter(k => /^(cf-|ll-)/.test(k)).forEach(k => localStorage.removeItem(k));
    Object.keys(sessionStorage).filter(k => /^cf-/.test(k)).forEach(k => sessionStorage.removeItem(k)); };
})();
