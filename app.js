// ============================================================
// ムーミン谷 per se Illustrata — Reader
// ============================================================
// Serve from the /reader directory:
//   cd reader && python -m http.server 8000
//   Open http://localhost:8000/
// ============================================================

const JSON_BASE = 'dist/chapters';
const IMAGE_BASE = 'dist/images';
const AUDIO_BASE = 'dist/audio';
const MANIFEST_URL = `${JSON_BASE}/manifest.json`;
const LEMMAS_URL  = `${JSON_BASE}/lemmas.json`;
const KANJI_URL   = `dist/kanji.json`;

const KANJI_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

// ----- State -----

const state = {
  chapters: {},          // { 1: chapterData, 2: chapterData, ... }
  chapterList: [],       // [1, 2, 3, ...] available chapter numbers
  manifest: null,        // light-weight manifest, loaded first
  currentChapter: null,
  currentView: 'landing',
  completedChapters: new Set(),
  lastChapter: null,
  studyOpen: false,      // Study Mode overlay (N key / Notes button)
  furiganaMode: 'smart', // 'smart' | 'on' | 'hover' | 'off'
  lemmaIndex: null,      // cumulative lemma → {reading, gloss, tier, first}
  kanjiIndex: null,      // kanji char → {m, on, kun, r, g, s, j}
  glossTimer: null,      // hover-dwell timer
  glossActiveRuby: null, // currently-opened ruby element
  // Audio
  slowSpeed: '0.7',      // '0.7' | '0.85' — what 🐢 buttons mean
  audioActiveBlock: null, // DOM article currently playing
  audioPlayAll: false,   // walking the chapter front-to-back
  audioPrefetched: new Set(), // URLs already warmed in cache
};

const FURIGANA_MODES = ['smart', 'on', 'hover', 'off'];
const FURIGANA_LABELS = { smart: 'Smart', on: 'All', hover: 'Hover', off: 'Off' };

// ----- Persistence -----

function loadSettings() {
  try {
    const completed = localStorage.getItem('moomin-reader-completed');
    if (completed) {
      JSON.parse(completed).forEach(n => state.completedChapters.add(n));
    }
    const last = localStorage.getItem('moomin-reader-last');
    if (last) state.lastChapter = parseInt(last, 10);
    const studyOpen = localStorage.getItem('moomin-reader-study-open');
    if (studyOpen !== null) state.studyOpen = studyOpen === 'true';
    const fMode = localStorage.getItem('moomin-reader-furigana-mode');
    if (fMode && FURIGANA_MODES.includes(fMode)) state.furiganaMode = fMode;
    const slowSpeed = localStorage.getItem('moomin-reader-slow-speed');
    if (slowSpeed === '0.7' || slowSpeed === '0.85') state.slowSpeed = slowSpeed;
  } catch (e) {
    console.warn('Could not load settings:', e);
  }
}

function saveSettings() {
  try {
    localStorage.setItem('moomin-reader-completed',
      JSON.stringify([...state.completedChapters]));
    if (state.lastChapter) {
      localStorage.setItem('moomin-reader-last', String(state.lastChapter));
    }
    localStorage.setItem('moomin-reader-study-open', String(state.studyOpen));
    localStorage.setItem('moomin-reader-furigana-mode', state.furiganaMode);
    localStorage.setItem('moomin-reader-slow-speed', state.slowSpeed);
  } catch (e) {
    console.warn('Could not save settings:', e);
  }
}

function markChapterComplete(num) {
  if (!state.completedChapters.has(num)) {
    state.completedChapters.add(num);
    saveSettings();
  }
}

// ----- Data Loading -----

async function loadManifest() {
  const r = await fetch(MANIFEST_URL, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`manifest HTTP ${r.status}`);
  return r.json();
}

async function loadChapter(num) {
  const padded = String(num).padStart(2, '0');
  const url = `${JSON_BASE}/ch${padded}.json`;
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`chapter ${num} HTTP ${r.status}`);
  return r.json();
}

async function loadGlossData() {
  // Both files are optional — the popover degrades gracefully if either is missing.
  try {
    const [lem, kan] = await Promise.all([
      fetch(LEMMAS_URL).then(r => r.ok ? r.json() : {}),
      fetch(KANJI_URL).then(r => r.ok ? r.json() : {}),
    ]);
    state.lemmaIndex = lem || {};
    state.kanjiIndex = kan || {};
  } catch (e) {
    console.warn('Gloss data unavailable — popover will show partial info:', e);
    state.lemmaIndex = state.lemmaIndex || {};
    state.kanjiIndex = state.kanjiIndex || {};
  }
}

// ----- Utilities -----

function escapeHtml(str) {
  if (str == null) return '';
  const el = document.createElement('span');
  el.textContent = String(str);
  return el.innerHTML;
}

function arcColor(arc) {
  return {
    A: 'var(--arc-a)',
    B: 'var(--arc-b)',
    C: 'var(--arc-c)',
    D: 'var(--arc-d)',
    E: 'var(--arc-e)',
  }[arc] || 'var(--text-secondary)';
}

// ----- Navigation -----

function showView(name) {
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  const target = document.getElementById(name);
  if (target) {
    target.classList.add('active');
    state.currentView = name;
  }
  window.scrollTo(0, 0);
}

async function openChapter(num) {
  let ch = state.chapters[num];
  if (!ch) {
    try {
      ch = await loadChapter(num);
      state.chapters[num] = ch;
    } catch (e) {
      console.error('Failed to load chapter', num, e);
      return;
    }
  }
  state.currentChapter = num;
  state.lastChapter = num;

  renderReader(ch);
  showView('reader');
  updateChapterNavButtons();
  history.pushState({ chapter: num }, '', `#ch${num}`);
  saveSettings();
}

