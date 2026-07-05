'use strict';
// EQ Pro v4 - Architektur nach SoundFixer (bewährt auf YouTube/Firefox):
// Kein Content-Script. Popup injiziert Code per tabs.executeScript in alle Frames.
// Pro Media-Element: eigener AudioContext, Kette source -> gain -> 10x EQ -> limiter -> out.

const BANDS = ['32Hz','64Hz','125Hz','250Hz','500Hz','1k','2k','4k','8k','16k'];

const PRESETS = {
  'Bass Boost':  [10, 8, 5, 2, 0, -2, -3, -4, -5, -6],
  'Voice Boost': [-5, -3, 0, 5, 8, 6, 3, -1, -3, -5],
  'Hiphop':      [9, 7, 2, -2, -3, 0, 4, 6, 7, 5],
  'EDM':         [6, 4, 0, -2, -3, 2, 6, 9, 11, 7],
  'LOUD AF':     [12, 10, 8, 5, 3, 2, 0, -2, -3, 6],
  'Smooth Loud': [7, 5, 3, 1, 0, 0, 2, 3, 5, 3],
  'Classical':   [-4, -2, 0, 2, 4, 4, 2, 0, -2, -4],
  'Pop':         [4, 2, -2, -2, 0, 2, 4, 6, 4, 2],
  'Metal':       [10, 8, 4, -2, -4, 2, 8, 10, 11, 9],
  'Podcast':     [-7, -4, 0, 4, 6, 4, 0, -2, -5, -7]
};

let tid = 0;
const frameEls = new Map();   // frameId -> [elementIds]
let enabled = true;
let currentPreset = null;

// ── DOM ──
const powerBtn   = document.getElementById('powerBtn');
const powerDot   = document.getElementById('powerDot');
const powerLabel = document.getElementById('powerLabel');
const volSlider  = document.getElementById('volSlider');
const volValue   = document.getElementById('volValue');
const eqBands    = document.getElementById('eqBands');
const presetsGrid= document.getElementById('presetsGrid');
const flatBtn    = document.getElementById('flatBtn');
const resetBtn   = document.getElementById('resetBtn');
const statusLine = document.getElementById('statusLine');

// ══════════════════════════════════════════════════════════════
// KERN: Code-Injektion nach SoundFixer-Muster
// ══════════════════════════════════════════════════════════════

// Findet alle audio/video im Frame, gibt ihnen eine ID
function scanFrame(fid) {
  return browser.tabs.executeScript(tid, { frameId: fid, code: `(function () {
    const ids = [];
    for (const el of document.querySelectorAll('video, audio')) {
      if (!el.hasAttribute('data-eqpro-id')) {
        el.setAttribute('data-eqpro-id', Math.random().toString(36).substr(2, 10));
      }
      ids.push(el.getAttribute('data-eqpro-id'));
    }
    return ids;
  })()` });
}

// Baut/aktualisiert die Audio-Kette an einem Element und setzt die Werte
function applyToElement(fid, elid, s) {
  const code = `(function () {
    const el = document.querySelector('[data-eqpro-id="${elid}"]');
    if (!el) return 'gone';
    try {
      if (!el.eqCtx) {
        el.eqCtx = new AudioContext();
        el.eqSrc = el.eqCtx.createMediaElementSource(el);
        el.eqGain = el.eqCtx.createGain();

        const freqs = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
        el.eqFilters = freqs.map(function (f, i) {
          const bq = el.eqCtx.createBiquadFilter();
          bq.type = (i === 0) ? 'lowshelf' : (i === freqs.length - 1) ? 'highshelf' : 'peaking';
          bq.frequency.value = f;
          bq.Q.value = 1.1;
          bq.gain.value = 0;
          return bq;
        });

        el.eqSrc.connect(el.eqGain);
        el.eqGain.connect(el.eqFilters[0]);
        for (let i = 0; i < el.eqFilters.length - 1; i++) {
          el.eqFilters[i].connect(el.eqFilters[i + 1]);
        }
        el.eqFilters[el.eqFilters.length - 1].connect(el.eqCtx.destination);
      }
      if (el.eqCtx.state === 'suspended') el.eqCtx.resume();

      const s = ${JSON.stringify(s)};
      el.eqGain.gain.value = s.gain;
      s.eq.forEach(function (v, i) { el.eqFilters[i].gain.value = v; });
      return 'ok:' + el.eqCtx.state;
    } catch (e) {
      return 'err:' + e.message;
    }
  })()`;
  return browser.tabs.executeScript(tid, { frameId: fid, code })
    .then(r => r && r[0])
    .catch(err => 'err:' + err.message);
}

// Aktuelle UI-Werte auf ALLE gefundenen Elemente anwenden
function applyAll() {
  const s = {
    gain: enabled ? (parseInt(volSlider.value) / 100) : 1,
    eq: enabled ? getEQValues() : new Array(10).fill(0)
  };
  const jobs = [];
  for (const [fid, ids] of frameEls) {
    for (const elid of ids) jobs.push(applyToElement(fid, elid, s));
  }
  return Promise.all(jobs).then(results => {
    const ok = results.filter(r => typeof r === 'string' && r.startsWith('ok')).length;
    const err = results.filter(r => typeof r === 'string' && r.startsWith('err'));
    if (results.length === 0) {
      setStatus('Kein Audio/Video im Tab gefunden. Video starten, Popup neu oeffnen.', true);
    } else if (ok > 0) {
      setStatus(ok + ' Media-Element(e) verbunden - aktiv');
    } else if (err.length) {
      setStatus('Fehler: ' + err[0].slice(4), true);
    }
  });
}

