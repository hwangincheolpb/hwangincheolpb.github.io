/* =========================================================
   Market Chart Book — charts.js
   Fetches ../data/index.json, renders all charts in order
   ========================================================= */

'use strict';

/* ---- Theme management ---- */
const THEME_KEY = 'chartbook_theme';

function getTheme() {
  return localStorage.getItem(THEME_KEY) || 'light';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.innerHTML = theme === 'dark'
      ? '<span>☀</span> Light'
      : '<span>☾</span> Dark';
  }
}

function toggleTheme() {
  const current = getTheme();
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  // Re-render all ECharts instances with new theme colours
  refreshAllCharts();
}

/* ---- Colour palette per theme ----
   단일 소스: CSS 변수(--c0..--c6, --chart-*)를 읽는다.
   라이트/다크 팔레트는 style.css에서만 관리. */
const PALETTE_SIZE = 7;

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function getPalette() {
  const colors = [];
  for (let i = 0; i < PALETTE_SIZE; i++) {
    colors.push(cssVar('--c' + i, '#888888'));
  }
  return {
    bg:          cssVar('--chart-bg', '#ffffff'),
    grid:        cssVar('--chart-grid', '#e8e7e5'),
    axis:        cssVar('--chart-axis', '#a8a29e'),
    axisLabel:   cssVar('--chart-text', '#57534e'),
    tooltip:     cssVar('--chart-tooltip', '#ffffff'),
    tooltipBdr:  cssVar('--chart-tooltip-border', '#d6d3d1'),
    tooltipText: cssVar('--chart-tooltip-text', '#1c1917'),
    colors,
  };
}

/* ---- 추정/계획 시리즈 자동 스타일 규칙 ----
   시리즈 이름에 '계획'/'추정'/'가이던스'/'전망'/'예상'/'(E)' 포함 시
   점선 + 낮은 불투명도로 자동 렌더 (데이터 파일 수정 불필요). */
const ESTIMATE_RE = /계획|추정|가이던스|전망|예상|\(E\)/;

function isEstimateSeries(name) {
  return ESTIMATE_RE.test(name || '');
}

/* ---- Registry of ECharts instances ---- */
const chartInstances = new Map();  // id → echarts instance
const chartDataCache = new Map();  // id → parsed chart data

/* =========================================================
   투 뷰 (데일리 | 전체)
   - 데일리 = 아침 검증 세트: 스냅샷 → 이선엽 체인 → 밸류밴드 → 스프레드.
     섹션/접이식 없이 세로 나열 (#daily-view로 카드 DOM 이동).
   - 전체 = 기존 접이식 섹션 그대로.
   - 데일리 세트 = index.json daily 시드 + ⭐ localStorage 오버라이드 병합.
   ========================================================= */
const VIEW_KEY = 'chartbook_view';                       // 'daily' | 'full'
const DAILY_OVERRIDES_KEY = 'chartbook_daily_overrides'; // {id: true/false}
const DAILY_FIRST_SECTION = '이선엽 체인';               // 데일리 정렬: 체인 먼저

let chartMetas = [];          // index.json charts 배열 (원본 순서)
const dailySeed = new Map();  // chartId → index.json daily 시드
const cardSlots = new Map();  // chartId → 원위치 마커 (전체 뷰 복귀용)

let dailyOverrides = (() => {
  try { return JSON.parse(localStorage.getItem(DAILY_OVERRIDES_KEY)) || {}; }
  catch { return {}; }
})();

function saveDailyOverrides() {
  try { localStorage.setItem(DAILY_OVERRIDES_KEY, JSON.stringify(dailyOverrides)); }
  catch { /* private mode 등 — 무시 */ }
}

function getView() {
  return localStorage.getItem(VIEW_KEY) === 'full' ? 'full' : 'daily';  // 기본 = 데일리
}

function isDailyChart(id) {
  if (Object.prototype.hasOwnProperty.call(dailyOverrides, id)) return !!dailyOverrides[id];
  return !!dailySeed.get(id);
}

/* 데일리 표시 순서 = 매일 판단하는 논리체인 순서.
   index.json의 dailyOrder 시드(run.py chart_meta)로 정렬:
     C1(ls_rate_peak, yield_spread) → C2(sp500, vix) → C3(ls_memory_cycle)
     → C4(ls_semi_vs_power) → C5(ls_taiwan_hedge) → 기타(ship/move/wti).
   dailyOrder 없는 차트(사용자 ⭐ 추가분 등)는 그 뒤에 index 순서.
   구버전 index.json(dailyOrder 없음)은 기존 규칙(체인 섹션 먼저)으로 폴백. */
function dailyChartIds() {
  const ordered = [], rest = [];
  chartMetas.forEach((m) => {
    if (m.type === 'link' || !isDailyChart(m.id)) return;
    (typeof m.dailyOrder === 'number' ? ordered : rest).push(m);
  });
  if (!ordered.length) {
    const chain = [], other = [];
    rest.forEach((m) => (m.section === DAILY_FIRST_SECTION ? chain : other).push(m.id));
    return chain.concat(other);
  }
  ordered.sort((a, b) => a.dailyOrder - b.dailyOrder);
  return ordered.map((m) => m.id).concat(rest.map((m) => m.id));
}

/* ---- Lazy render registry — display:none에서 ECharts init하면 width=0.
       보일 때(ensureRendered) 렌더/리사이즈. 뷰 전환·섹션 펼침 공용. ---- */
const renderFns = new Map();  // chartId → render fn

function isElVisible(el) {
  return !!(el && el.offsetParent !== null);
}

function ensureRendered(chartId) {
  const el = document.getElementById(chartId + '-chart');
  if (!el || !isElVisible(el)) return;
  const inst = chartInstances.get(chartId + '-chart');
  if (inst) { inst.resize(); return; }
  const fn = renderFns.get(chartId);
  if (fn) nextFrame(fn);
}

/* ---- 카드 원위치 마커 — 데일리 뷰로 이동하기 전에 자리 표시 ---- */
function ensureCardSlot(card, id) {
  if (cardSlots.has(id)) return;
  const slot = document.createElement('div');
  slot.className = 'daily-slot';
  slot.style.display = 'none';
  slot.dataset.for = id;
  card.parentNode.insertBefore(slot, card);
  cardSlots.set(id, slot);
}