function openPrevChapter() {
  if (!state.currentChapter) return;
  const idx = state.chapterList.indexOf(state.currentChapter);
  if (idx > 0) openChapter(state.chapterList[idx - 1]);
}

function openNextChapter() {
  if (!state.currentChapter) return;
  const idx = state.chapterList.indexOf(state.currentChapter);
  if (idx >= 0 && idx < state.chapterList.length - 1) {
    openChapter(state.chapterList[idx + 1]);
  }
}

function updateChapterNavButtons() {
  const prevBtn = document.getElementById('prev-chapter-btn');
  const nextBtn = document.getElementById('next-chapter-btn');
  if (!state.currentChapter) return;
  const idx = state.chapterList.indexOf(state.currentChapter);
  prevBtn.disabled = (idx <= 0);
  nextBtn.disabled = (idx >= state.chapterList.length - 1);
}

function goBack() {
  state.currentChapter = null;
  renderLanding();
  showView('landing');
  history.pushState(null, '', window.location.pathname);
  saveSettings();
}

window.addEventListener('popstate', (e) => {
  if (e.state && e.state.chapter) {
    openChapter(e.state.chapter);
  } else {
    state.currentChapter = null;
    showView('landing');
  }
});

// ----- Rendering: Landing Page -----

function renderLanding() {
  const container = document.getElementById('chapter-list');
  container.innerHTML = '';

  // Continue banner
  const banner = document.getElementById('continue-banner');
  const continueBtn = document.getElementById('continue-btn');
  const continueLabel = document.getElementById('continue-chapter-label');

  let continueNum = state.lastChapter && state.manifest.chapters.find(c => c.chapter === state.lastChapter)
    ? state.lastChapter : null;
  if (continueNum && state.completedChapters.has(continueNum)) {
    const idx = state.chapterList.indexOf(continueNum);
    for (let i = idx + 1; i < state.chapterList.length; i++) {
      if (!state.completedChapters.has(state.chapterList[i])) {
        continueNum = state.chapterList[i];
        break;
      }
    }
  }
  if (continueNum) {
    const m = state.manifest.chapters.find(c => c.chapter === continueNum);
    continueLabel.textContent = `Chapter ${continueNum} — ${m.title}`;
    banner.style.display = '';
    continueBtn.onclick = () => openChapter(continueNum);
  } else {
    banner.style.display = 'none';
  }

  // Group chapters by arc
  const byArc = {};
  for (const m of state.manifest.chapters) {
    const arc = m.arc || '_';
    if (!byArc[arc]) byArc[arc] = { label: m.arcLabel || `Arc ${arc}`, chapters: [] };
    byArc[arc].chapters.push(m);
  }

  const arcOrder = ['A', 'B', 'C', 'D', 'E'];
  for (const arc of arcOrder) {
    const group = byArc[arc];
    if (!group) continue;

    const section = document.createElement('section');
    section.className = 'arc-section';
    section.style.setProperty('--arc-color', arcColor(arc));

    const header = document.createElement('header');
    header.className = 'arc-header';
    header.innerHTML = `
      <span class="arc-tag">${escapeHtml(arc)}</span>
      <h2 class="arc-title">${escapeHtml(group.label)}</h2>
    `;
    section.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'chapter-grid';

    for (const m of group.chapters) {
      const card = document.createElement('article');
      card.className = 'chapter-card';
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.addEventListener('click', () => openChapter(m.chapter));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openChapter(m.chapter);
        }
      });

      const done = state.completedChapters.has(m.chapter);
      const check = done ? '<span class="chapter-check" title="Completed">&#10003;</span>' : '';

      const chars = (m.characters || []).slice(0, 4).map(escapeHtml).join('、');
      const charsHtml = chars ? `<div class="card-characters">${chars}</div>` : '';

      const padded = String(m.chapter).padStart(2, '0');
      const coverSrc = `${IMAGE_BASE}/ch${padded}.jpg`;

      card.innerHTML = `
        <div class="card-cover">
          <img class="card-cover-img" src="${coverSrc}" alt="${escapeHtml(m.title)}"
               loading="lazy" decoding="async"
               onerror="this.remove();this.parentNode.classList.add('cover-missing');">
          <div class="cover-placeholder" aria-hidden="true"></div>
        </div>
        <div class="card-info">
          <div class="card-head">
            <span class="chapter-num">${m.chapter}</span>
            <span class="card-step">step ${m.grammarStep}</span>
            ${check}
          </div>
          <h3 class="card-title">${escapeHtml(m.title)}</h3>
          <p class="card-grammar">${escapeHtml(m.grammarName)}</p>
          ${charsHtml}
        </div>
      `;
      grid.appendChild(card);
    }

    section.appendChild(grid);
    container.appendChild(section);
  }
}

// ----- Rendering: Reader -----

