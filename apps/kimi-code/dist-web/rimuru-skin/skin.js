/* Rimuru idle skin widget for Kimi Code Web UI.
 * Floating transparent canvas, bottom-right corner. Classic script, same-origin
 * assets — passes the server's CSP (no inline script/style).
 * Motion: hem corners ±2.2px + sword tassel ±4px strip warp; everything else static.
 */
(() => {
  "use strict";

  const META = {"width":400,"height":618,"weight_exp":1.5,"breath":{"amp":0.0,"period":3.2,"anchor_y":596},"order":["collar","hem_l","hem_r","hair_l","hair_r","tassel"],"layers":{"collar":{"x":103,"y":101,"w":195,"h":101,"amp_x":0.0,"amp_y":0.0,"period":3.2,"lag":0.08,"edge":"uniform","curve":"breath"},"hem_l":{"x":75,"y":321,"w":87,"h":105,"amp_x":2.2,"amp_y":0.0,"period":1.0,"phase":0.6,"edge":"bottom"},"hem_r":{"x":188,"y":320,"w":126,"h":107,"amp_x":2.2,"amp_y":0.0,"period":1.0,"phase":2.6,"edge":"bottom"},"hair_l":{"x":129,"y":41,"w":53,"h":157,"amp_x":0.0,"amp_y":0.0,"period":0.9,"phase":2.1,"edge":"bottom"},"hair_r":{"x":246,"y":109,"w":84,"h":132,"amp_x":0.0,"amp_y":0.0,"period":1.0,"phase":4.0,"edge":"bottom"},"tassel":{"x":313,"y":247,"w":46,"h":84,"amp_x":4.0,"amp_y":0.5,"period":1.1,"phase":1.2,"edge":"bottom"}}};

  const BASE = "/rimuru-skin/layers/";
  const STRIP = 2;       // px per horizontal warp strip
  const VIEW = 0.5;      // display scale: 400x618 -> 200x309

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function loadImage(src) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error("load failed: " + src));
      im.src = src;
    });
  }

  function smoothstep(u) { return u * u * (3 - 2 * u); }
  function breathCurve(x) {
    x = ((x % 1) + 1) % 1;
    if (x < 0.40) return smoothstep(x / 0.40);
    if (x < 0.50) return 1;
    if (x < 0.90) return 1 - smoothstep((x - 0.50) / 0.40);
    return 0;
  }
  function layerSignals(m, t) {
    if (m.curve === "breath") {
      const v = 2 * breathCurve(t / m.period - (m.lag || 0)) - 1;
      return [v, v];
    }
    const ang = 2 * Math.PI * t / m.period + (m.phase || 0);
    return [Math.sin(ang), Math.cos(ang)];
  }

  async function main() {
    const base = await loadImage(BASE + "base.png");
    const patches = {};
    for (const name of META.order) patches[name] = await loadImage(BASE + name + ".png");

    const dpr = window.devicePixelRatio || 1;
    const cv = document.createElement("canvas");
    cv.width = Math.round(META.width * VIEW * dpr);
    cv.height = Math.round(META.height * VIEW * dpr);
    cv.style.cssText =
      "position:fixed;right:12px;bottom:0;z-index:9999;pointer-events:none;" +
      "width:" + META.width * VIEW + "px;height:" + META.height * VIEW + "px;";
    document.body.appendChild(cv);
    const ctx = cv.getContext("2d");

    function drawLayer(im, m, t) {
      if (m.amp_x === 0 && m.amp_y === 0) {
        ctx.drawImage(im, m.x, m.y);
        return;
      }
      const [sx, sy] = layerSignals(m, t);
      for (let j = 0; j < m.h; j += STRIP) {
        const hh = Math.min(STRIP, m.h - j);
        const w = m.edge === "bottom" ? Math.pow(j / (m.h - 1), META.weight_exp) : 1.0;
        const dx = m.amp_x * w * sx;
        const dy = m.amp_y * w * sy;
        ctx.drawImage(im, 0, j, m.w, hh, m.x + dx, m.y + j + dy, m.w, hh);
      }
    }

    function draw(t) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      const k = VIEW * dpr;
      const b = META.breath;
      const syB = 1 + b.amp * (2 * breathCurve(t / b.period) - 1);
      ctx.setTransform(k, 0, 0, k * syB, 0, k * b.anchor_y * (1 - syB));
      ctx.drawImage(base, 0, 0);
      for (const name of META.order) drawLayer(patches[name], META.layers[name], t);
    }

    if (reduced) { draw(0); return; }   // honor prefers-reduced-motion: static pose

    let tPrev = null, tAcc = 0;
    function frame(now) {
      requestAnimationFrame(frame);
      const tSec = now / 1000;
      if (tPrev === null) tPrev = tSec;
      tAcc += tSec - tPrev;
      tPrev = tSec;
      draw(tAcc);
    }
    requestAnimationFrame(frame);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { main().catch(() => {}); });
  } else {
    main().catch(() => {});
  }
})();