/* ---- 데일리 컨테이너에 순서 지키며 삽입 (증분 로드 대응) ---- */
function insertDailyCardOrdered(dailyEl, card, id) {
  const order = dailyChartIds();
  const idx = order.indexOf(id);
  let before = null;
  for (const child of dailyEl.children) {
    const cid = (child.id || '').replace(/^card-/, '');
    if (order.indexOf(cid) > idx) { before = child; break; }
  }
  dailyEl.insertBefore(card, before);
}

/* ---- 뷰 적용 — 탭 상태 + 카드 배치 + lazy render ---- */
function applyView(view) {
  try { localStorage.setItem(VIEW_KEY, view); } catch { /* 무시 */ }
  document.body.classList.toggle('view-daily', view === 'daily');
  document.querySelectorAll('.view-tab').forEach((btn) => {
    const on = btn.dataset.view === view;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  const dailyEl = document.getElementById('daily-view');
  if (!dailyEl) return;

  // 1) 데일리 컨테이너의 카드 전부 원위치(슬롯)로 복귀 — 멱등 재배치
  [...dailyEl.children].forEach((card) => {
    const id = (card.id || '').replace(/^card-/, '');
    const slot = cardSlots.get(id);
    if (slot && slot.parentNode) slot.parentNode.insertBefore(card, slot);
    else card.remove();  // 슬롯 소실 방어 (정상 흐름에선 없음)
  });

  if (view === 'daily') {
    // 2) 현재 데일리 세트를 검증 순서대로 이동
    dailyChartIds().forEach((id) => {
      const card = document.getElementById('card-' + id);
      if (!card) return;  // not-ready placeholder 등 — 스킵
      ensureCardSlot(card, id);
      dailyEl.appendChild(card);
    });
    nextFrame(() => dailyChartIds().forEach(ensureRendered));
  } else {
    // 전체 뷰 — 펼쳐진 섹션 차트 lazy-init + 폭 보정
    nextFrame(() => {
      chartMetas.forEach((m) => { if (m.type !== 'link') ensureRendered(m.id); });
    });
  }
}

/* ---- ⭐ 데일리 포함/제외 토글 ---- */
function updateStarButton(id) {
  const btn = document.querySelector(`.daily-star[data-chart-id="${CSS.escape(id)}"]`);
  if (!btn) return;
  const on = isDailyChart(id);
  btn.classList.toggle('active', on);
  btn.textContent = on ? '★' : '☆';
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? '데일리 뷰에서 제외' : '데일리 뷰에 추가';
}

function toggleDailyStar(id) {
  const next = !isDailyChart(id);
  // 시드와 같아지면 오버라이드 삭제 (저장소 청결 유지)
  if (!!dailySeed.get(id) === next) delete dailyOverrides[id];
  else dailyOverrides[id] = next;
  saveDailyOverrides();
  updateStarButton(id);
  if (getView() === 'daily') applyView('daily');  // 세트 변경 즉시 반영
}

/* ---- rAF + setTimeout 레이스 — 숨겨진 탭에서는 rAF가 영원히 안 불림
       (백그라운드 탭으로 열어두는 아침 사용 패턴 대응). 둘 중 먼저 온 쪽 1회 실행 ---- */
function nextFrame(fn) {
  let done = false;
  const runOnce = () => { if (!done) { done = true; fn(); } };
  requestAnimationFrame(runOnce);
  setTimeout(runOnce, 60);
}

/* ---- Utility: format date ---- */
function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return iso; }
}

/* ---- Utility: escape HTML (data 문자열에 <, > 포함 가능) ---- */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ---- Utility: note 분해 — 논지(캡션) vs 각주([출처]/[한계]/[주의] 등) ----
   note 형식: "[C1 금리 정점] 논지 ... → 행동: ... [한계] ... [출처] ..."
   - note 맨 앞의 체인 태그([C숫자.../P숫자...] — framework §2 체인 ID)는
     각주 마커가 아니라 논지의 일부로 유지
   - 대괄호 마커 앞의 리드 텍스트 = 논지 캡션 (차트 아래 콜아웃)
   - [라벨] 이후 각 구간 = 각주 라인 (작게, footnote)
   - 마커가 없으면 note 전체를 논지 캡션으로 취급 */
function splitNote(note) {
  if (!note) return { thesis: '', footnotes: [] };
  const stripThesisLabel = (s) => {
    const m = s.match(/^\s*논지\s*[::]\s*([\s\S]*)$/);
    return m ? m[1].trim() : s.trim();
  };
  // 선두 체인 태그 분리 (예: "[C1 금리 정점]", "[C8 조선·방산]")
  let chainTag = '';
  const tagMatch = note.match(/^\s*\[([CP]\d[^\]\n]{0,18})\]\s*/);
  if (tagMatch) {
    chainTag = `[${tagMatch[1]}] `;
    note = note.slice(tagMatch[0].length);
  }
  const markerRe = /\[([^\]\n]{1,20})\]\s*/g;
  const markers = [...note.matchAll(markerRe)];
  if (!markers.length) {
    return { thesis: chainTag + stripThesisLabel(note), footnotes: [] };
  }
  const thesis = chainTag + stripThesisLabel(note.slice(0, markers[0].index));
  const footnotes = markers.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < markers.length ? markers[i + 1].index : note.length;
    return { label: m[1], text: note.slice(start, end).trim() };
  });
  return { thesis, footnotes };
}