function renderReader(chapter) {
  // Stop any audio left over from a prior chapter; clear prefetch cache so
  // hovers in the new chapter populate fresh.
  if (typeof stopAudio === 'function') stopAudio();
  state.audioPrefetched.clear();

  // Header
  document.getElementById('reader-chapter-num').textContent = `Chapter ${chapter.chapter}`;
  document.getElementById('reader-chapter-title').textContent = chapter.title;
  document.getElementById('reader-grammar-badge').textContent =
    `step ${chapter.grammarStep} · ${chapter.grammarName}`;

  // Apply arc-color styling
  const readerRoot = document.getElementById('reader');
  readerRoot.style.setProperty('--arc-color', arcColor(chapter.arc));

  // Left chrome (vertical chapter-number flourish)
  const leftNum = document.getElementById('left-chrome-num');
  if (leftNum) leftNum.textContent = `Ch ${chapter.chapter} · ${chapter.arc}`;

  // Study-mode panel content
  renderSidePanel(chapter);
  applyStudyState();

  // Focus strip (always-visible chip list of this chapter's new lemmas)
  renderFocusStrip(chapter);

  // Prose scroll
  const scroll = document.getElementById('prose-scroll');
  scroll.innerHTML = '';

  // Illustration slot at top (reserved for future single-image-per-chapter)
  const illus = document.createElement('figure');
  illus.className = 'chapter-illustration';
  const illusImg = document.createElement('img');
  const padded = String(chapter.chapter).padStart(2, '0');
  illusImg.src = `${IMAGE_BASE}/ch${padded}.jpg`;
  illusImg.alt = chapter.title;
  illusImg.loading = 'lazy';
  illusImg.addEventListener('error', () => {
    illus.innerHTML = '';
    illus.classList.add('illustration-placeholder');
    const scene = (chapter.illustration && chapter.illustration.scene_note) || chapter.scene.location || '';
    illus.innerHTML = `
      <div class="placeholder-inner">
        <div class="placeholder-arc-tag">Arc ${escapeHtml(chapter.arc)}</div>
        <div class="placeholder-title">${escapeHtml(chapter.title)}</div>
        <div class="placeholder-scene">${escapeHtml(chapter.scene.location || '')}</div>
      </div>
    `;
  }, { once: true });
  illus.appendChild(illusImg);
  scroll.appendChild(illus);

  // Chapter-opening meta strip
  const meta = document.createElement('div');
  meta.className = 'prose-meta';
  meta.innerHTML = `
    <span class="prose-meta-arc">${escapeHtml(chapter.arcLabel)}</span>
    <span class="prose-meta-divider">·</span>
    <span class="prose-meta-position">${escapeHtml(chapter.arcPosition || '')}</span>
    <span class="prose-meta-divider">·</span>
    <span class="prose-meta-register">${escapeHtml(chapter.register || '')}</span>
  `;
  scroll.appendChild(meta);

  // Optional plot summary (P3.5) — collapsed by default. Rendered inline so
  // readers new to the Moomin canon can orient themselves before reading.
  if (chapter.plotSummary) {
    const plot = document.createElement('details');
    plot.className = 'prose-plot-summary';
    plot.innerHTML = `
      <summary>Show plot summary (English) — spoilers for this chapter only</summary>
      <p>${escapeHtml(chapter.plotSummary)}</p>
    `;
    scroll.appendChild(plot);
  }

  // Prose paragraphs
  for (const p of chapter.prose) {
    const article = document.createElement('article');
    article.className = `prose-block prose-${p.kind}`;
    article.dataset.proseId = p.id;

    if (p.kind === 'dialogue' && p.speaker) {
      const speakerTag = document.createElement('div');
      speakerTag.className = 'prose-speaker';
      speakerTag.textContent = p.speaker;
      article.appendChild(speakerTag);
    }

    // Audio controls — two play buttons (1.0× and slow). The slow button's
    // speed is dynamic, set per state.slowSpeed and refreshed when the user
    // changes the preference.
    const audioBar = renderProseAudioControls();
    article.appendChild(audioBar);

    // Split text on blank lines into sub-paragraphs for better rhythm.
    // Smart mode uses the budget-gated html (ruby only on un-owned kanji);
    // all other modes use htmlFull (ruby everywhere; CSS toggles visibility).
    // Older JSON may only have `html` — fall back to that or raw text.
    const useFull = state.furiganaMode !== 'smart';
    const source = (useFull ? (p.htmlFull || p.html) : p.html) || p.text;
    const isHtml = Boolean(p.html || p.htmlFull);
    const subparas = splitTextIntoParagraphs(source);
    for (const sp of subparas) {
      const body = document.createElement('div');
      body.className = 'prose-body';
      body.innerHTML = renderJapaneseText(sp, isHtml);
      article.appendChild(body);
    }

    scroll.appendChild(article);
  }

  // Reset progress
  document.getElementById('progress-fill').style.width = '0%';
  document.getElementById('progress-text').textContent =
    `0 / ${chapter.prose.length}`;

  // Newly-rendered prose blocks need their slow-speed labels populated to
  // match the loaded preference.
  if (typeof refreshSlowSpeedLabels === 'function') refreshSlowSpeedLabels();
}

function splitTextIntoParagraphs(text) {
  if (!text) return [];
  // Split on blank line(s) — YAML block-scalars preserved the \n\n breaks.
  return text.split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean);
}

// Render Japanese text — normalizing whitespace. Each line within a
// sub-paragraph becomes its own <span class="line"> so the CSS can give
// breathing room without the rigid single-sentence-per-card pattern.
// When `isHtml` is true, `source` already contains <ruby> markup from
// the build pipeline and is injected as-is; otherwise it is HTML-escaped.
function renderJapaneseText(source, isHtml) {
  const lines = source.split(/\n+/).map(l => l.trim()).filter(Boolean);
  return lines.map(l => {
    const inner = isHtml ? l : escapeHtml(l);
    return `<span class="line">${inner}</span>`;
  }).join('');
}

