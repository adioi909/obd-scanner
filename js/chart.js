/* Minimal canvas line chart (no dependencies). */
(function (root) {
  'use strict';
  function drawLine(canvas, xs, ys, opts) {
    opts = opts || {};
    var dpr = root.devicePixelRatio || 1;
    var w = canvas.clientWidth || 320, h = canvas.clientHeight || 160;
    canvas.width = w * dpr; canvas.height = h * dpr;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var padL = 46, padR = 8, padT = 8, padB = 22;
    var all = [];
    for (var i = 0; i < xs.length; i++) if (ys[i] != null && !isNaN(ys[i])) all.push([xs[i], ys[i]]);
    // v1.7.0: long drives are downsampled for drawing only (LTTB). Axis range uses every point, so spikes still set the scale.
    var target = Math.max(500, Math.min(800, Math.round((w - padL - padR) * 2)));
    var pts = all.length > (opts.threshold || 1000) ? lttb(all, opts.target || target) : all;
    canvas.dataset.plotted = pts.length; canvas.dataset.samples = all.length;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = '#8a97a8';
    if (!pts.length) { ctx.fillText('No data', w / 2 - 20, h / 2); return { plotted: 0, samples: 0 }; }
    var x0 = xs[0], x1 = xs[xs.length - 1] || x0 + 1;
    if (x1 === x0) x1 = x0 + 1;
    var ymin = Infinity, ymax = -Infinity;
    all.forEach(function (p) { if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1]; });
    if (ymax === ymin) { ymax += 1; ymin -= 1; }
    var pad = (ymax - ymin) * 0.08; ymin -= pad; ymax += pad;
    var X = function (x) { return padL + (x - x0) / (x1 - x0) * (w - padL - padR); };
    var Y = function (y) { return padT + (1 - (y - ymin) / (ymax - ymin)) * (h - padT - padB); };
    // grid
    ctx.strokeStyle = '#26303d'; ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) {
      var gy = ymin + (ymax - ymin) * g / 4, py = Y(gy);
      ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(w - padR, py); ctx.stroke();
      ctx.fillText(fmt(gy), 2, py + 4);
    }
    for (var gx = 0; gx <= 4; gx++) {
      var tx = x0 + (x1 - x0) * gx / 4;
      var label = (x1 - x0) < 20 ? (tx - x0).toFixed(1) + 's' : fmtTime(tx - x0);
      ctx.fillText(label, Math.min(X(tx) - 10, w - 34), h - 6);
    }
    ctx.strokeStyle = opts.color || '#ffb020'; ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach(function (p, k) { var px = X(p[0]), py = Y(p[1]); if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
    ctx.stroke();
    return { plotted: pts.length, samples: all.length };
  }

  /**
   * Largest-Triangle-Three-Buckets downsampling (Steinarsson 2013). points: [[x, y], ...] sorted by x.
   * Keeps the first and last point and, per bucket, the point forming the largest triangle with its neighbours,
   * so peaks and dips survive. Returns the input unchanged if it is already small enough.
   */
  function lttb(points, threshold) {
    var n = points.length;
    if (threshold >= n || threshold < 3) return points.slice();
    var out = [points[0]];
    var every = (n - 2) / (threshold - 2);
    var a = 0;
    for (var i = 0; i < threshold - 2; i++) {
      var avgStart = Math.floor((i + 1) * every) + 1, avgEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
      var ax = 0, ay = 0, cnt = avgEnd - avgStart;
      for (var j = avgStart; j < avgEnd; j++) { ax += points[j][0]; ay += points[j][1]; }
      if (cnt > 0) { ax /= cnt; ay /= cnt; } else { ax = points[n - 1][0]; ay = points[n - 1][1]; }
      var rs = Math.floor(i * every) + 1, re = Math.floor((i + 1) * every) + 1;
      var px = points[a][0], py = points[a][1], best = -1, pick = rs;
      for (var k = rs; k < re; k++) {
        var area = Math.abs((px - ax) * (points[k][1] - py) - (px - points[k][0]) * (ay - py));
        if (area > best) { best = area; pick = k; }
      }
      out.push(points[pick]); a = pick;
    }
    out.push(points[n - 1]);
    return out;
  }

  /** min / avg / max over the FULL series (nulls skipped). Never computed from downsampled points. */
  function summary(ys) {
    var mn = null, mx = null, sum = 0, n = 0;
    for (var i = 0; i < ys.length; i++) {
      var v = ys[i];
      if (v == null || isNaN(v)) continue;
      if (mn === null || v < mn) mn = v;
      if (mx === null || v > mx) mx = v;
      sum += v; n++;
    }
    return { min: mn, max: mx, avg: n ? sum / n : null, count: n };
  }
  function fmt(v) { var a = Math.abs(v); return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2); }
  function fmtTime(s) { s = Math.round(s); var m = Math.floor(s / 60); return m ? m + 'm' + (s % 60 ? (s % 60) + 's' : '') : s + 's'; }
  root.Chart = { drawLine: drawLine, lttb: lttb, summary: summary };
})(this);
