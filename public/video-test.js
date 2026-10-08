/* cloud-doc 1비트 영상 실험 (A: 셰이더 무수정).
 * window.CloudDoc.createRenderer를 공개 API 그대로 쓰고,
 * 바꾸는 것은 den 맵 값·프리셋 색·파라미터뿐. FS는 손대지 않음.
 */
(() => {
'use strict';
const CD = window.CloudDoc;
if (!CD) { document.body.append('cloud-doc.js 로드 실패'); return; }

const W1 = [1, 1, 1], B0 = [0, 0, 0];
// B&W 프리셋: 구름색 전부 흰(음영 평탄화), 하늘 전부 흰(수평선 far 퇴색이 흰→흰이라 무력화), rim 0.
const BW = {
  sky: [W1, W1, W1, W1, W1],
  shLo: W1, shHi: W1, mid: W1, lit: W1, rim: B0, far: W1, watA: W1, watB: W1,
};
const E_ON = 2.2, E_OFF = -2.0;   // RANGE.den = { min:-2, max:2.2 }

const view = document.getElementById('view');
const orig = document.getElementById('orig');
const octx = orig.getContext('2d');
const R = CD.createRenderer(view, { alpha: true });
if (!R.ok) { document.body.append('WebGL2 불가: ' + R.error); return; }

const el = id => document.getElementById(id);
let doc = null, playing = true, t = 20, lastT = performance.now();
let fpsEMA = 60, renderMsEMA = 0;

function makeDoc(w, h) {
  const [cov, scale] = [+el('cov').value, +el('scale').value];
  doc = {
    scene: 'dusk', w, h, horizon: 0, time: 20,
    params: { cov, sharp: 0.01, soft: 0.05, scale, absorb: 0.2, sun: 90, grain: 0 },
    den: new Float32Array(w * h).fill(E_OFF),
    tr: new Float32Array(w * h).fill(0),
  };
  R.alloc(w, h);
  R.upload('den', doc.den);
  R.upload('tr', doc.tr);
  // 캔버스 안에 contain 레터박스 (가로세로비 달라도 찌그러지지 않음, 남는 곳은 투명=검정).
  // rect 원점은 아래쪽 기준이므로 y도 아래에서 계산.
  const s = Math.min(view.width / w, view.height / h);
  const rw = w * s, rh = h * s;
  doc.rect = [(view.width - rw) / 2, (view.height - rh) / 2, rw, rh];
  doc.baUp = false;
}

function putFrame(bin /* Uint8Array 0/1, w*h, 위쪽 행이 먼저 (일반 이미지 순서) */) {
  const d = doc.den, w = doc.w, h = doc.h;
  // CloudDoc 규약: 행 0 = 문서 아래. 셰이더가 v=0(캔버스 아래)에서 den 행 0을 읽으므로 상하 반전해서 적재.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    d[(h - 1 - y) * w + x] = bin[y * w + x] ? E_ON : E_OFF;
  R.upload('den', d);
  // 원본 미리보기
  octx.fillStyle = '#000'; octx.fillRect(0, 0, orig.width, orig.height);
  const img = octx.createImageData(doc.w, doc.h);
  for (let i = 0; i < bin.length; i++) {
    const v = bin[i] ? 255 : 0;
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  // 작은 캔버스에 임시로 그려 확대
  const tmp = putFrame.c || (putFrame.c = document.createElement('canvas'));
  tmp.width = doc.w; tmp.height = doc.h;
  tmp.getContext('2d').putImageData(img, 0, 0);
  octx.imageSmoothingEnabled = false;
  octx.drawImage(tmp, 0, 0, orig.width, orig.height);
}

function genText(w, h, frame) {
  const c = genText.c || (genText.c = document.createElement('canvas'));
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff';
  g.font = `bold ${Math.round(h * 0.32)}px sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const dx = Math.round(Math.sin(frame * 0.05) * w * 0.05);
  g.fillText('HELLO', w / 2 + dx, h * 0.32);
  g.font = `bold ${Math.round(h * 0.22)}px sans-serif`;
  g.fillText('123 ABC', w / 2 - dx, h * 0.68);
  const px = g.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4] > 128 ? 1 : 0;
  return out;
}
function genSquare(w, h, frame) {
  const out = new Uint8Array(w * h);
  const s = Math.round(h * 0.3), x0 = Math.round((frame * 2) % (w + s) - s);
  const y0 = Math.round(h * 0.35);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    out[y * w + x] = (x >= x0 && x < x0 + s && y >= y0 && y < y0 + s) ? 1 : 0;
  return out;
}
function genBars(w, h, frame) {
  const out = new Uint8Array(w * h), p = 16, off = frame % p;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    out[y * w + x] = (((x + off) >> 3) & 1) ^ ((y >> 4) & 1);
  return out;
}
function genChecker(w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    out[y * w + x] = (((x >> 2) + (y >> 2)) & 1);
  return out;
}
function genCircle(w, h, frame) {
  const out = new Uint8Array(w * h);
  const r = (Math.sin(frame * 0.08) * 0.5 + 0.5) * h * 0.4 + 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x - w / 2, dy = y - h / 2;
    out[y * w + x] = (dx * dx + dy * dy < r * r) ? 1 : 0;
  }
  return out;
}
const GENS = { text: genText, square: genSquare, bars: genBars, checker: genChecker, circle: genCircle };

// 실사 프레임(Bad Apple 5s, 160x120 순수 1비트 PNG). 브라우저에서 128 기준으로 1비트 파싱.
const BA_SRC = 'video-frames/ba-5s-160x120.png';
let baBin = null, baLoading = false;
function ensureBA() {
  if (baBin || baLoading) return;
  baLoading = true;
  const im = new Image();
  im.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = 160; c.height = 120;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(im, 0, 0, 160, 120);
      const px = g.getImageData(0, 0, 160, 120).data;
      const out = new Uint8Array(160 * 120);
      for (let i = 0; i < out.length; i++) out[i] = px[i * 4] > 128 ? 1 : 0;
      baBin = out;
    } catch (e) { console.warn('badapple 프레임 파싱 실패', e); }
    baLoading = false;
  };
  im.onerror = () => { console.warn('badapple PNG 로드 실패: ' + BA_SRC); baLoading = false; };
  im.src = BA_SRC;
}

function render() {
  const t0 = performance.now();
  R.render({
    rect: doc.rect, doc, preset: BW, mode: 1, view: 0,
    overlay: 0, layer: 'den', time: t,
  });
  renderMsEMA = renderMsEMA * 0.9 + (performance.now() - t0) * 0.1;
}

let frame = 0;
function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  fpsEMA = fpsEMA * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;
  if (el('tmode').value === 'run') t += dt * 5;
  if (playing) {
    if (el('pat').value === 'badapple') {
      ensureBA();
      if (baBin && !doc.baUp) { putFrame(baBin); doc.baUp = true; }
    } else {
      const g = GENS[el('pat').value];
      putFrame(g(doc.w, doc.h, frame));
      frame++;
    }
  }
  render();
  el('fps').textContent = ` ${fpsEMA.toFixed(0)}fps · bake ${renderMsEMA.toFixed(2)}ms · frame ${frame}`;
}

function reset() {
  if (el('pat').value === 'badapple') { makeDoc(160, 120); ensureBA(); }
  else makeDoc(...el('res').value.split('x').map(Number));
  frame = 0;
}
for (const id of ['pat', 'res', 'scale', 'cov']) el(id).addEventListener('change', reset);
el('play').addEventListener('click', e => {
  playing = !playing;
  e.target.textContent = playing ? '⏸ 정지' : '▶ 재생';
});
reset();
requestAnimationFrame(tick);
})();