function renderSidePanel(chapter) {
  // Plot summary (English) — optional P3.5
  const plotSection = document.getElementById('plot-summary-section');
  const plotBody = document.getElementById('plot-summary-body');
  if (plotSection && plotBody) {
    if (chapter.plotSummary) {
      plotBody.textContent = chapter.plotSummary;
      plotSection.style.display = '';
    } else {
      plotSection.style.display = 'none';
    }
  }

  // Scene
  document.getElementById('scene-location').textContent = chapter.scene.location || '';
  const chars = (chapter.scene.characters || []).join('、');
  const mentioned = (chapter.scene.mentioned || []).length
    ? `(mentions: ${chapter.scene.mentioned.join('、')})` : '';
  document.getElementById('scene-characters').textContent =
    [chars, mentioned].filter(Boolean).join(' ');
  document.getElementById('scene-beat').textContent = chapter.scene.beat || '';

  // Grammar
  document.getElementById('grammar-name').textContent = chapter.grammarName || '';
  const patternsEl = document.getElementById('grammar-patterns');
  patternsEl.innerHTML = '';
  for (const pat of chapter.grammarPatterns || []) {
    const li = document.createElement('li');
    li.textContent = pat;
    patternsEl.appendChild(li);
  }

  // Focus vocab
  const focusEl = document.getElementById('focus-vocab-list');
  focusEl.innerHTML = '';
  for (const v of chapter.focusVocab || []) {
    appendVocabItem(focusEl, v);
  }

  // Stretch vocab
  const stretchSection = document.getElementById('stretch-vocab-section');
  const stretchEl = document.getElementById('stretch-vocab-list');
  stretchEl.innerHTML = '';
  const stretch = chapter.stretchVocab || [];
  if (stretch.length) {
    stretchSection.style.display = '';
    for (const v of stretch) appendVocabItem(stretchEl, v);
  } else {
    stretchSection.style.display = 'none';
  }

  // Grammar notes
  const notesSection = document.getElementById('grammar-notes-section');
  const notesList = document.getElementById('grammar-notes-list');
  notesList.innerHTML = '';
  if (chapter.grammarNotes && chapter.grammarNotes.length) {
    notesSection.style.display = '';
    for (const n of chapter.grammarNotes) {
      const li = document.createElement('li');
      li.textContent = n;
      notesList.appendChild(li);
    }
  } else {
    notesSection.style.display = 'none';
  }
}

function appendVocabItem(dl, vocab) {
  const dt = document.createElement('dt');
  dt.className = `vocab-lemma vocab-${vocab.tier || 'focus'}`;
  const readingLabel = vocab.reading && vocab.reading !== vocab.lemma
    ? `<span class="vocab-reading">${escapeHtml(vocab.reading)}</span>` : '';
  dt.innerHTML = `${escapeHtml(vocab.lemma)} ${readingLabel}`;
  const dd = document.createElement('dd');
  dd.className = 'vocab-gloss';
  dd.textContent = vocab.gloss || '';
  dl.appendChild(dt);
  dl.appendChild(dd);
}

// ----- Focus strip: clickable lemma chips that jump to first prose occurrence -----

function renderFocusStrip(chapter) {
  const list = document.getElementById('focus-strip-chips');
  if (!list) return;
  list.innerHTML = '';

  // Lemmas introduced in THIS chapter: focus first, then stretch, in order.
  const items = [
    ...(chapter.focusVocab || []).map(v => ({ ...v, tier: 'focus' })),
    ...(chapter.stretchVocab || []).map(v => ({ ...v, tier: 'stretch' })),
  ];

  if (!items.length) {
    list.innerHTML = '<li class="focus-chip-empty">—</li>';
    return;
  }

  for (const v of items) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `focus-chip ${v.tier === 'stretch' ? 'is-stretch' : ''}`.trim();
    btn.dataset.lemma = v.lemma;
    const reading = v.reading && v.reading !== v.lemma ? v.reading : '';
    btn.innerHTML = `
      <span class="focus-chip-lemma">${escapeHtml(v.lemma)}</span>
      ${reading ? `<span class="focus-chip-reading">${escapeHtml(reading)}</span>` : ''}
    `;
    btn.addEventListener('click', () => jumpToLemma(v.lemma));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function jumpToLemma(lemma) {
  if (!lemma) return;
  const blocks = document.querySelectorAll('.prose-block');
  for (const el of blocks) {
    // textContent drops <rt> readings when browsers render the ruby — but
    // innerText preserves them. Use textContent which includes the ruby base.
    if (el.textContent && el.textContent.includes(lemma)) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('chip-flash');
      // force reflow so the animation restarts when clicking the same chip twice
      void el.offsetWidth;
      el.classList.add('chip-flash');
      return;
    }
  }
}

// ----- Gloss popover (tap/hover-to-gloss with kanji breakdown) -----

function closeGloss() {
  const pop = document.getElementById('gloss-popover');
  if (pop) {
    pop.classList.remove('is-open');
    pop.setAttribute('aria-hidden', 'true');
  }
  if (state.glossActiveRuby) {
    state.glossActiveRuby.classList.remove('is-active');
    state.glossActiveRuby = null;
  }
  if (state.glossTimer) {
    clearTimeout(state.glossTimer);
    state.glossTimer = null;
  }
}

function rubyReading(ruby) {
  // Collect the text of <rt> elements inside this ruby. Covers multi-chunk
  // cases even if we only emitted data-lemma on the first.
  const rts = ruby.querySelectorAll('rt');
  let r = '';
  for (const rt of rts) r += rt.textContent;
  return r;
}

function rubyBase(ruby) {
  // textContent minus the rt readings. Tokens often display 宇宙 as the base.
  const clone = ruby.cloneNode(true);
  clone.querySelectorAll('rt, rp').forEach(el => el.remove());
  return clone.textContent;
}