/* ---- Utility: format number for tooltip ---- */
function fmtNum(v, unit) {
  if (v === null || v === undefined) return '—';
  if (unit === '%') return v.toFixed(2) + '%';
  if (unit === 'x')  return v.toFixed(1) + 'x';
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/* ---- Detect a "spread" timeseries that benefits from a zero reference line ---- */
function isSpreadChart(chartData) {
  if (!chartData || chartData.unit !== '%') return false;
  if (chartData.id === 'yield_spread') return true;
  // single series whose name looks like a spread (e.g. "10Y-3M", "스프레드")
  if (chartData.series && chartData.series.length === 1) {
    const n = (chartData.series[0].name || '');
    if (/-|spread|스프레드/i.test(n)) return true;
  }
  return false;
}

/* ---- Build ECharts option for a timeseries chart ---- */
function buildTimeseriesOption(chartData) {
  const p = getPalette();
  const { series, unit } = chartData;
  const showZeroLine = isSpreadChart(chartData);
  // 숫자 x축 지원: 최상위 "xAxisType": "value" 이면 time 대신 value 축
  // (예: megaprojects — x = 시작 후 경과 연차). 필드 없으면 기존 time 축.
  const isValueX = chartData.xAxisType === 'value';
  const xAxisName = chartData.xAxisName || '';

  // 이중축 지원: 시리즈별 yAxis(0|1) + 최상위 unit2(우측 보조축 라벨). CONTRACT 참조.
  const hasDualAxis = (series || []).some((s) => s.yAxis === 1);
  // 커스텀 기준선: 최상위 markLines [{value, label, axis}] (예: ls_rate_peak 4.85 CTA선)
  const customMarks = (chartData.markLines || []).filter((m) => typeof m.value === 'number');

  const echartsSeries = (series || []).map((s, i) => {
    const est = isEstimateSeries(s.name);
    const color = p.colors[i % p.colors.length];
    return {
    name: s.name,
    type: 'line',
    yAxisIndex: hasDualAxis && s.yAxis === 1 ? 1 : 0,
    data: (s.data || []).map(([x, val]) => [x, val]),
    smooth: false,
    symbol: 'none',
    lineStyle: {
      width: 1.5,
      color,
      type: est ? 'dashed' : 'solid',
      opacity: est ? 0.65 : 1,
    },
    itemStyle: {
      color,
      opacity: est ? 0.65 : 1,
    },
    emphasis: { disabled: false },
    // Horizontal reference lines: spread zero-line + CONTRACT markLines(값 기준선).
    // 각 기준선은 자기 axis(0|1)와 같은 축의 첫 시리즈에 붙인다.
    ...(() => {
      const myAxis = hasDualAxis && s.yAxis === 1 ? 1 : 0;
      const firstOfAxis = (series || []).findIndex(
        (x) => (hasDualAxis && x.yAxis === 1 ? 1 : 0) === myAxis
      ) === i;
      const marks = [];
      if (showZeroLine && i === 0) {
        marks.push({ yAxis: 0, label: { formatter: '0% (역전선)' } });
      }
      if (firstOfAxis) {
        customMarks
          .filter((m) => (m.axis || 0) === myAxis)
          .forEach((m) => marks.push({
            yAxis: m.value,
            label: { formatter: m.label ? `${m.label} ${m.value}` : String(m.value) },
            lineStyle: { color: p.colors[6] || '#b91c1c', type: 'dashed', width: 1.2 },
          }));
      }
      if (!marks.length) return {};
      return {
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: p.axis, type: 'dashed', width: 1 },
          label: {
            show: true,
            position: 'insideEndTop',
            color: p.axisLabel,
            fontSize: 9,
          },
          data: marks,
        },
      };
    })(),
    };
  });

  return {
    backgroundColor: p.bg,
    animation: true,
    animationDuration: 400,
    color: p.colors,
    grid: {
      top: 16,
      right: 20,
      bottom: isValueX && xAxisName ? 44 : 28,   // extra room for x-axis name
      left: 62,
      containLabel: false,
    },
    xAxis: {
      type: isValueX ? 'value' : 'time',
      ...(isValueX && xAxisName ? {
        name: xAxisName,
        nameLocation: 'middle',
        nameGap: 26,
        nameTextStyle: { color: p.axisLabel, fontSize: 10 },
      } : {}),
      axisLine: { lineStyle: { color: p.grid } },
      axisTick: { lineStyle: { color: p.grid } },
      axisLabel: {
        color: p.axisLabel,
        fontSize: 10,
        formatter: isValueX
          ? (val) => String(val)
          : (val) => {
              const d = new Date(val);
              return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
            },
      },
      splitLine: { show: false },
    },
    yAxis: (() => {
      const axisBase = (name) => ({
        type: 'value',
        name: name || '',
        scale: true,   // 데이터 범위에 맞게 자동 스케일 (0 강제 시작 X)
        nameTextStyle: {
          color: p.axisLabel,
          fontSize: 10,
          padding: [0, 0, 0, 0],
        },
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: p.axisLabel,
          fontSize: 10,
          formatter: (val) => {
            if (Math.abs(val) >= 1000) return (val/1000).toFixed(1) + 'k';
            return val;
          },
        },
        splitLine: { lineStyle: { color: p.grid, type: 'solid', width: 1 } },
      });
      if (!hasDualAxis) return axisBase(unit);
      const right = axisBase(chartData.unit2);
      right.splitLine = { show: false };  // 보조축 격자 생략(겹침 방지)
      return [axisBase(unit), right];
    })(),
    legend: (series || []).length > 1 ? {
      top: 0,
      right: 0,
      textStyle: { color: p.axisLabel, fontSize: 10 },
      itemWidth: 16,
      itemHeight: 2,
      icon: 'rect',
    } : { show: false },
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'cross',
        crossStyle: { color: p.axis, width: 1 },
        lineStyle: { color: p.axis, width: 1, type: 'dashed' },
      },
      backgroundColor: p.tooltip,
      borderColor: p.tooltipBdr,
      borderWidth: 1,
      textStyle: { color: p.tooltipText, fontSize: 11 },
      padding: [8, 12],
      formatter(params) {
        if (!params || !params.length) return '';
        let head;
        if (isValueX) {
          head = xAxisName ? `${xAxisName} ${params[0].axisValue}` : String(params[0].axisValue);
        } else {
          const date = new Date(params[0].axisValue);
          head = date.toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });
        }
        let html = `<div style="margin-bottom:4px;font-size:10px;opacity:.7">${head}</div>`;
        params.forEach(p2 => {
          const val = p2.value[1];
          const dot = `<span style="display:inline-block;width:8px;height:2px;background:${p2.color};margin-right:5px;vertical-align:middle;border-radius:1px"></span>`;
          html += `<div style="display:flex;justify-content:space-between;gap:16px">
            <span>${dot}${p2.seriesName}</span>
            <span style="font-weight:600">${fmtNum(val, unit)}</span>
          </div>`;
        });
        return html;
      },
    },
    // 슬라이더 줌 바 제거 — inside 줌만 유지 (Ctrl/Cmd+휠 줌, 드래그 팬.
    // 일반 휠은 페이지 스크롤에 양보)
    dataZoom: [
      {
        type: 'inside',
        zoomOnMouseWheel: 'ctrl',
        moveOnMouseWheel: false,
        moveOnMouseMove: true,
      },
    ],
    series: echartsSeries,
  };
}

/* ---- Render a timeseries chart card ---- */
function renderTimeseries(containerId, chartData) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Destroy old instance if re-rendering
  if (chartInstances.has(containerId)) {
    chartInstances.get(containerId).dispose();
  }

  const chart = echarts.init(container, null, { renderer: 'canvas' });
  chart.setOption(buildTimeseriesOption(chartData));
  chartInstances.set(containerId, chart);
}

