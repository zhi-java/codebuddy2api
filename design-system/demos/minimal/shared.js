/* ═══════════════════════════════════════════════════════════════════
   共享层：图标、顶栏、浮层控制、格式化与绘图工具。
   6 个页面共同引用，避免重复。无框架依赖。
   ═══════════════════════════════════════════════════════════════════ */

/* ── 图标：内联 SVG，Lucide 风格 outline，1.8 描边。不用 emoji ── */
const ICONS = {
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  play: '<path d="m5 3 14 9-14 9z"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  arrowUp: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  arrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.8 12.2 21 2"/><path d="M15.5 6.5 18 9"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>',
  home: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>',
};

function icon(name, size = 15, extra = '') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra} aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

/* ── 顶栏：5 个页面共用。active 决定哪一项高亮 ──
   导航只保留「有事要做」才点进去的入口。原先的「设置」页已移除：
   其可写项（自动签到开关、退出登录）在凭证页与顶栏已有，
   只读项（运行参数、上游地址）来自环境变量，权威在 docker-compose.yml。 */
const NAV_ITEMS = [
  ['overview', '总览', 'index.html'],
  ['credentials', '凭证', 'credentials.html'],
  ['keys', 'Keys', 'keys.html'],
  ['playground', '对话', 'playground.html'],
  ['logs', '日志', 'logs.html'],
];

function renderTopbar(active) {
  const nav = NAV_ITEMS.map(([k, label, href]) =>
    `<a href="${href}" class="${k === active ? 'on' : ''}">${label}</a>`).join('');
  return `
  <header class="topbar">
    <div class="topbar-inner">
      <a class="brand" href="index.html">
        <i>${icon('shield', 12)}</i><b>CodeBuddy Gateway</b>
      </a>
      <nav class="nav">${nav}</nav>
      <div class="topbar-right">
        <a class="btn-text" href="landing.html">公开首页</a>
        <span class="status" id="top-status"><i></i>5/6 健康</span>
        <button class="btn-text" id="top-logout">退出</button>
      </div>
    </div>
  </header>`;
}