function renderKanjiRow(ch) {
  const data = state.kanjiIndex && state.kanjiIndex[ch];
  if (!data) {
    // Unknown kanji (not in our book's set, or data not loaded)
    return `
      <div class="gloss-kanji-row">
        <div class="gloss-kanji-char">${escapeHtml(ch)}</div>
        <div class="gloss-kanji-info">
          <div class="gloss-kanji-meaning" style="color:var(--text-muted)">—</div>
        </div>
      </div>
    `;
  }
  const meaning = (data.m || []).slice(0, 3).join(', ');
  const onLine = (data.on || []).length
    ? `<div class="gloss-kanji-reading"><span class="rk-label">on</span>${(data.on || []).slice(0, 3).map(escapeHtml).join('・')}</div>`
    : '';
  const kunLine = (data.kun || []).length
    ? `<div class="gloss-kanji-reading"><span class="rk-label">kun</span>${(data.kun || []).slice(0, 3).map(escapeHtml).join('・')}</div>`
    : '';
  const radsLine = (data.r || []).length
    ? `<div class="gloss-kanji-rads">${(data.r || []).map(escapeHtml).join(' ')}</div>`
    : '';
  return `
    <div class="gloss-kanji-row">
      <div class="gloss-kanji-char">${escapeHtml(ch)}</div>
      <div class="gloss-kanji-info">
        <div class="gloss-kanji-meaning">${escapeHtml(meaning || '—')}</div>
        ${onLine}
        ${kunLine}
        ${radsLine}
      </div>
    </div>
  `;
}

function openGlossFor(ruby) {
  const pop = document.getElementById('gloss-popover');
  if (!pop) return;

  const lemma   = ruby.dataset.lemma   || rubyBase(ruby);
  const surface = ruby.dataset.surface || rubyBase(ruby);
  // <ruby> carries reading inside <rt>; <span class="word"> carries it on data-reading.
  const reading = ruby.dataset.reading || rubyReading(ruby);

  // Cumulative lemma lookup (lemma first, then surface fallback — UniDic
  // sometimes hands us a lemma that doesn't match the glossary entry, e.g.,
  // 行く vs 行う; surface is always the safer second try).
  const lemInfo = state.lemmaIndex && (state.lemmaIndex[lemma] || state.lemmaIndex[surface]);

  const displayedLemma = lemInfo
    ? (state.lemmaIndex[lemma] ? lemma : surface)
    : lemma;

  const readingShown = (lemInfo && lemInfo.reading) || reading || '';
  const glossText = lemInfo && lemInfo.gloss ? lemInfo.gloss : '';
  const tier = (lemInfo && lemInfo.tier) || '';
  const first = lemInfo && lemInfo.first ? lemInfo.first : '';

  // Build per-kanji rows for every kanji in the displayed lemma.
  const kanjiChars = [...displayedLemma].filter(c => KANJI_RE.test(c));
  const kanjiRows = kanjiChars.map(renderKanjiRow).join('');

  const tierBadge = tier
    ? `<span class="gloss-badge is-${escapeHtml(tier)}">${escapeHtml(tier)}</span>`
    : '';

  const firstLine = first
    ? `<div class="gloss-first">first seen in ${escapeHtml(first)}</div>`
    : '';

  const englishLine = glossText
    ? `<div class="gloss-english">${escapeHtml(glossText)}</div>`
    : `<div class="gloss-english" style="color:var(--text-muted)">(no glossary entry)</div>`;

  pop.innerHTML = `
    <div class="gloss-head">
      <span class="gloss-lemma" id="gloss-lemma">${escapeHtml(displayedLemma)}</span>
      ${readingShown ? `<span class="gloss-reading">${escapeHtml(readingShown)}</span>` : ''}
      ${tierBadge}
    </div>
    <div class="gloss-body">
      ${englishLine}
      ${firstLine}
    </div>
    ${kanjiChars.length ? `
      <div class="gloss-kanji-section">
        <div class="gloss-kanji-heading">Kanji</div>
        ${kanjiRows}
      </div>
    ` : ''}
  `;

  // Position — above the ruby element by default, flip below if there
  // isn't room. Keep within viewport horizontally.
  pop.classList.add('is-open');
  pop.setAttribute('aria-hidden', 'false');

  const r = ruby.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const margin = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let top = r.top - pr.height - margin;
  if (top < margin) top = r.bottom + margin; // flip below
  top = Math.max(margin, Math.min(top, vh - pr.height - margin));

  let left = r.left + (r.width / 2) - (pr.width / 2);
  left = Math.max(margin, Math.min(left, vw - pr.width - margin));

  pop.style.left = `${left}px`;
  pop.style.top  = `${top}px`;

  if (state.glossActiveRuby && state.glossActiveRuby !== ruby) {
    state.glossActiveRuby.classList.remove('is-active');
  }
  ruby.classList.add('is-active');
  state.glossActiveRuby = ruby;
}