/* ---- Build ECharts option for a curve_snapshot (yield curve) ---- */
function buildCurveSnapshotOption(chartData) {
  const p = getPalette();
  const { maturities, snapshots, unit } = chartData;

  // Map each snapshot's data onto the category axis order
  const echartsSeries = snapshots.map((snap, i) => {
    const byMat = {};
    (snap.data || []).forEach(([mat, val]) => { byMat[mat] = val; });
    const data = maturities.map(mat => (mat in byMat ? byMat[mat] : null));
    const est = isEstimateSeries(snap.label);
    const color = p.colors[i % p.colors.length];
    return {
      name: snap.label,
      type: 'line',
      data,
      smooth: 0.3,
      symbol: 'circle',
      symbolSize: 6,
      connectNulls: true,
      lineStyle: { width: 2, color, type: est ? 'dashed' : 'solid', opacity: est ? 0.65 : 1 },
      itemStyle: { color, opacity: est ? 0.65 : 1 },
      emphasis: { focus: 'series' },
    };
  });

  return {
    backgroundColor: p.bg,
    animation: true,
    animationDuration: 400,
    color: p.colors,
    grid: { top: 20, right: 24, bottom: 36, left: 56, containLabel: false },
    xAxis: {
      type: 'category',
      data: maturities,
      boundaryGap: false,
      axisLine: { lineStyle: { color: p.grid } },
      axisTick: { alignWithLabel: true, lineStyle: { color: p.grid } },
      axisLabel: { color: p.axisLabel, fontSize: 11 },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      name: unit || '',
      scale: true,
      nameTextStyle: { color: p.axisLabel, fontSize: 10 },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: p.axisLabel,
        fontSize: 10,
        formatter: (val) => val.toFixed(1),
      },
      splitLine: { lineStyle: { color: p.grid, type: 'solid', width: 1 } },
    },
    legend: {
      top: 0,
      right: 0,
      textStyle: { color: p.axisLabel, fontSize: 10 },
      itemWidth: 16,
      itemHeight: 2,
      icon: 'rect',
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: p.axis, width: 1, type: 'dashed' } },
      backgroundColor: p.tooltip,
      borderColor: p.tooltipBdr,
      borderWidth: 1,
      textStyle: { color: p.tooltipText, fontSize: 11 },
      padding: [8, 12],
      formatter(params) {
        if (!params || !params.length) return '';
        const mat = params[0].axisValue;
        let html = `<div style="margin-bottom:4px;font-size:10px;opacity:.7">만기 ${mat}</div>`;
        params.forEach(p2 => {
          if (p2.value === null || p2.value === undefined) return;
          const dot = `<span style="display:inline-block;width:8px;height:2px;background:${p2.color};margin-right:5px;vertical-align:middle;border-radius:1px"></span>`;
          html += `<div style="display:flex;justify-content:space-between;gap:16px">
            <span>${dot}${p2.seriesName}</span>
            <span style="font-weight:600">${fmtNum(p2.value, unit)}</span>
          </div>`;
        });
        return html;
      },
    },
    series: echartsSeries,
  };
}

/* ---- Render a curve_snapshot chart card ---- */
function renderCurveSnapshot(containerId, chartData) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (chartInstances.has(containerId)) {
    chartInstances.get(containerId).dispose();
  }

  const chart = echarts.init(container, null, { renderer: 'canvas' });
  chart.setOption(buildCurveSnapshotOption(chartData));
  chartInstances.set(containerId, chart);
}

/* ---- Build heatmap cell background colour ---- */
function heatColor(val) {
  const abs = Math.abs(val);
  // clamp intensity: 0–1 scaled to ±5%
  const intensity = Math.min(abs / 5.0, 1.0);
  const dark = getTheme() === 'dark';

  if (val === 0) {
    return {
      bg: dark ? '#292524' : '#f5f5f5',
      text: dark ? '#a8a29e' : '#44403c',
    };
  }

  if (val > 0) {
    // green spectrum
    if (dark) {
      // dark: muted greens
      const r = Math.round(20 - intensity * 5);
      const g = Math.round(80 + intensity * 83);
      const b = Math.round(44);
      return {
        bg: `rgba(${r}, ${g}, ${b}, ${0.25 + intensity * 0.55})`,
        text: intensity > 0.4 ? '#86efac' : '#4ade80',
      };
    } else {
      const r = Math.round(187 - intensity * 170);
      const g = Math.round(247 - intensity * 80);
      const b = Math.round(208 - intensity * 180);
      return {
        bg: `rgb(${r}, ${g}, ${b})`,
        text: intensity > 0.5 ? '#14532d' : '#166534',
      };
    }
  } else {
    // red spectrum
    if (dark) {
      const r = Math.round(150 + intensity * 100);
      const g = Math.round(30);
      const b = Math.round(30);
      return {
        bg: `rgba(${r}, ${g}, ${b}, ${0.25 + intensity * 0.55})`,
        text: intensity > 0.4 ? '#fca5a5' : '#f87171',
      };
    } else {
      const r = Math.round(254 - intensity * 8);
      const g = Math.round(202 - intensity * 170);
      const b = Math.round(202 - intensity * 170);
      return {
        bg: `rgb(${r}, ${g}, ${b})`,
        text: intensity > 0.5 ? '#7f1d1d' : '#991b1b',
      };
    }
  }
}

/* ---- Render the sector performance table ---- */
function renderHeatmapPerf(containerId, chartData) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const { periods, items } = chartData;

  let html = `<div class="sector-table-wrapper">
    <table class="sector-table">
      <thead>
        <tr>
          <th>섹터</th>
          <th>티커</th>
          ${periods.map(p => `<th>${p}</th>`).join('')}
        </tr>
      </thead>
      <tbody>`;

  items.forEach(item => {
    html += `<tr>
      <td>${item.name}</td>
      <td style="color:var(--text-muted)">${item.ticker}</td>`;

    periods.forEach(period => {
      const val = item.perf[period];
      if (val === undefined || val === null) {
        html += `<td><span class="heat-cell" style="background:var(--ph-bg);color:var(--text-muted)">—</span></td>`;
      } else {
        const { bg, text } = heatColor(val);
        const sign = val > 0 ? '+' : '';
        html += `<td><span class="heat-cell" style="background:${bg};color:${text}">${sign}${val.toFixed(1)}%</span></td>`;
      }
    });

    html += '</tr>';
  });

  html += `</tbody></table></div>`;
  container.innerHTML = html;
}