function setStatus(txt, warn) {
  if (!statusLine) return;
  statusLine.textContent = txt;
  statusLine.style.color = warn ? '#f87171' : '#4ade80';
}

// ══════════════════════════════════════════════════════════════
// UI
// ══════════════════════════════════════════════════════════════

function buildEQ() {
  BANDS.forEach((label, i) => {
    const b = document.createElement('div');
    b.className = 'band';
    b.innerHTML = `
      <div class="band-val" id="bv-${i}">0</div>
      <div class="band-slider-wrap">
        <input type="range" class="band-slider" id="bs-${i}" min="-12" max="12" step="0.5" value="0">
      </div>
      <div class="band-label">${label}</div>`;
    eqBands.appendChild(b);
    b.querySelector(`#bs-${i}`).addEventListener('input', function () {
      updateBandVal(i, parseFloat(this.value));
      currentPreset = null;
      updatePresetBtns();
      save();
      applyAll();
    });
  });
}

function updateBandVal(i, v) {
  document.getElementById(`bv-${i}`).textContent = v > 0 ? `+${v}` : v;
}

function getEQValues() {
  return BANDS.map((_, i) => parseFloat(document.getElementById(`bs-${i}`).value));
}

function buildPresets() {
  Object.keys(PRESETS).forEach(name => {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.id = `p-${name}`;
    btn.textContent = name;
    btn.addEventListener('click', () => applyPreset(name));
    presetsGrid.appendChild(btn);
  });
}

function applyPreset(name) {
  PRESETS[name].forEach((v, i) => {
    document.getElementById(`bs-${i}`).value = v;
    updateBandVal(i, v);
  });
  currentPreset = name;
  updatePresetBtns();
  save();
  applyAll();
}

function updatePresetBtns() {
  Object.keys(PRESETS).forEach(name => {
    document.getElementById(`p-${name}`).classList.toggle('active', name === currentPreset);
  });
}

powerBtn.addEventListener('click', () => {
  enabled = !enabled;
  powerDot.classList.toggle('on', enabled);
  powerLabel.textContent = enabled ? 'AN' : 'AUS';
  save();
  applyAll();
});

volSlider.addEventListener('input', () => {
  const pct = parseInt(volSlider.value);
  volValue.textContent = pct + '%';
  let color = '#a78bfa';
  if (pct <= 100) color = '#4ade80';
  if (pct > 200) color = '#fb923c';
  if (pct > 400) color = '#f87171';
  volValue.style.color = color;
  save();
  applyAll();
});

flatBtn.addEventListener('click', () => {
  BANDS.forEach((_, i) => { document.getElementById(`bs-${i}`).value = 0; updateBandVal(i, 0); });
  currentPreset = null;
  updatePresetBtns();
  save();
  applyAll();
});

resetBtn.addEventListener('click', () => {
  BANDS.forEach((_, i) => { document.getElementById(`bs-${i}`).value = 0; updateBandVal(i, 0); });
  volSlider.value = 100;
  volValue.textContent = '100%';
  volValue.style.color = '';
  currentPreset = null;
  enabled = true;
  powerDot.classList.add('on');
  powerLabel.textContent = 'AN';
  updatePresetBtns();
  save();
  applyAll();
});

// ── Persistenz ──
function save() {
  browser.storage.local.set({
    eqSettings: {
      enabled,
      volume: parseInt(volSlider.value),
      values: getEQValues(),
      preset: currentPreset
    }
  });
}

function loadSaved() {
  return browser.storage.local.get('eqSettings').then(({ eqSettings: s }) => {
    if (!s) return;
    enabled = s.enabled !== false;
    powerDot.classList.toggle('on', enabled);
    powerLabel.textContent = enabled ? 'AN' : 'AUS';
    if (s.volume != null) {
      volSlider.value = s.volume;
      volValue.textContent = s.volume + '%';
    }
    if (Array.isArray(s.values) && s.values.length === BANDS.length) {
      s.values.forEach((v, i) => {
        document.getElementById(`bs-${i}`).value = v;
        updateBandVal(i, v);
      });
    }
    if (s.preset) { currentPreset = s.preset; updatePresetBtns(); }
  }).catch(() => {});
}

// ══════════════════════════════════════════════════════════════
// Start: Tab finden -> alle Frames scannen -> gespeicherte Settings anwenden
// ══════════════════════════════════════════════════════════════
buildEQ();
buildPresets();

browser.tabs.query({ currentWindow: true, active: true }).then(tabs => {
  tid = tabs[0].id;
  return loadSaved().then(() =>
    browser.webNavigation.getAllFrames({ tabId: tid }).then(frames =>
      Promise.all(frames.map(frame =>
        scanFrame(frame.frameId)
          .then(res => {
            const ids = (res && res[0]) || [];
            if (ids.length) frameEls.set(frame.frameId, ids);
          })
          .catch(() => {})
      ))
    )
  );
}).then(() => {
  const total = [...frameEls.values()].reduce((a, b) => a + b.length, 0);
  if (total === 0) {
    setStatus('Kein Audio/Video gefunden. Erst Video starten, dann Popup oeffnen.', true);
  } else {
    // Gespeicherte Settings sofort anwenden
    applyAll();
  }
}).catch(e => setStatus('Fehler: ' + e.message, true));