function setupGlossPopover() {
  const scroll = document.getElementById('prose-scroll');
  const pop = document.getElementById('gloss-popover');
  if (!scroll || !pop) return;

  const HOVER_DELAY = 200;
  const hasTouch = matchMedia('(hover: none)').matches;

  // Click / tap: toggle
  scroll.addEventListener('click', (e) => {
    const ruby = e.target.closest('ruby[data-lemma], .word[data-lemma]');
    if (!ruby) return;
    if (state.glossActiveRuby === ruby) {
      closeGloss();
    } else {
      openGlossFor(ruby);
    }
  });

  // Hover (desktop only): open after 200ms dwell
  if (!hasTouch) {
    scroll.addEventListener('mouseover', (e) => {
      const ruby = e.target.closest('ruby[data-lemma], .word[data-lemma]');
      if (!ruby) return;
      if (state.glossTimer) clearTimeout(state.glossTimer);
      state.glossTimer = setTimeout(() => openGlossFor(ruby), HOVER_DELAY);
    });
    scroll.addEventListener('mouseout', (e) => {
      const ruby = e.target.closest('ruby[data-lemma], .word[data-lemma]');
      if (!ruby) return;
      // Only cancel if we're leaving to something that isn't the popover.
      const toEl = e.relatedTarget;
      if (toEl && (pop.contains(toEl) || toEl === pop)) return;
      if (state.glossTimer) {
        clearTimeout(state.glossTimer);
        state.glossTimer = null;
      }
    });
    // Keep popover open while cursor is on it; close on leave.
    pop.addEventListener('mouseleave', (e) => {
      const toEl = e.relatedTarget;
      if (toEl && toEl.closest && toEl.closest('ruby[data-lemma], .word[data-lemma]')) return;
      closeGloss();
    });
  }

  // Outside-click / tap closes
  document.addEventListener('click', (e) => {
    if (!state.glossActiveRuby) return;
    if (pop.contains(e.target)) return;
    if (e.target.closest('ruby[data-lemma], .word[data-lemma]')) return;
    closeGloss();
  });
}

// ----- Audio playback -----
//
// One shared <audio id="reader-audio"> instance. Each prose block gets a
// pair of buttons: ▶ (1.0×) and 🐢 (state.slowSpeed). MP3s pre-rendered
// at three speeds by tools/generate_audio.py — the slow file is selected
// by URL, no client-side playbackRate manipulation, so the pitch is clean.
//
// File layout: dist/audio/ch01/p01_1.0x.mp3, p01_0.85x.mp3, p01_0.7x.mp3.

function audioUrlFor(chapterNum, proseId, speed) {
  const padded = String(chapterNum).padStart(2, '0');
  // Match the on-disk naming from tools/generate_audio.py: "%g" formatting,
  // which strips trailing zeros so 1.0 → "1", 0.7 → "0.7", 0.85 → "0.85".
  // The 1.0× file is the only exception — generate_audio.py emits "1.0x".
  const speedTag = (speed === 1 || speed === '1' || speed === '1.0')
    ? '1.0x'
    : `${speed}x`;
  return `${AUDIO_BASE}/ch${padded}/${proseId}_${speedTag}.mp3`;
}

function renderProseAudioControls() {
  const bar = document.createElement('div');
  bar.className = 'prose-audio-bar';
  bar.innerHTML = `
    <button class="prose-audio-btn is-fast" type="button" data-speed="1.0"
            aria-label="Play this paragraph at normal speed" title="Play (1×)">
      <svg viewBox="0 0 16 16" aria-hidden="true"><polygon points="3,2 13,8 3,14" fill="currentColor"/></svg>
    </button>
    <button class="prose-audio-btn is-slow" type="button" data-speed="slow"
            aria-label="Play this paragraph slowly" title="Play slowly">
      <svg viewBox="0 0 16 16" aria-hidden="true"><polygon points="3,2 13,8 3,14" fill="currentColor"/></svg>
      <span class="prose-audio-speed-label">${state.slowSpeed}&times;</span>
    </button>
  `;
  return bar;
}

function refreshSlowSpeedLabels() {
  document.querySelectorAll('.prose-audio-btn.is-slow .prose-audio-speed-label')
    .forEach(el => { el.innerHTML = `${state.slowSpeed}&times;`; });
  document.querySelectorAll('.audio-speed-option input[type=radio]').forEach(r => {
    r.checked = (r.value === state.slowSpeed);
  });
}

function setActiveBlock(article) {
  if (state.audioActiveBlock && state.audioActiveBlock !== article) {
    state.audioActiveBlock.classList.remove('is-playing');
  }
  state.audioActiveBlock = article;
  if (article) article.classList.add('is-playing');
}

function clearActiveBlock() {
  if (state.audioActiveBlock) {
    state.audioActiveBlock.classList.remove('is-playing');
    state.audioActiveBlock = null;
  }
}

function stopAudio() {
  const a = document.getElementById('reader-audio');
  if (!a) return;
  a.pause();
  a.removeAttribute('src');
  a.load();           // discards any buffered data, fully resets state
  state.audioPlayAll = false;
  clearActiveBlock();
}

function playAudioForBlock(article, speedKind) {
  const a = document.getElementById('reader-audio');
  if (!a || !state.currentChapter) return;
  const proseId = article.dataset.proseId;
  if (!proseId) return;
  const speed = (speedKind === 'fast') ? '1.0' : state.slowSpeed;
  const url = audioUrlFor(state.currentChapter, proseId, speed);

  // Toggle: clicking the same speed on the active block stops it.
  if (state.audioActiveBlock === article && !a.paused) {
    const currentKind = a.dataset.speedKind;
    if (currentKind === speedKind) {
      stopAudio();
      return;
    }
  }

  setActiveBlock(article);
  a.dataset.speedKind = speedKind;
  a.src = url;
  a.playbackRate = 1.0;  // always — speed is baked into the file
  a.play().catch(() => { /* error handler below already deals with this */ });
}