/* ---- Refresh all ECharts (theme toggle) ---- */
function refreshAllCharts() {
  // Re-render ECharts + tables with the new palette.
  // chartDataCache is keyed by chart id; ECharts instances are keyed by
  // container id ("<id>-chart"), tables live under "<id>-body".
  chartDataCache.forEach((data, id) => {
    if (data.type === 'timeseries') {
      const inst = chartInstances.get(id + '-chart');
      if (inst) inst.setOption(buildTimeseriesOption(data), true);
    } else if (data.type === 'curve_snapshot') {
      const inst = chartInstances.get(id + '-chart');
      if (inst) inst.setOption(buildCurveSnapshotOption(data), true);
    } else if (data.type === 'heatmap_perf') {
      renderHeatmapPerf(id + '-body', data);
    }
  });
}

/* ---- Section content containers (so cards group under their section
       regardless of their position in index.charts) ---- */
const sectionBodies = new Map();   // sectionName → content container element
const sectionHeaders = new Map();  // sectionName → header element

/* ---- Collapsible sections — 접힘 상태 (localStorage 기억) ----
   기본값: "이선엽 체인"만 펼침, 나머지 접힘 ("아침 10초 확인" 구조).
   접힌 섹션(display:none)의 차트는 renderFns에 등록만 하고
   펼칠 때 ensureRendered로 lazy-init한다 (데일리 뷰 이동 시에도 공용). */
const SECTIONS_KEY = 'chartbook_sections_v1';
const DEFAULT_EXPANDED = new Set(['이선엽 체인']);

let sectionState = (() => {
  try { return JSON.parse(localStorage.getItem(SECTIONS_KEY)) || {}; }
  catch { return {}; }
})();

function saveSectionState() {
  try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(sectionState)); }
  catch { /* private mode 등 — 무시 */ }
}

function isSectionExpanded(name) {
  return name in sectionState ? !!sectionState[name] : DEFAULT_EXPANDED.has(name);
}

function expandSection(name) {
  const body = sectionBodies.get(name);
  const header = sectionHeaders.get(name);
  if (!body) return;
  body.classList.remove('collapsed');
  if (header) header.classList.remove('collapsed');
  sectionState[name] = 1;
  saveSectionState();
  // 접힌 채로 대기하던 차트 lazy-init + 이미 그려진 차트 폭 보정
  nextFrame(() => {
    body.querySelectorAll('.chart-card').forEach(card => {
      const id = (card.id || '').replace(/^card-/, '');
      if (id) ensureRendered(id);
    });
  });
}

function collapseSection(name) {
  const body = sectionBodies.get(name);
  const header = sectionHeaders.get(name);
  if (!body) return;
  body.classList.add('collapsed');
  if (header) header.classList.add('collapsed');
  sectionState[name] = 0;
  saveSectionState();
}

function toggleSection(name) {
  const body = sectionBodies.get(name);
  if (!body) return;
  if (body.classList.contains('collapsed')) expandSection(name);
  else collapseSection(name);
}

/* ---- Create section header + content container, return the container ---- */
function ensureSection(sectionName, container) {
  if (sectionBodies.has(sectionName)) return sectionBodies.get(sectionName);
  const sectionId = 'section-' + sectionName.replace(/\s+/g, '-');
  const num = String(sectionBodies.size + 1).padStart(2, '0');
  const header = document.createElement('div');
  header.className = 'section-header collapsible';
  header.id = sectionId;
  // 버블 체크리스트 섹션 헤더 = "정점 근접도 n/5" 종합 배지 (bubble_checklist.json)
  let sectionBadge = '';
  if (sectionName === BUBBLE_SECTION && bubbleOverall) {
    const st = bubbleOverall.red >= 2 ? 'alert'
      : (bubbleOverall.red === 1 || bubbleOverall.warn >= 2 ? 'warn' : 'good');
    const naTxt = bubbleOverall.judged < bubbleOverall.total
      ? ` · 판정가능 ${bubbleOverall.judged}/${bubbleOverall.total}` : '';
    sectionBadge = `<span class="section-badge state-${st}">${escapeHtml(bubbleOverall.label || '')}${naTxt}</span>`;
  }
  header.innerHTML = `<span class="section-num">${num}</span><span class="section-label">${escapeHtml(sectionName)}</span>${sectionBadge}<div class="section-line"></div><span class="section-chevron" aria-hidden="true">▾</span>`;
  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');
  header.setAttribute('aria-label', `${sectionName} 섹션 접기/펼치기`);
  header.addEventListener('click', () => toggleSection(sectionName));
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection(sectionName); }
  });
  container.appendChild(header);
  const body = document.createElement('div');
  body.className = 'section-body';
  container.appendChild(body);
  if (!isSectionExpanded(sectionName)) {
    body.classList.add('collapsed');
    header.classList.add('collapsed');
  }
  sectionBodies.set(sectionName, body);
  sectionHeaders.set(sectionName, header);
  return body;
}

/* ---- 버블 체크리스트 판정 (data/bubble_checklist.json) ----
   버블 정점 5지표 자동판정 (김성환 '버블 템플릿'). 파이프라인 build_bubble()이
   생성. 차트 카드 제목 옆 🟢/🟡/🔴 배지 + '버블 체크리스트' 섹션 헤더에
   "정점 근접도 n/5" 종합 배지. 파일 없으면 배지 없이 렌더 (차트는 정상). */
const BUBBLE_STATE_LABEL = { good: '정상', warn: '주의', alert: '정점 근접', na: '판정 불가' };
const BUBBLE_SECTION = '버블 체크리스트';
let bubbleOverall = null;          // {red, warn, judged, total, label}
const bubbleByChart = new Map();   // chart id → item {state, emoji, caption, ...}

async function loadBubbleChecklist() {
  try {
    const resp = await fetch('../data/bubble_checklist.json', { cache: 'no-store' });
    if (!resp.ok) return;
    const bb = await resp.json();
    bubbleOverall = (bb && bb.overall) || null;
    ((bb && bb.items) || []).forEach((it) => {
      if (it && it.chart) bubbleByChart.set(it.chart, it);
    });
  } catch (e) {
    console.warn('bubble_checklist.json 로드 실패 (판정 배지 생략):', e);
  }
}

function bubbleState(state) {
  return ['good', 'warn', 'alert', 'na'].includes(state) ? state : 'na';
}