/* ── 确定性伪随机：保证任何人、任何时刻打开看到同一份数据 ── */
function makeRng(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

/* ── 格式化 ── */
const fmt = {
  num: (v) => (v === undefined || v === null ? '—' : Number(v).toLocaleString('zh-CN')),
  compact: (v) => {
    if (v === undefined || v === null) return '—';
    const n = Number(v);
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  },
  ms: (v) => {
    if (v === undefined || v === null) return '—';
    return v >= 1000 ? (v / 1000).toFixed(2) + 's' : Math.round(v) + 'ms';
  },
  time: (ts) => new Date(ts).toTimeString().slice(0, 8),
  clock: (ts) => new Date(ts).toTimeString().slice(0, 5),
  ago: (ts) => {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s} 秒前`;
    if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
    return `${Math.round(s / 86400)} 天前`;
  },
};

/* ── 迷你趋势线：细折线 + 极淡填充，作为读数的佐证 ── */
function sparkline(el, values, color = '#2563eb', h = 24) {
  if (!el || !values.length) return;
  const w = 240, pad = 2;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  el.setAttribute('viewBox', `0 0 ${w} ${h}`);
  el.innerHTML =
    `<path d="M${pts.join('L')}L${w},${h}L0,${h}Z" fill="${color}" opacity="0.07"/>` +
    `<path d="M${pts.join('L')}" fill="none" stroke="${color}" stroke-width="1.3"
      stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
}

/* ── 折线/面积图：极简版只画主线 + 3 条网格线，不放图例（图例文字直接标在轴上） ── */
function drawChart(el, series, opts = {}) {
  const w = opts.w || 1100;
  const h = opts.h || 200;
  const padL = opts.padL ?? 44, padR = 8, padT = 10, padB = 22;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  const key = opts.key || 'total';
  const max = Math.max(...series.map((d) => d[key]), 1) * 1.15;
  const x = (i) => padL + (i / Math.max(1, series.length - 1)) * plotW;
  const y = (v) => padT + plotH - (v / max) * plotH;

  // 网格：3 条线即可，多了显乱
  let grid = '';
  for (let g = 0; g <= 3; g++) {
    const v = (max / 3) * g;
    const yy = y(v);
    grid += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${w - padR}" y2="${yy.toFixed(1)}"
      stroke="#ededed" stroke-width="1"/>`;
    grid += `<text x="${padL - 10}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end"
      font-size="10" fill="#6b6b74" font-family="monospace">${fmt.compact(Math.round(v))}</text>`;
  }

  const line = series.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join('');
  const area = `${line}L${x(series.length - 1).toFixed(1)},${(padT + plotH).toFixed(1)}L${padL},${(padT + plotH).toFixed(1)}Z`;

  // 错误：以红色细竖线标出，不叠加第二条折线（保持单一视觉语言）
  let errs = '';
  if (opts.showErrors) {
    series.forEach((d, i) => {
      if (!d.errors) return;
      errs += `<line x1="${x(i).toFixed(1)}" y1="${(padT + plotH).toFixed(1)}"
        x2="${x(i).toFixed(1)}" y2="${y(d[key]).toFixed(1)}"
        stroke="#b91c1c" stroke-width="1" opacity="0.45"/>`;
    });
  }

  // x 轴：3 个刻度，标相对时间
  let axis = '';
  const ticks = 3;
  for (let i = 0; i <= ticks; i++) {
    const idx = Math.round((i / ticks) * (series.length - 1));
    const d = series[idx];
    const label = opts.axisLabel ? opts.axisLabel(d, idx) : `${d.minsAgo}m`;
    axis += `<text x="${x(idx).toFixed(1)}" y="${h - 6}" text-anchor="${i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}"
      font-size="10" fill="#6b6b74" font-family="monospace">${label}</text>`;
  }

  el.setAttribute('viewBox', `0 0 ${w} ${h}`);
  el.innerHTML =
    grid +
    `<path d="${area}" fill="${opts.color || '#2563eb'}" opacity="0.07"/>` +
    errs +
    `<path d="${line}" fill="none" stroke="${opts.color || '#2563eb'}" stroke-width="1.6"
      stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` +
    axis;
}

/* ── 浮层：模态与抽屉，共用一个 scrim ── */
const Overlay = {
  el: null,
  open(id) {
    this.close();
    const node = document.getElementById(id);
    if (!node) return;
    this.el = node;
    let scrim = document.getElementById('scrim');
    if (!scrim) {
      scrim = document.createElement('div');
      scrim.id = 'scrim';
      scrim.className = 'scrim';
      scrim.addEventListener('click', () => Overlay.close());
      document.body.appendChild(scrim);
    }
    scrim.classList.add('on');
    // 先强制重排拿到「起始态」，再同步加上 on 触发过渡。
    // 不用 requestAnimationFrame：它在无头/后台标签页里可能被节流甚至不触发，
    // 会让浮层永远停在 opacity:0 的起始态（实测抽屉打不开就是这么来的）。
    void node.offsetHeight;
    node.classList.add('on');
    const focusable = node.querySelector('input, textarea, select, button');
    focusable?.focus();
  },
  close() {
    if (!this.el) return;
    this.el.classList.remove('on');
    this.el = null;
    document.getElementById('scrim')?.classList.remove('on');
  },
};

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') Overlay.close(); });

/* ── 轻提示：极简下不用 toast，用顶栏右侧的一行文字淡出 ── */
function toast(text) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = `position:fixed;left:50%;bottom:28px;transform:translateX(-50%);
      background:#18181b;color:#fff;font-size:12.5px;padding:9px 16px;border-radius:8px;
      z-index:200;opacity:0;transition:opacity 200ms cubic-bezier(.16,1,.3,1);pointer-events:none;`;
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 1800);
}

/* ── 挂载顶栏 ── */
function mountTopbar(active) {
  const holder = document.getElementById('topbar');
  if (holder) holder.outerHTML = renderTopbar(active);
  document.getElementById('top-logout')?.addEventListener('click', () => toast('已退出登录（演示）'));
}