function playNextInChapter() {
  if (!state.audioActiveBlock) return;
  const next = state.audioActiveBlock.nextElementSibling
    && state.audioActiveBlock.nextElementSibling.matches('.prose-block')
    ? state.audioActiveBlock.nextElementSibling
    : findNextProseBlock(state.audioActiveBlock);
  if (next) {
    playAudioForBlock(next, 'fast');
  } else {
    state.audioPlayAll = false;
    clearActiveBlock();
  }
}

function findNextProseBlock(from) {
  let el = from.nextElementSibling;
  while (el && !el.matches('.prose-block')) el = el.nextElementSibling;
  return el || null;
}

function startPlayAllChapter() {
  const first = document.querySelector('#prose-scroll .prose-block');
  if (!first) return;
  state.audioPlayAll = true;
  playAudioForBlock(first, 'fast');
}

function prefetchAudio(url) {
  if (state.audioPrefetched.has(url)) return;
  state.audioPrefetched.add(url);
  // Trigger a HEAD-equivalent fetch into the HTTP cache. fetch() with
  // no-store would defeat the cache; default mode is fine.
  fetch(url, { method: 'GET', cache: 'force-cache' }).catch(() => {
    // Likely a 404 (audio not yet generated). Silent — error handling
    // happens at play-time, not prefetch.
  });
}

function setupAudioPlayback() {
  const a = document.getElementById('reader-audio');
  const scroll = document.getElementById('prose-scroll');
  if (!a || !scroll) return;

  // Click → play/toggle
  scroll.addEventListener('click', (e) => {
    const btn = e.target.closest('.prose-audio-btn');
    if (!btn) return;
    e.stopPropagation();   // don't pop the gloss
    const article = btn.closest('.prose-block');
    if (!article) return;
    state.audioPlayAll = false;  // explicit click cancels chained playback
    const kind = btn.classList.contains('is-fast') ? 'fast' : 'slow';
    playAudioForBlock(article, kind);
  });

  // Hover → prefetch (cheap; just warms the HTTP cache for next click)
  scroll.addEventListener('mouseenter', (e) => {
    const btn = e.target.closest && e.target.closest('.prose-audio-btn');
    if (!btn) return;
    const article = btn.closest('.prose-block');
    if (!article || !state.currentChapter) return;
    const speed = btn.classList.contains('is-fast') ? '1.0' : state.slowSpeed;
    prefetchAudio(audioUrlFor(state.currentChapter, article.dataset.proseId, speed));
  }, true);  // capture — mouseenter doesn't bubble

  // Chained "play all" — when one block ends, advance.
  a.addEventListener('ended', () => {
    if (state.audioPlayAll) {
      playNextInChapter();
    } else {
      clearActiveBlock();
    }
  });

  // Audio file missing or unplayable. The most common case is "you haven't
  // generated audio yet" — show a one-time toast and degrade gracefully.
  a.addEventListener('error', () => {
    state.audioPlayAll = false;
    if (state.audioActiveBlock) {
      state.audioActiveBlock.classList.add('audio-missing');
      setTimeout(() => {
        if (state.audioActiveBlock) state.audioActiveBlock.classList.remove('audio-missing');
      }, 1500);
    }
    clearActiveBlock();
    // Console message — easier than a toast and doesn't pop in the user's face.
    if (a.src) {
      console.info(`[audio] not available: ${a.src.split('/').slice(-2).join('/')}`);
    }
  });

  // Pause when navigating away from the reader (back to landing).
  document.getElementById('back-btn')?.addEventListener('click', stopAudio);

  // Esc stops playback.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !a.paused) stopAudio();
  });

  // ----- Header controls: Play All + Settings popover -----

  const playAllBtn = document.getElementById('play-chapter-btn');
  if (playAllBtn) {
    playAllBtn.addEventListener('click', () => {
      if (state.audioPlayAll && !a.paused) {
        stopAudio();
      } else {
        startPlayAllChapter();
      }
    });
  }

  const settingsBtn = document.getElementById('audio-settings-btn');
  const settingsPop = document.getElementById('audio-settings-popover');
  if (settingsBtn && settingsPop) {
    const closePop = () => {
      settingsPop.classList.remove('is-open');
      settingsPop.setAttribute('aria-hidden', 'true');
      settingsBtn.setAttribute('aria-expanded', 'false');
    };
    const openPop = () => {
      settingsPop.classList.add('is-open');
      settingsPop.setAttribute('aria-hidden', 'false');
      settingsBtn.setAttribute('aria-expanded', 'true');
    };
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = settingsPop.classList.contains('is-open');
      if (isOpen) closePop(); else openPop();
    });
    document.addEventListener('click', (e) => {
      if (!settingsPop.classList.contains('is-open')) return;
      if (settingsPop.contains(e.target)) return;
      if (e.target === settingsBtn || settingsBtn.contains(e.target)) return;
      closePop();
    });

    settingsPop.querySelectorAll('input[type=radio][name=audio-slow-speed]').forEach(r => {
      r.addEventListener('change', () => {
        if (r.checked) {
          state.slowSpeed = r.value;
          refreshSlowSpeedLabels();
          saveSettings();
          // Drop any prefetch cache keyed on the old slow speed — next hover
          // will repopulate for the new speed.
          state.audioPrefetched.clear();
        }
      });
    });
  }

  // Reflect the loaded preference into both the radio buttons and any
  // already-rendered prose blocks (rare on first load, but harmless).
  refreshSlowSpeedLabels();
}

// ----- Study Mode toggle -----