function bubbleBadgeHtml(item) {
  const state = bubbleState(item.state);
  const label = BUBBLE_STATE_LABEL[state] || '';
  return `<span class="bubble-badge state-${state}" title="${escapeHtml(item.caption || '')}">` +
         `${item.emoji || ''} ${escapeHtml(label)}</span>`;
}

/* ---- Snapshot board — "아침 10초 확인" 카드 (data/snapshot.json) ---- */
const SNAP_STATE_LABEL = { good: '양호', warn: '주의', alert: '경보', neutral: '' };

function fmtSnapValue(v) {
  if (v === null || v === undefined) return '—';
  if (Number.isInteger(v)) return String(v);  // 카운트류(버블 n/5, 로테이션 n주)는 소수점 없이
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (Math.abs(v) >= 100) return v.toFixed(1);
  return v.toFixed(2);
}

function snapCardHtml(card) {
  const state = ['good', 'warn', 'alert', 'neutral'].includes(card.state) ? card.state : 'neutral';
  const badgeText = card.badge || SNAP_STATE_LABEL[state];
  const badge = badgeText
    ? `<span class="snap-badge state-${state}">${escapeHtml(badgeText)}</span>`
    : '';
  let d1Html = '';
  if (typeof card.d1 === 'number') {
    const dir = card.d1 > 0 ? 'up' : (card.d1 < 0 ? 'down' : 'flat');
    const arrow = card.d1 > 0 ? '▲' : (card.d1 < 0 ? '▼' : '＝');
    d1Html = `<span class="snap-d1 ${dir}">${arrow} ${Math.abs(card.d1).toFixed(2)}%</span>`;
  }
  return `
    <div class="snap-card state-${state}" data-link="${escapeHtml(card.link || '')}" role="button" tabindex="0"
         aria-label="${escapeHtml(card.label)} — 해당 차트로 이동">
      <div class="snap-top">
        <span class="snap-label">${escapeHtml(card.label)}</span>
        ${badge}
      </div>
      <div class="snap-value-row">
        <span class="snap-value">${fmtSnapValue(card.value)}${card.unit ? `<span class="snap-unit">${escapeHtml(card.unit)}</span>` : ''}</span>
        ${d1Html}
      </div>
      ${card.caption ? `<div class="snap-caption">${escapeHtml(card.caption)}</div>` : ''}
    </div>`;
}

/* 스냅샷 카드 클릭 → (접힌 섹션이면 펼치고) 해당 차트로 스크롤 + 하이라이트.
   데일리 뷰에서 타깃이 데일리 세트 밖이면 전체 뷰로 전환 후 이동. */
function gotoChartAnchor(link) {
  if (!link) return;
  const target = document.querySelector(link);
  if (!target) return;
  const dailyEl = document.getElementById('daily-view');
  if (document.body.classList.contains('view-daily') &&
      !(dailyEl && dailyEl.contains(target))) {
    applyView('full');
  }
  if (!document.body.classList.contains('view-daily')) {
    // 카드가 속한 섹션 찾기 → 접혀 있으면 펼침 (전체 뷰에서만 의미)
    for (const [name, body] of sectionBodies) {
      if (body.contains(target)) {
        if (body.classList.contains('collapsed')) expandSection(name);
        break;
      }
    }
  }
  nextFrame(() => {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('anchor-highlight');
    setTimeout(() => target.classList.remove('anchor-highlight'), 2000);
  });
}

async function renderSnapshotBoard() {
  const board = document.getElementById('snapshot-board');
  if (!board) return;
  let snap;
  try {
    const resp = await fetch('../data/snapshot.json', { cache: 'no-store' });
    if (!resp.ok) return;  // snapshot 없음 → 보드 숨김(빈 컨테이너)
    snap = await resp.json();
  } catch (e) {
    console.warn('snapshot.json 로드 실패 (보드 생략):', e);
    return;
  }
  const cards = (snap && snap.cards) || [];
  if (!cards.length) return;
  board.innerHTML = cards.map(snapCardHtml).join('');
  board.classList.add('has-cards');
  board.querySelectorAll('.snap-card').forEach(el => {
    const link = el.getAttribute('data-link');
    if (!link) return;
    el.addEventListener('click', () => gotoChartAnchor(link));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); gotoChartAnchor(link); }
    });
  });
}

/* ---- 📅 이번 주 캘린더 카드 (data/calendar.json) ----
   아침 검증 ⑥ "오늘/이번 주 촉매가 뭔가" — 지표/실적/회의 이벤트를
   날짜별 그룹 + D-day 배지(오늘=🔴, 내일=🟡)로 표시.
   파일 없으면 카드 숨김, 이벤트 0개면 "이번 주 주요 촉매 없음". ---- */
const CAL_TYPE_ICON = { '지표': '📊', '실적': '💰', '회의': '🏛️' };
const WEEKDAYS_KO = ['일', '월', '화', '수', '목', '금', '토'];

function calDayDiff(isoDate) {
  // 'YYYY-MM-DD' → 사용자 로컬 자정 기준 오늘과의 일수 차
  const [y, m, d] = isoDate.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}

function calDdayBadge(diff) {
  if (diff === 0) return '<span class="cal-dday today">🔴 오늘</span>';
  if (diff === 1) return '<span class="cal-dday tomorrow">🟡 내일</span>';
  return `<span class="cal-dday">D-${diff}</span>`;
}

function calEventHtml(ev) {
  const icon = CAL_TYPE_ICON[ev.type] || '·';
  const imp = ev.importance === 'high' ? ' imp-high' : '';
  const ticker = ev.ticker ? `<span class="cal-ticker">${escapeHtml(ev.ticker)}</span>` : '';
  return `<span class="cal-ev${imp}" title="${escapeHtml(ev.type)}">` +
         `<span class="cal-ev-icon" aria-hidden="true">${icon}</span>` +
         `${escapeHtml(ev.label)}${ticker}</span>`;
}

