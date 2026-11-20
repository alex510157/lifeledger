/* 極簡測試框架：瀏覽器打開 tests/index.html 即可執行；結果也放在 window.__TEST_RESULTS 給自動化讀取 */
(function(){
  const T = [];
  window.test = (name, fn) => T.push({name, fn});
  window.assert = (cond, msg) => { if(!cond) throw new Error(msg || "assert failed"); };
  window.eq = (a, b, msg) => { const A=JSON.stringify(a), B=JSON.stringify(b); if(A!==B) throw new Error((msg||"not equal")+"\n  actual:   "+A+"\n  expected: "+B); };
  window.rejects = async (p, check, msg) => { let err=null; try{ await p; }catch(e){ err=e; } if(!err) throw new Error((msg||"expected rejection")); if(check) check(err); return err; };
  window.waitFor = async (cond, ms, what) => { const t0=Date.now(); for(;;){ let v; try{ v=cond(); }catch(e){} if(v) return v; if(Date.now()-t0>(ms||5000)) throw new Error("timeout waiting for "+(what||"condition")); await new Promise(r=>setTimeout(r,30)); } };
  window.sleep = ms => new Promise(r=>setTimeout(r,ms));
  window.runTests = async () => {
    const out = document.getElementById("out"), res = [];
    for(const t of T){
      const li = document.createElement("li"); li.textContent = "… " + t.name; out.appendChild(li);
      try{ await t.fn(); li.textContent = "✓ " + t.name; li.className = "ok"; res.push({name:t.name, ok:true}); }
      catch(e){ li.textContent = "✗ " + t.name + " — " + (e && e.message || e); li.className = "bad"; res.push({name:t.name, ok:false, error:String(e && e.message || e)}); }
    }
    const fail = res.filter(r=>!r.ok).length;
    const s = document.getElementById("sum"); s.textContent = (fail ? "FAIL" : "PASS") + "：" + (res.length - fail) + " / " + res.length + " 通過"; s.className = fail ? "bad" : "ok";
    window.__TEST_RESULTS = {done:true, total:res.length, failed:fail, results:res};
  };
})();
