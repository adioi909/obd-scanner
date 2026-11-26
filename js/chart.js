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
    var pts = [];
    for (var i = 0; i < xs.length; i++) if (ys[i] != null && !isNaN(ys[i])) pts.push([xs[i], ys[i]]);
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = '#8a97a8';
    if (!pts.length) { ctx.fillText('No data', w / 2 - 20, h / 2); return; }
    var x0 = xs[0], x1 = xs[xs.length - 1] || x0 + 1;
    if (x1 === x0) x1 = x0 + 1;
    var ymin = Infinity, ymax = -Infinity;
    pts.forEach(function (p) { if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1]; });
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
  }
  function fmt(v) { var a = Math.abs(v); return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2); }
  function fmtTime(s) { s = Math.round(s); var m = Math.floor(s / 60); return m ? m + 'm' + (s % 60 ? (s % 60) + 's' : '') : s + 's'; }
  root.Chart = { drawLine: drawLine };
})(this);