async function renderCalendarCard() {
  const el = document.getElementById('calendar-card');
  if (!el) return;
  let cal;
  try {
    const resp = await fetch('../data/calendar.json', { cache: 'no-store' });
    if (!resp.ok) return;  // calendar 없음 → 카드 숨김
    cal = await resp.json();
  } catch (e) {
    console.warn('calendar.json 로드 실패 (카드 생략):', e);
    return;
  }

  // 날짜별 그룹 (과거 이벤트는 파이프라인이 이미 제외하지만 방어적으로 한 번 더)
  const events = (cal.events || []).filter(ev => ev.date && calDayDiff(ev.date) >= 0);
  const byDate = new Map();
  events.forEach(ev => {
    if (!byDate.has(ev.date)) byDate.set(ev.date, []);
    byDate.get(ev.date).push(ev);
  });

  let bodyHtml;
  if (!byDate.size) {
    bodyHtml = '<div class="cal-empty">이번 주 주요 촉매 없음</div>';
  } else {
    bodyHtml = [...byDate.keys()].sort().map(dateStr => {
      const diff = calDayDiff(dateStr);
      const [y, m, d] = dateStr.split('-').map(Number);
      const wd = WEEKDAYS_KO[new Date(y, m - 1, d).getDay()];
      const rowCls = diff === 0 ? ' is-today' : (diff === 1 ? ' is-tomorrow' : '');
      return `<div class="cal-day${rowCls}">
        <div class="cal-date">${calDdayBadge(diff)}<span class="cal-date-label">${m}/${d} (${wd})</span></div>
        <div class="cal-events">${byDate.get(dateStr).map(calEventHtml).join('')}</div>
      </div>`;
    }).join('');
  }

  el.innerHTML = `
    <div class="cal-head">
      <span class="cal-title">📅 이번 주</span>
      <span class="cal-legend">🏛️ 회의 · 📊 지표 · 💰 실적</span>
      <span class="cal-range">+14일</span>
    </div>
    ${bodyHtml}`;
  el.classList.add('has-data');
}

/* ---- Create chart card DOM ---- */
function createChartCard(meta, chartData) {
  const card = document.createElement('div');
  card.className = 'chart-card';
  card.id = 'card-' + meta.id;   // 스냅샷 보드/앵커 링크 타깃

  const title = chartData?.title || meta.id;
  const subtitle = chartData?.subtitle || '';
  const source = chartData?.source || '';
  const updated = chartData?.updated || '';
  const note = chartData?.note || '';

  let bodyHtml;
  if (meta.type === 'timeseries' || meta.type === 'curve_snapshot') {
    bodyHtml = `<div class="chart-body" id="${meta.id}-chart"></div>`;
  } else if (meta.type === 'heatmap_perf') {
    bodyHtml = `<div id="${meta.id}-body"></div>`;
  } else {
    bodyHtml = '<div style="padding:8px;color:var(--text-muted)">Unknown chart type</div>';
  }

  // note → 논지 캡션(콜아웃) + 각주(footnote) 분리
  const { thesis, footnotes } = splitNote(note);

  const footerParts = [];
  if (source) footerParts.push(`<span class="chart-source">Source: ${escapeHtml(source)}</span>`);
  if (updated) footerParts.push(`<span class="chart-updated">Updated: ${fmtDate(updated)}</span>`);

  const footnoteHtml = footnotes.length
    ? `<div class="chart-footnote">${footnotes.map(f =>
        `<div class="fn-line"><span class="fn-label">${escapeHtml(f.label)}</span>${escapeHtml(f.text)}</div>`
      ).join('')}</div>`
    : '';

  // 버블 체크리스트 지표면 제목 옆 판정 배지 (툴팁 = 판정 근거 캡션)
  const bubbleItem = bubbleByChart.get(meta.id);
  const bubbleBadge = bubbleItem ? bubbleBadgeHtml(bubbleItem) : '';

  const dailyOn = isDailyChart(meta.id);
  card.innerHTML = `
    <button class="daily-star${dailyOn ? ' active' : ''}" data-chart-id="${escapeHtml(meta.id)}"
            aria-pressed="${dailyOn ? 'true' : 'false'}"
            title="${dailyOn ? '데일리 뷰에서 제외' : '데일리 뷰에 추가'}">${dailyOn ? '★' : '☆'}</button>
    <div class="chart-header">
      <div class="chart-title">${escapeHtml(title)}${bubbleBadge}</div>
      ${subtitle ? `<div class="chart-subtitle">${escapeHtml(subtitle)}</div>` : ''}
    </div>
    ${bodyHtml}
    ${thesis ? `<div class="chart-thesis"><span class="thesis-label">논지</span>${escapeHtml(thesis)}</div>` : ''}
    <div class="chart-footer">
      ${footerParts.join('')}
    </div>
    ${footnoteHtml}
  `;

  const starBtn = card.querySelector('.daily-star');
  if (starBtn) {
    starBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDailyStar(meta.id);
    });
  }

  return card;
}

