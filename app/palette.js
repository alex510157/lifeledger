/* LifeLedger 配色：跟電腦版 LifeLedger 一樣的 5 種主題（粉彩、薄荷、海洋、拿鐵、夜間）
 * 用法：網址加 ?theme=pastel|mint|ocean|latte|night（電腦版打開隨手記時會自動帶上），或在「設定 → 配色」選；
 *       ?theme=default 回到原本的深藍配色。選過會記在這台裝置（localStorage）。 */
(function () {
  // bg, surface, surface2, ink, ink2, ink3, rule, hero, hero2, accent, bar, gold, info, dark（跟 LifeLedger.pyw 的 PALETTE 同一份）
  var P = {
    pastel: ['#FFF9F3', '#FFFFFF', '#FFF3EA', '#3D3A4B', '#5E5A6E', '#8A8597', '#F0E2D8', '#D9708F', '#8E8BD8', '#D45C7A', '#FF8FA3', '#E3A04A', '#FFF1E6', 0],
    mint: ['#F3FBF7', '#FFFFFF', '#EAF7F0', '#24423A', '#4A665D', '#6E8A81', '#D3EBDF', '#1F8F6A', '#3A8FC0', '#1F9A72', '#34B98A', '#D49B3A', '#E6F5EE', 0],
    ocean: ['#F3F7FF', '#FFFFFF', '#EAF1FD', '#22324A', '#4A5B76', '#6B7C96', '#D6E2F5', '#2C5FC4', '#2B9BD1', '#2F6AD8', '#4A86F0', '#D9A440', '#E6EEFB', 0],
    latte: ['#FBF6F0', '#FFFFFF', '#F5EDE3', '#4A3B30', '#6B5848', '#937F70', '#E8D9C8', '#8C5A35', '#B98457', '#A86B3E', '#C58A5C', '#C9963F', '#F4EADF', 0],
    night: ['#1E2030', '#262838', '#2C2F44', '#ECEAF5', '#C3C0D6', '#A6A3BA', '#3A3C52', '#3A3F80', '#6E4E9C', '#A79BFF', '#8C7CF0', '#E0BE7A', '#2A2C40', 1]
  };
  var NAMES = { '': '原本（深藍）', pastel: '🍑 粉彩甜心', mint: '🌿 薄荷清新', ocean: '🌊 海洋微風', latte: '☕ 拿鐵奶茶', night: '🌙 夜間' };
  var LS = (function () { try { return window.localStorage; } catch (e) { return null; } })();
  function get() {
    var q = null;
    try { q = new URLSearchParams(location.search).get('theme'); } catch (e) {}
    if (q === 'default') { set(''); return ''; }
    if (q && P[q]) { set(q); return q; }
    var s = LS ? LS.getItem('ll-palette') : '';
    return s && P[s] ? s : '';
  }
  function set(p) {
    if (!LS) return;
    try {
      if (p && P[p]) { LS.setItem('ll-palette', p); LS.setItem('ll-theme', P[p][13] ? 'dark' : 'light'); }
      else { LS.removeItem('ll-palette'); LS.removeItem('ll-theme'); }
    } catch (e) {}
  }
  // 隨手記（index.html）用的變數
  function cssApp(p) {
    var v = P[p]; if (!v) return '';
    return ':root[data-palette="' + p + '"]{--bg:' + v[0] + ';--surface:' + v[1] + ';--surface2:' + v[2] + ';--line:' + v[6] + ';--ink:' + v[3] + ';--ink2:' + v[4] + ';--muted:' + v[5] +
      ';--navy:' + v[7] + ';--navy2:' + v[8] + ';--on-navy:#FFFFFF;--on-navy2:rgba(255,255,255,.8);--gold:' + v[11] + ';--gold-ink:' + (v[13] ? v[11] : v[9]) +
      ';--chip:' + v[2] + ';--focus:' + v[9] + ';color-scheme:' + (v[13] ? 'dark' : 'light') + '}' +
      ':root[data-palette="' + p + '"] .bnav button[aria-current="page"]{color:' + v[9] + '}' +
      ':root[data-palette="' + p + '"] input[type=checkbox],:root[data-palette="' + p + '"] input[type=radio]{accent-color:' + v[9] + '}';
  }
  // 月報、生活帳本（view.html 解密後的頁面）用的變數：跟電腦版 LifeLedger 給月報加的一樣
  function cssReport(p) {
    var v = P[p]; if (!v) return '';
    return ':root:root,:root:root[data-theme]{--bg:' + v[0] + ';--surface:' + v[1] + ';--surface-2:' + v[2] + ';--ink:' + v[3] + ';--ink-2:' + v[4] + ';--ink-3:' + v[5] +
      ';--rule:' + v[6] + ';--rule-2:' + v[6] + ';--track:' + v[2] + ';--hero:' + v[7] + ';--hero-2:' + v[8] + ';--hero-ink:#FFFFFF;--hero-ink-2:rgba(255,255,255,.78);--accent:' + v[9] +
      ';--bar:' + v[10] + ';--heat:' + v[9] + ';--gold:' + v[11] + ';--info-bg:' + v[12] + ';color-scheme:' + (v[13] ? 'dark' : 'light') + '}';
  }
  var cur = get();
  if (cur) {
    var H = document.documentElement;
    H.setAttribute('data-palette', cur);
    H.setAttribute('data-theme', P[cur][13] ? 'dark' : 'light');
  }
  window.LLPalette = {
    list: NAMES, current: cur, cssApp: cssApp, cssReport: cssReport, set: set,
    navy: function () { return cur ? P[cur][7] : ''; },
    dark: function () { return cur ? !!P[cur][13] : null; }
  };
  if (cur && document.head) {
    var st = document.createElement('style'); st.id = 'll-palette'; st.textContent = cssApp(cur); document.head.appendChild(st);
  }
})();
