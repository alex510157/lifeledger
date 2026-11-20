/* LifeLedger 同步防護（LLSync）
 * 目的：任何「雲端回應不完整或不可信」的情況，都不能拿空帳本、預設資料去覆蓋使用者的資料。
 *  - mutate：把修改套在副本上再送出；409 衝突時只接受格式完整的雲端資料，否則停下並保留目前資料
 *  - checkPull：讀取（GET）時檢查回應格式
 *  - mergeCards：儲存卡片設定時，只寫入「這台裝置真的改過」的卡，保留其他裝置新增或修改的卡；兩邊改到同一張卡就停下
 * 純邏輯、不碰畫面，瀏覽器（window.LLSync）與 Node（module.exports）都能載入，方便測試。
 */
(function(root){
  "use strict";

  function SyncError(code, message, extra){
    const e = new Error(message || code);
    e.name = "SyncError"; e.code = code;
    if(extra) Object.assign(e, extra);
    return e;
  }

  const isObj = x => x !== null && typeof x === "object" && !Array.isArray(x);
  const OPTIONAL_ARRAYS = ["incomes", "trips", "deposits", "depBanks", "paidMarks"];

  /* 帳本格式：必須是物件，records、cards 必須是陣列，其他已知清單有的話也必須是陣列 */
  function isLedger(d){
    if(!isObj(d)) return false;
    if(!Array.isArray(d.records) || !Array.isArray(d.cards)) return false;
    for(const k of OPTIONAL_ARRAYS) if(d[k] != null && !Array.isArray(d[k])) return false;
    return true;
  }
  /* 版本號（rev）的 API 合約，依後端 netlify/functions/ledger.mjs：
   *  - GET  回 {rev: cur ? cur.rev : 0, data}：新帳號 rev = 0、data = null
   *  - PUT 成功時存 rev: curRev + 1 並回 {rev}；比對方式是 Number(b.base) !== curRev
   *  - 409 回 {error, rev: curRev, data: cur ? cur.data : null}
   * 所以 rev 一定是 ≥ 0 的整數（伺服器不會產生字串或小數） */
  const isRev = r => Number.isSafeInteger(r) && r >= 0;

  const clone = x => JSON.parse(JSON.stringify(x));

  /* GET /api/ledger 的回應。所有情況都必須有有效的 rev（包括全新帳號的空資料）。
     allowEmpty：沒有本機資料的全新帳號，data 可以是 null（之後會建立初始帳本） */
  function checkPull(j, opt){
    opt = opt || {};
    if(!isObj(j)) throw SyncError("bad_response", "雲端回應格式不對，這台裝置的資料沒有被改動");
    if(!isRev(j.rev)) throw SyncError("bad_response", "雲端回應缺少有效的版本號，這台裝置的資料沒有被改動，請稍後再按「立即同步」");
    if(j.data == null){
      if(opt.allowEmpty) return {data:null, rev:j.rev, empty:true};
      throw SyncError("bad_response", "雲端沒有回傳帳本資料，這台裝置的資料沒有被改動，請稍後再按「立即同步」");
    }
    if(!isLedger(j.data)) throw SyncError("bad_response", "雲端回傳的帳本格式不對，這台裝置的資料沒有被改動");
    return {data:j.data, rev:j.rev, empty:false};
  }

  /* 409 衝突回應可以採用的條件：帳本格式完整、版本號有效，而且和我們送出的版本不同（不然重送只會一直衝突） */
  function usableConflict(j, sentBase){
    return isObj(j) && isLedger(j.data) && isRev(j.rev) && j.rev !== sentBase;
  }

  const UNSAFE_MSG = "雲端資料在別台裝置改過，但伺服器沒有回傳完整的最新資料，這次沒有存到。這台裝置的資料沒有被改動，請按「立即同步」後再試一次。";
  const RETRY_MSG = "另一台裝置也在存檔，這次沒有存到，請再按一次";
  const UNCONFIRMED_MSG = "伺服器的回應不完整（版本號缺少或不正確），無法確認這次有沒有存到。這台裝置的資料沒有被改動，請按「立即同步」確認雲端的內容後再試。";

  const BAD_LOCAL_REV_MSG = "這台裝置記錄的雲端版本號不正確，這次沒有存到，資料也沒有被改動。請按「立即同步」重新讀取雲端後再試。";

  /* 修改流程
   * opt.api(method, body) → Promise<{status, j}>
   * opt.data / opt.rev：目前的帳本與版本（不會被修改）
   * opt.fn(draft)：把修改套到副本上；丟出錯誤就不送出
   * 成功回傳 {data, rev}；失敗丟出錯誤，且不會用任何預設資料送出。
   * 409 收到的最新雲端資料只留在這個函式內部，重試期間不會通知呼叫端；
   * 只有整個流程成功時，呼叫端才拿到結果並更新本機資料、版本號與快取。失敗時呼叫端的資料完全不變。
   */
  async function mutate(opt){
    const tries = opt.tries || 3;
    if(!isLedger(opt.data)) throw SyncError("no_local_data", "這台裝置還沒讀到完整的帳本，這次沒有存到，請先按「立即同步」");
    if(!isRev(opt.rev)) throw SyncError("bad_local_rev", BAD_LOCAL_REV_MSG);
    let cur = {data:opt.data, rev:opt.rev};
    for(let k=0; k<tries; k++){
      const draft = clone(cur.data);
      opt.fn(draft);
      if(!isLedger(draft)) throw SyncError("bad_draft", "這次的修改會讓帳本格式不完整，所以沒有送出");
      const {status, j} = await opt.api("PUT", {base:cur.rev, data:draft});
      if(status === 200){
        // 200 也必須帶有效的 rev，而且要比送出的 base 新（後端是 base + 1）：
        // 不符合就無法確認伺服器存了哪一版，不宣告成功、不更新本機資料與版本號
        if(!isObj(j) || !isRev(j.rev) || j.rev <= cur.rev) throw SyncError("bad_response", UNCONFIRMED_MSG);
        return {data:draft, rev:j.rev};
      }
      if(status === 409){
        if(!usableConflict(j, cur.rev)) throw SyncError("conflict_unsafe", UNSAFE_MSG);
        cur = {data:j.data, rev:j.rev};   // 只在內部使用，成功前不改動呼叫端的資料
        continue;
      }
      if(status === 401) throw {auth:true, msg:j && j.error};
      throw SyncError("save_failed", (j && j.error) || ("儲存失敗（" + status + "）"));
    }
    throw SyncError("conflict_retry", RETRY_MSG);
  }

  /* ====== 卡片設定合併 ======
   * baseRaw：打開卡片編輯時的雲端卡片（原始格式）
   * baseForm：同一時間、從編輯畫面讀出的格式（和 local 同一種格式，才能判斷「有沒有改」）
   * local：按「儲存」時編輯畫面上的卡片
   * remote：送出前最新的雲端卡片（可能已被別台裝置改過）
   */
  function stable(x){
    if(Array.isArray(x)) return "[" + x.map(stable).join(",") + "]";
    if(isObj(x)) return "{" + Object.keys(x).filter(k=>x[k] !== undefined).sort().map(k=>JSON.stringify(k)+":"+stable(x[k])).join(",") + "}";
    return JSON.stringify(x === undefined ? null : x);
  }
  const same = (a,b) => stable(a) === stable(b);
  const byId = list => { const m = new Map(); (list||[]).forEach(c=>{ if(c && c.id != null) m.set(c.id, c); }); return m; };
  const ids = list => (list||[]).filter(c=>c && c.id != null).map(c=>c.id);

  function mergeCards(o){
    const baseRaw = byId(o.baseRaw), baseForm = byId(o.baseForm), local = byId(o.local), remote = byId(o.remote);
    const conflicts = [];
    const localChanged = id => !baseForm.has(id) || !local.has(id) || !same(baseForm.get(id), local.get(id));
    const remoteChanged = id => !baseRaw.has(id) || !remote.has(id) || !same(baseRaw.get(id), remote.get(id));
    const out = new Map();   // id → 最後要存的卡
    const fromLocal = new Set();

    // 1) 編輯畫面上的卡
    local.forEach((c, id) => {
      if(!baseForm.has(id)){ out.set(id, c); fromLocal.add(id); return; }          // 這台新增
      const lc = localChanged(id), inRemote = remote.has(id);
      if(!inRemote){ if(lc) conflicts.push(id); return; }                           // 別台刪了：這台有改 → 衝突；沒改 → 跟著刪
      if(lc){ if(remoteChanged(id)) conflicts.push(id); else { out.set(id, c); fromLocal.add(id); } }
      else out.set(id, remote.get(id));                                             // 這台沒改：保留雲端版本（含編輯畫面沒有的欄位）
    });
    // 2) 這台刪掉的卡
    baseForm.forEach((c, id) => { if(!local.has(id) && remote.has(id) && remoteChanged(id)) conflicts.push(id); });
    // 3) 別台新增的卡
    remote.forEach((c, id) => { if(!baseRaw.has(id) && !local.has(id)) out.set(id, c); });

    // 4) 順序
    const L = ids(o.local).filter(id=>out.has(id));
    const R = ids(o.remote).filter(id=>out.has(id));
    const keep = arr => arr.filter(id=>baseForm.has(id) && baseRaw.has(id) && local.has(id) && remote.has(id));
    const localReordered = !same(keep(ids(o.baseForm)), keep(ids(o.local)));
    const remoteReordered = !same(keep(ids(o.baseRaw)), keep(ids(o.remote)));
    if(localReordered && remoteReordered && !same(keep(ids(o.local)), keep(ids(o.remote)))) conflicts.push("(順序)");
    if(conflicts.length) return {ok:false, conflicts};

    let order;
    if(remoteReordered && !localReordered){
      // 用雲端的順序；這台新增的卡放在它在編輯畫面上前一張卡的後面
      order = R.slice();
      L.forEach((id, i) => { if(order.includes(id)) return;
        let j = i - 1; while(j >= 0 && !order.includes(L[j])) j--;
        order.splice(j >= 0 ? order.indexOf(L[j]) + 1 : 0, 0, id); });
    } else {
      order = L.slice();
      R.forEach((id, i) => { if(order.includes(id)) return;                           // 別台新增的卡：放在它在雲端上前一張卡的後面
        let j = i - 1; while(j >= 0 && !order.includes(R[j])) j--;
        order.splice(j >= 0 ? order.indexOf(R[j]) + 1 : order.length, 0, id); });
    }
    const cards = order.map(id => clone(out.get(id)));
    // 額度池的主卡如果已經不在了，就變回一般卡（和原本儲存時的處理一樣）
    const has = new Set(order);
    cards.forEach(c => { if(c.parentId && !has.has(c.parentId)) delete c.parentId; });
    return {ok:true, cards, changedIds:[...fromLocal]};
  }

  const LLSync = {SyncError, isLedger, isRev, checkPull, usableConflict, mutate, mergeCards, stable};
  if(typeof module !== "undefined" && module.exports) module.exports = LLSync;
  else root.LLSync = LLSync;
})(typeof window !== "undefined" ? window : globalThis);