/* ---- Create external-link card (type: "link") ---- */
function createLinkCard(meta) {
  const card = document.createElement('div');
  card.className = 'link-card';

  const title    = meta.title    || meta.id;
  const subtitle = meta.subtitle || '';
  const source   = meta.source   || '';
  const note     = meta.note     || '';
  const url      = meta.url       || '';
  const isLive   = !!meta.live;
  // 웹 배포(GitHub Pages 등)에서는 localhost 딥링크가 죽은 링크 → 클릭/임베드 비활성
  const pageIsLocal = ['localhost', '127.0.0.1', '::1', ''].includes(location.hostname);
  const urlIsLocal  = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url);
  const deadOnWeb   = urlIsLocal && !pageIsLocal;
  const clickable = !!url && !deadOnWeb;

  const badge = isLive
    ? `<span class="link-badge live">LIVE ↗</span>`
    : `<span class="link-badge local">로컬</span>`;

  // Optional live embed preview (only when preview:"embed" + url + live).
  // iframe is scaled-down and pointer-events:none so the whole card stays clickable.
  const showEmbed = meta.preview === 'embed' && url && isLive && !deadOnWeb;
  const embedHtml = showEmbed
    ? `<div class="link-embed">
         <iframe class="link-embed-frame" src="${url}" loading="lazy"
                 tabindex="-1" aria-hidden="true" referrerpolicy="no-referrer"
                 title="${title} 미리보기"></iframe>
       </div>`
    : '';

  card.innerHTML = `
    <div class="link-card-top">
      <div class="link-title">${escapeHtml(title)}</div>
      ${badge}
    </div>
    ${subtitle ? `<div class="link-subtitle">${escapeHtml(subtitle)}</div>` : ''}
    ${embedHtml}
    <div class="link-card-footer">
      ${source ? `<span class="chart-source">${escapeHtml(source)}</span>` : ''}
      ${url ? `<span class="link-url">${escapeHtml(url.replace(/^https?:\/\//, ''))}</span>` : ''}
    </div>
    ${note ? `<div class="chart-note">${escapeHtml(note)}</div>` : ''}
  `;

  if (clickable) {
    card.classList.add('clickable');
    card.setAttribute('role', 'link');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `${title} (새 탭으로 열기)`);
    const open = () => window.open(url, '_blank', 'noopener');
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  } else {
    card.classList.add('disabled');
    if (deadOnWeb) {
      card.setAttribute('title', '로컬 전용 대시보드 — 웹에서는 열 수 없습니다');
      card.style.cursor = 'default';
      card.style.opacity = '0.65';
    }
  }

  return card;
}

/* ---- Create placeholder card ---- */
function createPlaceholderCard(meta) {
  const card = document.createElement('div');
  card.className = 'placeholder-card';
  card.innerHTML = `
    <div class="placeholder-icon">📋</div>
    <div class="placeholder-text">
      <div class="placeholder-title">${meta.id} — 데이터 준비 중</div>
      <div class="placeholder-desc">FRED API 키 필요 · 파이프라인 연결 후 자동 업데이트됩니다</div>
    </div>
  `;
  return card;
}

/* ---- Build section nav links ---- */
function buildNav(sections) {
  const nav = document.getElementById('header-nav');
  if (!nav) return;
  const seen = new Set();
  sections.forEach(s => {
    if (seen.has(s)) return;
    seen.add(s);
    const a = document.createElement('a');
    a.className = 'nav-link';
    a.href = '#section-' + s.replace(/\s+/g, '-');
    a.textContent = s;
    // 접힌 섹션도 미니목차 클릭 시 펼치며 이동 (기본 앵커 스크롤은 그대로 진행)
    a.addEventListener('click', () => expandSection(s));
    nav.appendChild(a);
  });
}

/* ---- Main init ---- */
async function init() {
  // Apply persisted theme immediately
  applyTheme(getTheme());

  // 저장된 뷰(기본 데일리) 즉시 적용 — 섹션/미니목차 노출 플래시 방지
  applyView(getView());

  // 스냅샷 보드 + 캘린더 카드 (병렬 — 차트 로드와 독립, 실패해도 본문 렌더에 영향 없음)
  renderSnapshotBoard();
  renderCalendarCard();

  const loadingEl = document.getElementById('loading');
  const errorEl   = document.getElementById('error-msg');
  const mainEl    = document.getElementById('main');

  try {
    // 1. Fetch index (no-store: data refreshes daily, always pull current)
    const indexResp = await fetch('../data/index.json', { cache: 'no-store' });
    if (!indexResp.ok) throw new Error(`index.json fetch failed: ${indexResp.status}`);
    const index = await indexResp.json();

    // 버블 체크리스트 판정 로드 — 섹션 헤더/카드 배지가 참조하므로 렌더 전에 대기
    await loadBubbleChecklist();

    // Update header last-updated
    const updatedEl = document.getElementById('header-updated');
    if (updatedEl && index.updated) {
      updatedEl.textContent = fmtDate(index.updated);
    }

    // 투 뷰 재료: 차트 메타(순서) + daily 시드
    chartMetas = index.charts || [];
    chartMetas.forEach(c => {
      if (c.type !== 'link') dailySeed.set(c.id, !!c.daily);
    });

    // Build section nav (first-appearance order)
    const sections = index.charts.map(c => c.section);
    buildNav(sections);

    // Pre-create all sections in first-appearance order so their headers/order
    // are stable even when link cards are appended at the end of the array.
    sections.forEach(s => ensureSection(s, mainEl));

    // Hide loading
    loadingEl.style.display = 'none';

    // 2. Fetch each chart's data in order and render into its section container
    for (const meta of index.charts) {
      const sectionBody = ensureSection(meta.section, mainEl);

      // External-link card — no data file to fetch
      if (meta.type === 'link') {
        sectionBody.appendChild(createLinkCard(meta));
        continue;
      }

      if (!meta.ready) {
        sectionBody.appendChild(createPlaceholderCard(meta));
        continue;
      }

      // Fetch chart data
      let chartData = null;
      try {
        const resp = await fetch(`../data/${meta.file}`, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`${meta.file} fetch failed: ${resp.status}`);
        chartData = await resp.json();
      } catch (fetchErr) {
        console.warn(`Failed to load chart data for ${meta.id}:`, fetchErr);
        sectionBody.appendChild(createPlaceholderCard(meta));
        continue;
      }

      // Cache data
      chartDataCache.set(meta.id, chartData);

      // Build card
      const card = createChartCard(meta, chartData);
      sectionBody.appendChild(card);

      // 데일리 뷰 중이면 데일리 카드는 즉시 #daily-view로 이동 (증분 표시)
      const dailyEl = document.getElementById('daily-view');
      if (getView() === 'daily' && isDailyChart(meta.id) && dailyEl) {
        ensureCardSlot(card, meta.id);
        insertDailyCardOrdered(dailyEl, card, meta.id);
      }

      // Render 등록 (after DOM insertion so sizes are available).
      // display:none(접힌 섹션/숨긴 뷰)에서 ECharts init하면 width=0 →
      // renderFns에 등록 후 ensureRendered가 보일 때 lazy-init.
      if (meta.type === 'timeseries') {
        renderFns.set(meta.id, () => renderTimeseries(meta.id + '-chart', chartData));
        ensureRendered(meta.id);
      } else if (meta.type === 'curve_snapshot') {
        renderFns.set(meta.id, () => renderCurveSnapshot(meta.id + '-chart', chartData));
        ensureRendered(meta.id);
      } else if (meta.type === 'heatmap_perf') {
        // HTML 테이블 — 숨겨진 상태에서도 렌더 무해
        renderHeatmapPerf(meta.id + '-body', chartData);
      }
    }

    // 카드 전부 배치 후 뷰 최종 정리 (데일리 순서 보정 + lazy render)
    applyView(getView());

    // 3. Window resize → resize visible ECharts (숨긴 뷰/접힌 섹션은
    //    width=0으로 리사이즈되면 차트가 사라지므로 보이는 것만)
    window.addEventListener('resize', () => {
      chartInstances.forEach((instance, cid) => {
        if (isElVisible(document.getElementById(cid))) instance.resize();
      });
    });

  } catch (err) {
    console.error('Chart book init error:', err);
    loadingEl.style.display = 'none';
    errorEl.style.display = 'block';
    errorEl.textContent = `데이터 로드 오류: ${err.message}`;
  }
}

// Boot
document.addEventListener('DOMContentLoaded', init);

// Theme toggle button + view tabs
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.addEventListener('click', toggleTheme);
  document.querySelectorAll('.view-tab').forEach((tab) => {
    tab.addEventListener('click', () => applyView(tab.dataset.view));
  });
});