function applyStudyState() {
  document.body.classList.toggle('study-open', state.studyOpen);
  const btn = document.getElementById('notes-toggle');
  if (btn) btn.setAttribute('aria-expanded', String(state.studyOpen));
  const panel = document.getElementById('vocab-panel');
  if (panel) panel.setAttribute('aria-hidden', String(!state.studyOpen));
  const label = document.getElementById('notes-mode-label');
  if (label) label.textContent = state.studyOpen ? 'Close' : 'Study';
}

function toggleStudy() {
  state.studyOpen = !state.studyOpen;
  applyStudyState();
  saveSettings();
}

// ----- Furigana toggle -----

function applyFuriganaMode() {
  const body = document.body;
  for (const m of FURIGANA_MODES) body.classList.remove(`furigana-${m}`);
  body.classList.add(`furigana-${state.furiganaMode}`);
  const label = document.getElementById('furigana-mode-label');
  if (label) label.textContent = FURIGANA_LABELS[state.furiganaMode];
}

function cycleFurigana() {
  const prev = state.furiganaMode;
  const i = FURIGANA_MODES.indexOf(prev);
  state.furiganaMode = FURIGANA_MODES[(i + 1) % FURIGANA_MODES.length];
  applyFuriganaMode();
  // Crossing the smart ↔ non-smart boundary requires re-rendering prose
  // because the underlying HTML differs (gated vs all-ruby).
  const crossed = (prev === 'smart') !== (state.furiganaMode === 'smart');
  if (crossed && state.currentView === 'reader' && state.currentChapter) {
    const ch = state.chapters[state.currentChapter];
    if (ch) renderReader(ch);
  }
  saveSettings();
}

// ----- Scroll progress -----

function setupScrollProgress() {
  window.addEventListener('scroll', () => {
    if (state.currentView !== 'reader' || !state.currentChapter) return;
    const ch = state.chapters[state.currentChapter];
    if (!ch) return;

    const blocks = document.querySelectorAll('.prose-block');
    if (!blocks.length) return;

    let visibleIndex = 0;
    const threshold = window.innerHeight * 0.55;
    blocks.forEach((el, i) => {
      if (el.getBoundingClientRect().top < threshold) visibleIndex = i + 1;
    });

    const fill = document.getElementById('progress-fill');
    const text = document.getElementById('progress-text');
    const pct = blocks.length ? (visibleIndex / blocks.length) * 100 : 0;
    fill.style.width = `${Math.min(pct, 100)}%`;
    text.textContent = `${visibleIndex} / ${blocks.length}`;

    if (visibleIndex >= blocks.length) {
      markChapterComplete(state.currentChapter);
    }
  }, { passive: true });
}

// ----- Keyboard nav -----

function scrollToBlock(direction) {
  const blocks = document.querySelectorAll('.prose-block');
  if (!blocks.length) return;
  const threshold = window.innerHeight * 0.35;
  let currentIdx = 0;
  blocks.forEach((el, i) => {
    if (el.getBoundingClientRect().top < threshold) currentIdx = i;
  });
  const targetIdx = direction === 'next'
    ? Math.min(currentIdx + 1, blocks.length - 1)
    : Math.max(currentIdx - 1, 0);
  blocks[targetIdx].scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (state.currentView === 'reader') {
      if (e.key === 'Escape') {
        if (state.glossActiveRuby) { closeGloss(); return; }
        if (state.studyOpen) { toggleStudy(); return; }
        goBack();
        return;
      }
      if (e.key === 'n' || e.key === 'N') { toggleStudy(); return; }
      if (e.key === 'f' || e.key === 'F') { cycleFurigana(); return; }
      if (e.key === 'ArrowLeft') { openPrevChapter(); return; }
      if (e.key === 'ArrowRight') { openNextChapter(); return; }
      if (e.key === 'j' || e.key === 'J') { e.preventDefault(); scrollToBlock('next'); return; }
      if (e.key === 'k' || e.key === 'K') { e.preventDefault(); scrollToBlock('prev'); return; }
    }
  });
}

// ----- Init -----

async function init() {
  loadSettings();

  try {
    state.manifest = await loadManifest();
    state.chapterList = state.manifest.chapters.map(c => c.chapter).sort((a, b) => a - b);
  } catch (e) {
    console.error('Could not load manifest:', e);
    document.getElementById('chapter-list').innerHTML =
      '<p class="error-message">Could not load chapters. Run <code>python tools/build_reader.py</code> then reload.</p>';
    return;
  }

  // Kick off gloss-data load in parallel — the popover works once it resolves.
  loadGlossData();

  renderLanding();
  setupScrollProgress();
  setupKeyboard();
  setupGlossPopover();
  setupAudioPlayback();
  applyFuriganaMode();

  document.getElementById('back-btn').addEventListener('click', (e) => {
    e.preventDefault();
    goBack();
  });
  document.getElementById('prev-chapter-btn').addEventListener('click', openPrevChapter);
  document.getElementById('next-chapter-btn').addEventListener('click', openNextChapter);
  document.getElementById('notes-toggle').addEventListener('click', toggleStudy);
  document.getElementById('study-close-btn').addEventListener('click', () => {
    if (state.studyOpen) toggleStudy();
  });
  document.getElementById('study-backdrop').addEventListener('click', () => {
    if (state.studyOpen) toggleStudy();
  });
  document.getElementById('furigana-toggle').addEventListener('click', cycleFurigana);

  // Handle initial hash
  const hash = location.hash;
  const match = hash.match(/^#ch(\d+)$/);
  if (match) {
    const num = parseInt(match[1], 10);
    if (state.chapterList.includes(num)) {
      openChapter(num);
    }
  }
}

document.addEventListener('DOMContentLoaded', init);
