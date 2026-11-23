/* LifeLedger 的 QR code 產生器（不用網路、不用另外安裝）：給手機掃描打開隨手記
 * 用法：QR.matrix('https://…') → 二維陣列（true＝黑）；QR.svg('https://…', {px: 6}) → <svg> 字串
 * 依 ISO/IEC 18004：位元組模式、錯誤修正等級 M、版本 1–40 自動選、八種遮罩挑扣分最少的 */
(function (root) {
  'use strict';
  var ECC = { // 每一區塊的修正碼數、區塊數；索引＝版本
    L: [[-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
      [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], 1],
    M: [[-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
      [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], 0],
    Q: [[-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
      [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], 3],
    H: [[-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
      [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], 2]
  };

  function rawModules(v) {
    var r = (16 * v + 128) * v + 64;
    if (v >= 2) { var n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; }
    return r;
  }
  function dataCodewords(v, e) { return Math.floor(rawModules(v) / 8) - ECC[e][0][v] * ECC[e][1][v]; }
  function alignPos(v) {
    if (v === 1) return [];
    var n = Math.floor(v / 7) + 2, size = v * 4 + 17, step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2, r = [6];
    for (var p = size - 7; r.length < n; p -= step) r.splice(1, 0, p);
    return r;
  }
  // GF(256) 乘法（多項式 0x11D）與 Reed–Solomon
  function mul(x, y) { var z = 0; for (var i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z & 0xFF; }
  function rsDivisor(deg) {
    var r = []; for (var i = 0; i < deg - 1; i++) r.push(0); r.push(1);
    var root = 1;
    for (i = 0; i < deg; i++) {
      for (var j = 0; j < r.length; j++) { r[j] = mul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
      root = mul(root, 2);
    }
    return r;
  }
  function rsRemainder(data, div) {
    var r = div.map(function () { return 0; });
    data.forEach(function (b) {
      var f = b ^ r.shift(); r.push(0);
      div.forEach(function (c, i) { r[i] ^= mul(c, f); });
    });
    return r;
  }
  function utf8(s) { var b = [], e = unescape(encodeURIComponent(s)); for (var i = 0; i < e.length; i++) b.push(e.charCodeAt(i)); return b; }

  function matrix(text, ecl) {
    var e = ecl || 'M', bytes = utf8(text), v, bits = [];
    for (v = 1; v <= 40; v++) {
      var cc = v < 10 ? 8 : 16;
      if (4 + cc + bytes.length * 8 <= dataCodewords(v, e) * 8) break;
    }
    if (v > 40) throw new Error('QR: text too long');
    var push = function (val, n) { for (var i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(4, 4); push(bytes.length, v < 10 ? 8 : 16); bytes.forEach(function (b) { push(b, 8); });
    var cap = dataCodewords(v, e) * 8;
    push(0, Math.min(4, cap - bits.length));
    push(0, (8 - bits.length % 8) % 8);
    for (var pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) push(pad, 8);
    var data = []; for (var i = 0; i < bits.length; i += 8) { var x = 0; for (var k = 0; k < 8; k++) x = (x << 1) | bits[i + k]; data.push(x); }

    // 分區塊加上修正碼、交錯
    var nb = ECC[e][1][v], el = ECC[e][0][v], raw = Math.floor(rawModules(v) / 8), nShort = nb - raw % nb, shortLen = Math.floor(raw / nb);
    var div = rsDivisor(el), blocks = [], o = 0;
    for (i = 0; i < nb; i++) {
      var dl = shortLen - el + (i < nShort ? 0 : 1), d = data.slice(o, o + dl); o += dl;
      var ec = rsRemainder(d, div); if (i < nShort) d.push(0);
      blocks.push(d.concat(ec));
    }
    var cw = [];
    for (i = 0; i < blocks[0].length; i++) for (var j = 0; j < nb; j++) if (i !== shortLen - el || j >= nShort) cw.push(blocks[j][i]);

    // 畫固定圖形
    var size = v * 4 + 17, M = [], F = [];
    for (i = 0; i < size; i++) { M.push(new Array(size).fill(false)); F.push(new Array(size).fill(false)); }
    var set = function (x, y, on) { M[y][x] = !!on; F[y][x] = true; };
    for (i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(function (c) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy)), xx = c[0] + dx, yy = c[1] + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) set(xx, yy, dist !== 2 && dist !== 4);
      }
    });
    var ap = alignPos(v), na = ap.length;
    for (i = 0; i < na; i++) for (j = 0; j < na; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
      for (var dy2 = -2; dy2 <= 2; dy2++) for (var dx2 = -2; dx2 <= 2; dx2++) set(ap[i] + dx2, ap[j] + dy2, Math.max(Math.abs(dx2), Math.abs(dy2)) !== 1);
    }
    var drawFormat = function (mask) {
      var dat = (ECC[e][2] << 3) | mask, rem = dat;
      for (var q = 0; q < 10; q++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var b = ((dat << 10) | rem) ^ 0x5412, g = function (n) { return (b >>> n) & 1; };
      for (q = 0; q <= 5; q++) set(8, q, g(q));
      set(8, 7, g(6)); set(8, 8, g(7)); set(7, 8, g(8));
      for (q = 9; q < 15; q++) set(14 - q, 8, g(q));
      for (q = 0; q < 8; q++) set(size - 1 - q, 8, g(q));
      for (q = 8; q < 15; q++) set(8, size - 15 + q, g(q));
      set(8, size - 8, 1);
    };
    drawFormat(0);
    if (v >= 7) {
      var rv = v; for (i = 0; i < 12; i++) rv = (rv << 1) ^ ((rv >>> 11) * 0x1F25);
      var vb = (v << 12) | rv;
      for (i = 0; i < 18; i++) { var bt = (vb >>> i) & 1, a = size - 11 + i % 3, bb = Math.floor(i / 3); set(a, bb, bt); set(bb, a, bt); }
    }
    // 放資料（由右下往上、兩欄一組蛇行）
    var n = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) for (j = 0; j < 2; j++) {
        var xx2 = right - j, up = ((right + 1) & 2) === 0, yy2 = up ? size - 1 - vert : vert;
        if (!F[yy2][xx2] && n < cw.length * 8) { M[yy2][xx2] = ((cw[n >>> 3] >>> (7 - (n & 7))) & 1) === 1; n++; }
      }
    }
    // 遮罩：八種都試，挑扣分最少的
    var MASK = [function (x, y) { return (x + y) % 2 === 0; }, function (x, y) { return y % 2 === 0; }, function (x) { return x % 3 === 0; },
      function (x, y) { return (x + y) % 3 === 0; }, function (x, y) { return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; },
      function (x, y) { return x * y % 2 + x * y % 3 === 0; }, function (x, y) { return (x * y % 2 + x * y % 3) % 2 === 0; },
      function (x, y) { return ((x + y) % 2 + x * y % 3) % 2 === 0; }];
    var applyMask = function (m) { for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) if (!F[y][x] && MASK[m](x, y)) M[y][x] = !M[y][x]; };
    var best = 0, bestScore = Infinity;
    for (var m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      var sc = penalty(M, size); if (sc < bestScore) { best = m; bestScore = sc; }
      applyMask(m);
    }
    applyMask(best); drawFormat(best);
    return M;
  }

  function penalty(M, size) {
    var s = 0, x, y, run, dark = 0;
    var line = function (get) {
      var p = 0, hist = [];
      for (var i = 0; i < size; i++) {
        run = 1; while (i + 1 < size && get(i + 1) === get(i)) { run++; i++; }
        if (run >= 5) p += run - 2;
        hist.push(run);
      }
      for (var k = 2; k + 2 < hist.length; k++) {   // 1:1:3:1:1 的假定位圖形
        var c = hist[k]; if (c % 3) continue; var u = c / 3;
        if (hist[k - 2] === u && hist[k - 1] === u && hist[k + 1] === u && hist[k + 2] === u) p += 40;
      }
      return p;
    };
    for (y = 0; y < size; y++) s += line(function (i) { return M[y][i]; });
    for (x = 0; x < size; x++) s += line(function (i) { return M[i][x]; });
    for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++) {
      var c = M[y][x]; if (c === M[y][x + 1] && c === M[y + 1][x] && c === M[y + 1][x + 1]) s += 3;
    }
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (M[y][x]) dark++;
    var total = size * size;
    s += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
    return s;
  }

  function svg(text, opt) {
    opt = opt || {};
    var M = matrix(text, opt.ecl), n = M.length, q = 4, w = n + q * 2, d = '';
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) if (M[y][x]) d += 'M' + (x + q) + ' ' + (y + q) + 'h1v1h-1z';
    var px = (opt.px || 6) * w;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + w + '" width="' + px + '" height="' + px + '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
      '<rect width="100%" height="100%" fill="' + (opt.bg || '#FFFFFF') + '"/><path d="' + d + '" fill="' + (opt.fg || '#000000') + '"/></svg>';
  }

  root.QR = { matrix: matrix, svg: svg };
})(typeof window !== 'undefined' ? window : globalThis);
