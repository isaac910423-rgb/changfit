/*
 * chang.fit 動作測試分析程式庫（在學員自己的手機上跑，影片不上傳）
 * 模型：MoveNet SinglePose Thunder（Google，Apache-2.0），用 TF.js WebGL 執行
 * 算法與雲端 SpinePose 版相同（2026-11-20 教練審閱版）：
 *   側彎   = 骨盆中點→兩肩中點連線與垂直線夾角（背面拍）
 *   胸椎旋轉 = 肩寬法 arccos(肩寬/中立肩寬)，肩寬先除以軀幹長抵銷前後移動
 *   骨盆旋轉 = 髖寬法 arccos(髖寬/中立髖寬)，髖寬先除以大腿長（正面拍）
 *   左右橫移 = 兩踝中點→骨盆中點連線與垂直線夾角（正面拍，絕對角）
 *   肩外展   = 上臂與軀幹往下方向的夾角（背面拍）
 * 正負號：+ = 受測者左側，- = 受測者右側
 * 用法：IsaacPose.analyze(videoUrl, testId, { modelUrl, weightUrls, onProgress }) → Promise<結果>
 */
(function () {
  'use strict';
  var KP = ['nose', 'l_eye', 'r_eye', 'l_ear', 'r_ear', 'l_sh', 'r_sh', 'l_elb', 'r_elb', 'l_wri', 'r_wri',
    'l_hip', 'r_hip', 'l_knee', 'r_knee', 'l_ank', 'r_ank'];
  var IDX = {}; KP.forEach(function (k, i) { IDX[k] = i; });
  var SIZE = 256, FPS = 10, MIN_SCORE = 0.3;

  // ===== 判讀門檻（教練可以直接改這裡）=====
  var RULES = {
    'test-sidebend': { view: 'back', kind: 'sidebend', unit: '°', diffOk: 5, diffWarn: 10, std: null },
    'test-trot': { view: 'back', kind: 'trot', unit: '°', diffOk: 5, diffWarn: 10, std: 35, firstSide: -1 },
    'test-pelvis-rot': { view: 'front', kind: 'prot', unit: '°', diffOk: 5, diffWarn: 10, std: null, firstSide: 1,
      note: '骨盆旋轉是用髖寬變化推算，髖關節點被褲子蓋住，誤差可能到 ±10°，請以左右差和教練目測為主' },
    'test-pelvis-shift': { view: 'front', kind: 'pshift', unit: '°', diffOk: 2, diffWarn: 4, std: null },
    'test-abd': { view: 'back', kind: 'abd', unit: '°', diffOk: 5, diffWarn: 10, std: 170 }
  };

  // ---------- 小工具 ----------
  function nanArr(n) { var a = new Array(n); for (var i = 0; i < n; i++) a[i] = NaN; return a; }
  function fill(x) { // NaN 線性內插
    var n = x.length, out = x.slice(), idx = [];
    for (var i = 0; i < n; i++) if (isFinite(out[i])) idx.push(i);
    if (idx.length < 2) return out;
    for (i = 0; i < n; i++) {
      if (isFinite(out[i])) continue;
      if (i < idx[0]) { out[i] = out[idx[0]]; continue; }
      if (i > idx[idx.length - 1]) { out[i] = out[idx[idx.length - 1]]; continue; }
      var j = 0; while (idx[j + 1] < i) j++;
      var a = idx[j], b = idx[j + 1]; out[i] = out[a] + (out[b] - out[a]) * (i - a) / (b - a);
    }
    return out;
  }
  function medfilt(x, k) {
    var h = (k - 1) / 2, out = x.slice();
    for (var i = 0; i < x.length; i++) {
      var w = []; for (var j = i - h; j <= i + h; j++) w.push(x[Math.min(x.length - 1, Math.max(0, j))]);
      w.sort(function (p, q) { return p - q; }); out[i] = w[h];
    }
    return out;
  }
  var SG9 = [-21, 14, 39, 54, 59, 54, 39, 14, -21].map(function (c) { return c / 231; });
  function savgol(x) {
    if (x.length < 9) return x.slice();
    var out = x.slice();
    for (var i = 0; i < x.length; i++) {
      var s = 0; for (var j = -4; j <= 4; j++) s += SG9[j + 4] * x[Math.min(x.length - 1, Math.max(0, i + j))];
      out[i] = s;
    }
    return out;
  }
  function smooth(x) { var f = fill(x); return f.some(isFinite) ? savgol(medfilt(f, 5)) : f; }
  function pct(x, p) { var a = x.filter(isFinite).sort(function (m, n) { return m - n; }); if (!a.length) return NaN; return a[Math.min(a.length - 1, Math.floor(p / 100 * (a.length - 1)))]; }
  function argmax(x) { var b = -1, v = -Infinity; for (var i = 0; i < x.length; i++) if (x[i] > v) { v = x[i]; b = i; } return b; }
  function argmin(x) { var b = -1, v = Infinity; for (var i = 0; i < x.length; i++) if (x[i] < v) { v = x[i]; b = i; } return b; }
  function deg(r) { return r * 180 / Math.PI; }
  function r1(v) { return Math.round(v * 10) / 10; }

  // ---------- 模型 ----------
  var modelPromise = null;
  function b64ToBytes(s) { var bin = atob(s), n = bin.length, u = new Uint8Array(n); for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i); return u; }
  function loadModel(opt) {
    if (modelPromise) return modelPromise;
    modelPromise = (async function () {
      var tf = window.tf;
      if (!tf) throw new Error('TF.js 沒有載入');
      try { await tf.setBackend('webgl'); } catch (e) { await tf.setBackend('cpu'); }
      await tf.ready();
      var mj = await (await fetch(opt.modelUrl)).json();
      var parts = await Promise.all(opt.weightUrls.map(function (u) { return fetch(u).then(function (r) { return r.json(); }); }));
      var total = 0, bufs = parts.map(function (p) { var b = b64ToBytes(p.b64); total += b.length; return b; });
      var all = new Uint8Array(total), off = 0; bufs.forEach(function (b) { all.set(b, off); off += b.length; });
      var specs = []; mj.weightsManifest.forEach(function (g) { specs = specs.concat(g.weights); });
      return tf.loadGraphModel(tf.io.fromMemory({ modelTopology: mj.modelTopology, weightSpecs: specs, weightData: all.buffer, format: mj.format, generatedBy: mj.generatedBy, convertedBy: mj.convertedBy }));
    })();
    modelPromise.catch(function () { modelPromise = null; });
    return modelPromise;
  }

  // 一格：在 crop 方框（原圖座標的正方形）內跑 MoveNet，回傳 17 點原圖座標
  function runFrame(model, canvas, ctx, video, crop) {
    var tf = window.tf;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.drawImage(video, crop.x, crop.y, crop.s, crop.s, 0, 0, SIZE, SIZE);
    var out = tf.tidy(function () {
      var img = tf.browser.fromPixels(canvas).toInt().expandDims(0);
      return model.execute(img);
    });
    var d = out.dataSync(); out.dispose();
    var kp = [];
    for (var i = 0; i < 17; i++) {
      var y = d[i * 3], x = d[i * 3 + 1], s = d[i * 3 + 2];
      kp.push([crop.x + x * crop.s, crop.y + y * crop.s, s]);
    }
    return kp;
  }
  function cropFrom(kp, W, H) { // 依上一格關鍵點決定下一格的正方形裁切（人放大，準度高）
    var xs = [], ys = [];
    kp.forEach(function (p) { if (p[2] > MIN_SCORE) { xs.push(p[0]); ys.push(p[1]); } });
    if (xs.length < 5) return { x: (W - Math.max(W, H)) / 2, y: (H - Math.max(W, H)) / 2, s: Math.max(W, H) };
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, s = Math.max(x1 - x0, y1 - y0) * 1.45;
    s = Math.max(s, Math.min(W, H) * 0.5); s = Math.min(s, Math.max(W, H));
    return { x: cx - s / 2, y: cy - s / 2, s: s };
  }
  // 跳到某一秒，並等到「那一格真的畫出來」才回傳（只等 seeked 時，部分瀏覽器拿到的還是舊畫面）
  function seek(video, t) {
    return new Promise(function (res) {
      var done = false, seeked = false;
      var finish = function () { if (!done) { done = true; res(); } };
      var onSeeked = function () {
        video.removeEventListener('seeked', onSeeked); seeked = true;
        if (video.requestVideoFrameCallback) { video.requestVideoFrameCallback(function () { finish(); }); setTimeout(finish, 250); }
        else { setTimeout(finish, 60); }
      };
      video.addEventListener('seeked', onSeeked); video.currentTime = t; setTimeout(finish, 2500);
    });
  }

  // ---------- 角度計算 ----------
  function series(K, name) { var i = IDX[name]; return K.map(function (k) { return k ? k[i] : [NaN, NaN, 0]; }); }
  function clean(P) { return P.map(function (p) { return p[2] > MIN_SCORE ? p : [NaN, NaN, p[2]]; }); }
  function lrByX(A, B) { // 依畫面 x 分左右，不靠模型左右標籤
    var L = [], R = [];
    for (var i = 0; i < A.length; i++) { if (A[i][0] < B[i][0]) { L.push(A[i]); R.push(B[i]); } else { L.push(B[i]); R.push(A[i]); } }
    return [L, R];
  }
  function mid(A, B) { return A.map(function (a, i) { return [(a[0] + B[i][0]) / 2, (a[1] + B[i][1]) / 2]; }); }
  function dist(A, B) { return A.map(function (a, i) { return Math.hypot(B[i][0] - a[0], B[i][1] - a[1]); }); }
  function tiltFromVertical(base, top) { return base.map(function (b, i) { return deg(Math.atan2(-(top[i][0] - b[0]), b[1] - top[i][1])); }); }
  function lineTilt(L, R) { return L.map(function (l, i) { return deg(Math.atan2(-(R[i][1] - l[1]), R[i][0] - l[0])); }); }

  // 方向：每段明顯轉開（>12°）的區段，取方向線索的加權多數決；判不出時依示範影片的先後順序
  function signBySegments(mag, cue, firstSide) {
    var n = mag.length, sign = new Array(n).fill(0), segs = [], on = false, s0 = 0;
    for (var i = 0; i <= n; i++) {
      var o = i < n && mag[i] > 12;
      if (o && !on) { s0 = i; on = true; }
      if (!o && on) { segs.push([s0, i]); on = false; }
    }
    // 只留最大的兩段（一左一右）
    segs.sort(function (a, b) { return Math.max.apply(null, mag.slice(b[0], b[1])) - Math.max.apply(null, mag.slice(a[0], a[1])); });
    var main = segs.slice(0, 2).sort(function (a, b) { return a[0] - b[0]; });
    var votes = main.map(function (sg) { var v = 0; for (var j = sg[0]; j < sg[1]; j++) v += (cue[j] || 0) * mag[j]; return v; });
    var sg = votes.map(function (v) { return v >= 0 ? 1 : -1; });
    if (main.length === 2 && sg[0] === sg[1]) { sg = [firstSide, -firstSide]; }   // 線索失敗：用先後順序
    if (main.length === 2 && Math.abs(votes[0]) + Math.abs(votes[1]) === 0) { sg = [firstSide, -firstSide]; }
    segs.forEach(function (s) {
      var k = main.indexOf(s), v = k >= 0 ? sg[k] : 0;
      if (k < 0) { var vv = 0; for (var j = s[0]; j < s[1]; j++) vv += (cue[j] || 0) * mag[j]; v = vv >= 0 ? 1 : -1; }
      for (var j2 = s[0]; j2 < s[1]; j2++) sign[j2] = v;
    });
    var last = main.length ? sg[0] : 1;
    for (i = 0; i < n; i++) {
      if (sign[i] === 0) {
        var nx = 0; for (var q = i; q < n; q++) if (sign[q] !== 0) { nx = sign[q]; break; }
        sign[i] = (nx && mag[i] > 3) ? nx : last;
      }
      last = sign[i];
    }
    return mag.map(function (m, i2) { return m * sign[i2]; });
  }

  function compute(K, t, testId) {
    var rule = RULES[testId]; var flip = rule.view === 'back' ? 1 : -1;
    var sh = lrByX(clean(series(K, 'l_sh')), clean(series(K, 'r_sh')));
    var hp = lrByX(clean(series(K, 'l_hip')), clean(series(K, 'r_hip')));
    var shMid = mid(sh[0], sh[1]), hipMid = mid(hp[0], hp[1]);
    var out = { testId: testId, unit: rule.unit, t: t };
    var a, iL, iR;
    if (rule.kind === 'sidebend') {
      a = smooth(tiltFromVertical(hipMid, shMid).map(function (v) { return v * flip; }));
      var pel = smooth(lineTilt(hp[0], hp[1]).map(function (v) { return v * flip; }));
      iL = argmax(a); iR = argmin(a);
      out.left = a[iL]; out.right = -a[iR];
      out.extra = [['左彎時骨盆傾斜', r1(Math.abs(pel[iL])) + '°'], ['右彎時骨盆傾斜', r1(Math.abs(pel[iR])) + '°']];
      out.labels = ['左側彎', '右側彎'];
    } else if (rule.kind === 'trot' || rule.kind === 'prot') {
      var A, B, len, cue;
      if (rule.kind === 'trot') {
        A = sh[0]; B = sh[1]; len = dist(shMid, hipMid);
        var face = series(K, 'nose').map(function (p, i) {
          var e1 = K[i] ? K[i][IDX.l_eye] : null, e2 = K[i] ? K[i][IDX.r_eye] : null;
          var pts = [p, e1, e2].filter(function (q) { return q && q[2] > 0.15; });
          return pts.length ? pts.reduce(function (s, q) { return s + q[0]; }, 0) / pts.length : NaN;
        });
        var dx = smooth(face.map(function (f, i) { return f - shMid[i][0]; }));
        cue = dx.map(function (v) { return isFinite(v) ? -Math.sign(v) * flip : 0; });   // 背面看臉露在畫面右 = 向受測者右轉
      } else {
        A = hp[0]; B = hp[1];
        var kn = mid(clean(series(K, 'l_knee')), clean(series(K, 'r_knee')));
        var an = mid(clean(series(K, 'l_ank')), clean(series(K, 'r_ank')));
        len = dist(hipMid, kn);
        var off = smooth(kn.map(function (k, i) { return k[0] - an[i][0]; }));
        var md = pct(off, 50);
        cue = off.map(function (v) { return isFinite(v) ? -Math.sign(v - md) * flip : 0; });
      }
      var w = smooth(dist(A, B).map(function (v, i) { return v / len[i]; }));
      var w0 = pct(w, 95);
      var mag = w.map(function (v) { return deg(Math.acos(Math.max(0, Math.min(1, v / w0)))); });
      a = signBySegments(mag, cue, rule.firstSide);
      iL = argmax(a); iR = argmin(a);
      out.left = a[iL]; out.right = -a[iR];
      out.labels = ['左轉', '右轉'];
      out.extra = [];
    } else if (rule.kind === 'pshift') {
      var an2 = mid(clean(series(K, 'l_ank')), clean(series(K, 'r_ank')));
      a = smooth(tiltFromVertical(an2, hipMid).map(function (v) { return v * flip; }));
      // tiltFromVertical 正 = 上端往畫面左；正面拍畫面左 = 受測者右
      var hw = dist(hp[0], hp[1]);
      var pc = smooth(hipMid.map(function (h, i) { return (h[0] - an2[i][0]) / hw[i] * 100 * -flip; }));
      iL = argmax(a); iR = argmin(a);
      out.left = a[iL]; out.right = -a[iR];
      out.labels = ['向左移', '向右移'];
      out.extra = [['向左移（髖寬 %）', Math.round(pc[iL]) + '%'], ['向右移（髖寬 %）', Math.round(-pc[iR]) + '%']];
    } else if (rule.kind === 'abd') {
      var el = lrByX(clean(series(K, 'l_elb')), clean(series(K, 'r_elb')));
      var up = shMid.map(function (s, i) { return [s[0] - hipMid[i][0], s[1] - hipMid[i][1]]; });
      var arm = function (S, E) {
        return smooth(S.map(function (s, i) {
          var v = [E[i][0] - s[0], E[i][1] - s[1]], u = up[i];
          var c = (v[0] * -u[0] + v[1] * -u[1]) / (Math.hypot(v[0], v[1]) * Math.hypot(u[0], u[1]));
          return deg(Math.acos(Math.max(-1, Math.min(1, c))));
        }));
      };
      var imgL = arm(sh[0], el[0]), imgR = arm(sh[1], el[1]);
      var pl = flip === 1 ? imgL : imgR, pr = flip === 1 ? imgR : imgL;
      iL = argmax(pl); iR = argmax(pr);
      out.left = pl[iL]; out.right = pr[iR];
      out.labels = ['左肩外展', '右肩外展'];
      out.extra = [];
      a = pl.map(function (v, i) { return v - pr[i]; });
    }
    out.series = a; out.iL = iL; out.iR = iR;
    out.diff = Math.abs(out.left - out.right);
    // 判讀
    var level, text;
    if (out.diff <= rule.diffOk) { level = 'ok'; text = '左右大致對稱'; }
    else if (out.diff <= rule.diffWarn) { level = 'mild'; text = '輕微不對稱：' + (out.left < out.right ? '左' : '右') + '側較少'; }
    else { level = 'warn'; text = '明顯不對稱：' + (out.left < out.right ? '左' : '右') + '側較少'; }
    if (rule.std) {
      var low = [];
      if (out.left < rule.std) low.push('左'); if (out.right < rule.std) low.push('右');
      if (low.length) { text += '；' + low.join('、') + '側未達標準 ' + rule.std + '°'; if (level === 'ok') level = 'mild'; }
    }
    if (rule.note) out.extra = (out.extra || []).concat([['注意', rule.note]]);
    out.level = level; out.verdict = text;
    out.left = r1(out.left); out.right = r1(out.right); out.diff = r1(out.diff);
    return out;
  }

  // ---------- 截圖：在最大角度那一格畫骨架 ----------
  var PROF_S = [0, 0.19, 0.39, 0.61, 0.82, 1], PROF_V = [0, 0.56, 0.89, 1, 0.75, 0], K_CURVE = 0.317;
  function interp(x, xs, ys) { for (var i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]); return ys[ys.length - 1]; }
  function spineCurve(b, tp) { // 教練標註校正過的側彎脊椎曲線樣板
    var v = [tp[0] - b[0], tp[1] - b[1]], L = Math.hypot(v[0], v[1]);
    var al = deg(Math.atan2(-v[0], -v[1])), u = [v[0] / L, v[1] / L], nrm = [-u[1], u[0]];
    var side = al > 0 ? 1 : -1; if (nrm[0] * side < 0) nrm = [-nrm[0], -nrm[1]];
    var pts = [];
    for (var i = 0; i <= 20; i++) {
      var s = i / 20, h = K_CURVE * Math.abs(al) * Math.PI / 180 * L * interp(s, PROF_S, PROF_V);
      pts.push([b[0] + v[0] * s + nrm[0] * h, b[1] + v[1] * s + nrm[1] * h]);
    }
    return pts;
  }
  async function snapshot(video, kp, label, value, testId) {
    var W = video.videoWidth, H = video.videoHeight, sc = 540 / W;
    var c = document.createElement('canvas'); c.width = 540; c.height = Math.round(H * sc);
    var g = c.getContext('2d'); g.drawImage(video, 0, 0, c.width, c.height);
    var P = function (n) { var p = kp[IDX[n]]; return p[2] > MIN_SCORE ? [p[0] * sc, p[1] * sc] : null; };
    var bones = [['l_sh', 'r_sh'], ['l_hip', 'r_hip'], ['l_sh', 'l_hip'], ['r_sh', 'r_hip'], ['l_sh', 'l_elb'], ['l_elb', 'l_wri'], ['r_sh', 'r_elb'], ['r_elb', 'r_wri'],
      ['l_hip', 'l_knee'], ['l_knee', 'l_ank'], ['r_hip', 'r_knee'], ['r_knee', 'r_ank']];
    g.lineWidth = 4; g.strokeStyle = 'rgba(243,237,227,0.9)';
    bones.forEach(function (bn) { var a = P(bn[0]), b = P(bn[1]); if (a && b) { g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); } });
    var ls = P('l_sh'), rs = P('r_sh'), lh = P('l_hip'), rh = P('r_hip');
    if (ls && rs && lh && rh && RULES[testId].view === 'back' && testId !== 'test-abd') {
      var top = [(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2], base = [(lh[0] + rh[0]) / 2, (lh[1] + rh[1]) / 2];
      if (testId === 'test-sidebend') {
        var cp = spineCurve(base, top); g.strokeStyle = '#DC3C3C'; g.lineWidth = 5; g.beginPath();
        cp.forEach(function (p, i) { if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); }); g.stroke();
        g.strokeStyle = '#FFC94A'; g.lineWidth = 4; g.beginPath(); g.moveTo(base[0], base[1]); g.lineTo(top[0], top[1]); g.stroke();
      } else {
        g.strokeStyle = '#DC3C3C'; g.lineWidth = 5; g.beginPath(); g.moveTo(base[0], base[1]); g.lineTo(top[0], top[1]); g.stroke();
      }
    }
    kp.forEach(function (p, i) { if (i >= 5 && p[2] > MIN_SCORE) { g.fillStyle = '#6B1E2A'; g.strokeStyle = '#F3EDE3'; g.lineWidth = 2; g.beginPath(); g.arc(p[0] * sc, p[1] * sc, 6, 0, 7); g.fill(); g.stroke(); } });
    g.fillStyle = 'rgba(30,10,14,0.78)'; g.fillRect(0, c.height - 64, c.width, 64);
    g.fillStyle = '#FFC94A'; g.font = '700 30px "Noto Sans TC", sans-serif'; g.fillText(label + ' ' + Math.round(value) + '°', 18, c.height - 22);
    return c.toDataURL('image/jpeg', 0.82);
  }

  // ---------- 主流程 ----------
  async function analyze(src, testId, opt) {
    opt = opt || {};
    var prog = opt.onProgress || function () {};
    if (!RULES[testId]) throw new Error('沒有這個測試的算法：' + testId);
    prog(0.02, '載入分析模型…');
    var model = await loadModel(opt);
    var video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.setAttribute('playsinline', ''); video.preload = 'auto'; video.crossOrigin = 'anonymous';
    video.src = src;
    await new Promise(function (res, rej) { video.onloadedmetadata = res; video.onerror = function () { rej(new Error('影片讀不到')); }; });
    if (video.readyState < 2) await new Promise(function (res) { video.onloadeddata = res; setTimeout(res, 2000); });
    // iPhone Safari：影片沒播過一次，暫停狀態下跳格不會更新畫面，所以先靜音播一下再暫停
    try { await video.play(); } catch (e) {}
    video.pause();
    var W = video.videoWidth, H = video.videoHeight, dur = video.duration;
    if (!isFinite(dur) || dur <= 0) throw new Error('影片長度讀不到');
    var canvas = document.createElement('canvas'); canvas.width = SIZE; canvas.height = SIZE;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var n = Math.max(10, Math.floor(dur * (opt.fps || FPS))), K = [], t = [];
    var crop = cropFrom([], W, H);
    for (var i = 0; i < n; i++) {
      var ti = Math.min(dur - 0.05, (i + 0.5) * dur / n);
      await seek(video, ti);
      var kp = runFrame(model, canvas, ctx, video, crop);
      var kp2 = opt.passes === 1 && i > 0 ? kp : runFrame(model, canvas, ctx, video, cropFrom(kp, W, H));   // 放大再跑一次，提高準度
      K.push(kp2); t.push(ti); crop = cropFrom(kp2, W, H);
      if (i % 3 === 0) prog(0.05 + 0.85 * i / n, '分析中 ' + Math.round(100 * i / n) + '%');
      if (i % 5 === 0) await new Promise(function (r) { setTimeout(r, 0); });
    }
    prog(0.92, '計算角度…');
    var res = compute(K, t, testId);
    await seek(video, t[res.iL]); res.snapL = await snapshot(video, K[res.iL], res.labels[0], res.left, testId);
    await seek(video, t[res.iR]); res.snapR = await snapshot(video, K[res.iR], res.labels[1], res.right, testId);
    res.keypoints = K;
    video.removeAttribute('src'); video.load();
    prog(1, '完成');
    return res;
  }

  window.IsaacPose = { analyze: analyze, compute: compute, rules: RULES, version: '2026-11-20' };
})();
