/* Openhouse Meta Ads, shared copy: the page runtime.
 *
 * The live dashboard runs on Claude's dashboard engine, which asks Meta for each table as the
 * viewer changes the filters. This copy has no Meta access. Instead, every question the page asks
 * Meta is answered here from the data file that scripts/fetch_meta.py builds (window.__OH_DATA__).
 * The page's own code (site/dashboard.html) runs unchanged on top of this: the same loaders,
 * calcs and drawings, the same filters.
 */
(function () {
  'use strict';

  const DATA = window.__OH_DATA__;
  const ACCOUNT_OF = { oh2: '428357117849129', temp: '605518854162850', backup: '324083576441691', oh4: '1643698160129047' };
  const SOURCE_IDS = [];
  for (const k of Object.keys(ACCOUNT_OF)) SOURCE_IDS.push('catalog_' + k, 'camp_' + k, 'daily_' + k, 'gdaily_' + k);
  SOURCE_IDS.push('campaign_names', 'ticket_prices', 'adsets', 'ads', 'creatives', 'ad_preview', 'athome_bookings');

  // Which settings each question to Meta depends on.
  const DEPENDS = {
    catalog: [], campaign_names: [], ticket_prices: [], athome_bookings: [],
    camp: ['gop', 'gids', 'xf', 'xop', 'climit', 'since', 'until', 'range'],
    daily: ['dstep', 'since', 'until'],
    gdaily: ['gdids', 'gstep', 'since', 'until'],
    adsets: ['campaign', 'range'],
    ads: ['campaign', 'range'],
    creatives: ['creatives'],
    ad_preview: ['ad'],
  };
  const kindOf = (id) => (DEPENDS[id] ? id : id.split('_')[0]);
  const accountOf = (id) => ACCOUNT_OF[id.split('_')[1]];

  const DEFAULTS = {
    account: '', acct: '', ad: '', adset: '', aname: '', campaign: '', climit: 50, cname: '', creatives: ['0'],
    csort: 'amount_spent:desc', dstep: '1', gdids: ['0'], gids: ['0'], gop: 'NOT_IN', gstep: '1', pname: '', prog: '',
    pv: '', range: 'last_7d', since: '', until: '', view: '', xf: 'campaign.id', xop: 'NOT_IN',
  };
  // Settings kept in the address, so a link opens the same view.
  const LINK_KEYS = ['range', 'prog', 'acct', 'view', 'campaign', 'cname', 'account', 'adset', 'aname', 'csort'];

  const fromLink = () => {
    const out = {};
    try {
      const q = new URLSearchParams(location.hash.slice(1));
      for (const k of LINK_KEYS) {
        const v = q.get(k);
        if (v != null && v.length <= 300) out[k] = v;
      }
    } catch (e) { /* a broken link just opens the default view */ }
    return out;
  };
  let params = { ...DEFAULTS, ...fromLink() };
  let lastLink = null;
  const writeLink = () => {
    const q = new URLSearchParams();
    for (const k of LINK_KEYS) if (params[k] !== DEFAULTS[k] && params[k] !== '' && params[k] != null) q.set(k, params[k]);
    const s = q.toString();
    if (s === lastLink) return;
    lastLink = s;
    try { history.replaceState(null, '', s ? '#' + s : location.pathname + location.search); } catch (e) { /* ignore */ }
  };

  // ---- Answering Meta's questions from the data file ----

  const r2 = (v) => Math.round(v * 100) / 100;
  const shiftDays = (iso, n) => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const shortDate = (iso) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso + 'T00:00:00Z'));

  // Totals are kept per period; "whole campaign" runs from the campaign's first start, so its totals are the all-time ones.
  const periodKey = (p) => (p.range === 'campaign' ? 'all_time' : p.range);

  const totalsCache = {};
  const totalsFor = (level, key) => {
    const cacheKey = level + '|' + key;
    if (!(cacheKey in totalsCache)) {
      const list = DATA.totals && DATA.totals[level] && DATA.totals[level][key];
      totalsCache[cacheKey] = list ? new Map(list.map((t) => [t[0], t])) : null;
    }
    return totalsCache[cacheKey];
  };
  const metrics = (t) => (t
    ? { amount_spent: t[1], impressions: t[2], reach: t[3], link_click: t[4], lead: t[5], omni_purchase: t[6] }
    : { amount_spent: 0, impressions: 0, reach: null, link_click: 0, lead: 0, omni_purchase: 0 });
  const rates = (m) => ({
    frequency: m.reach > 0 ? r2(m.impressions / m.reach) : null,
    website_ctr: m.impressions > 0 ? r2((m.link_click * 100) / m.impressions) : null,
    cost_per_link_click: m.link_click > 0 ? r2(m.amount_spent / m.link_click) : null,
    cpm: m.impressions > 0 ? r2((m.amount_spent * 1000) / m.impressions) : null,
    cost_per_lead: m.lead > 0 ? r2(m.amount_spent / m.lead) : null,
    cost_per_omni_purchase: m.omni_purchase > 0 ? r2(m.amount_spent / m.omni_purchase) : null,
  });
  const notInCopy = (what) => ({ error: what + ' aren’t in this shared copy yet. They arrive with the next full update.' });

  const sumInto = (into, spend, impressions, clicks, leads, purchases) => {
    into.amount_spent = r2(into.amount_spent + (spend || 0));
    into.impressions += impressions || 0;
    into.link_click += clicks || 0;
    into.lead += leads || 0;
    into.omni_purchase += purchases || 0;
  };
  const emptyBucket = (date, acct) => ({ date_start: date, account_id: acct, amount_spent: 0, impressions: 0, link_click: 0, lead: 0, omni_purchase: 0 });

  // Bucket starts for a period, the way Meta splits it: every day, every 7 days from the start, or every calendar month.
  const bucketStarts = (since, until, step) => {
    const out = [];
    if (!isDate(since) || !isDate(until) || since > until) return out;
    if (step === 'monthly') {
      let m = since.slice(0, 7);
      while (m <= until.slice(0, 7)) {
        out.push(m + '-01' < since ? since : m + '-01');
        const [y, mo] = m.split('-').map(Number);
        m = mo === 12 ? (y + 1) + '-01' : y + '-' + String(mo + 1).padStart(2, '0');
      }
      return out;
    }
    const every = step === '7' ? 7 : 1;
    for (let d = since; d <= until; d = shiftDays(d, every)) out.push(d);
    return out;
  };
  const bucketOf = (date, since, step) => {
    if (step === 'monthly') return date.slice(0, 8) + '01' < since ? since : date.slice(0, 8) + '01';
    if (step === '7') {
      const days = Math.round((new Date(date + 'T00:00:00Z') - new Date(since + 'T00:00:00Z')) / 86400000);
      return shiftDays(since, Math.floor(days / 7) * 7);
    }
    return date;
  };

  const ANSWERS = {
    // Every campaign that started since 1 June 2025: the Campaign filter's list.
    catalog: (acct) => ({
      ad_entities: Object.entries(DATA.campaigns)
        .filter(([, c]) => c.a === acct && String(c.s || '') >= '2025-06-01')
        .map(([id, c]) => ({ id, name: c.n, objective: c.o || null, start_time: c.s || null, account_id: acct })),
    }),

    // Campaigns with their totals for the period: the top 50 by spend, or all that spent for All time, or the picked campaign's.
    camp: (acct, p) => {
      const totals = totalsFor('campaign', periodKey(p));
      if (!totals) return notInCopy('Numbers for this period');
      const inGroup = p.gop === 'IN' ? new Set((p.gids || []).map(String)) : null;
      const spentOnly = p.xf === 'amount_spent' && p.xop === 'GREATER_THAN';
      const rows = [];
      for (const [id, c] of Object.entries(DATA.campaigns)) {
        if (c.a !== acct || (inGroup && !inGroup.has(id))) continue;
        const t = totals.get(id);
        if (!t && c.st !== 'ACTIVE') continue;
        const m = metrics(t);
        if (spentOnly && !(m.amount_spent > 0)) continue;
        rows.push({ id, name: c.n, account_id: acct, effective_status: c.st || null, objective: c.o || null, start_time: c.s || null, ...m });
      }
      rows.sort((a, b) => (b.amount_spent || 0) - (a.amount_spent || 0));
      return { ad_entities: rows.slice(0, Number(p.climit) || 50) };
    },

    // The account's totals per day, or per month for All time.
    daily: (acct, p) => {
      const monthly = p.dstep === 'monthly';
      const series = (monthly ? DATA.account_months : DATA.account_days) || {};
      const byDate = new Map();
      for (const s of series[acct] || []) byDate.set(s[0], s);
      if (!monthly && p.since < DATA.coverage.days_since) return notInCopy('Day-by-day numbers before ' + shortDate(DATA.coverage.days_since));
      const rows = [];
      for (const start of bucketStarts(p.since, p.until, monthly ? 'monthly' : '1')) {
        const row = emptyBucket(start, acct);
        const s = byDate.get(monthly ? start.slice(0, 7) : start);
        if (s) sumInto(row, s[1], s[2], s[3], s[4], s[5]);
        rows.push(row);
      }
      return { ad_entities: rows };
    },

    // The picked campaign's Meta campaigns, added up per day, week or month.
    gdaily: (acct, p) => {
      const ids = new Set((p.gdids || []).map(String));
      const step = p.gstep === '7' || p.gstep === 'monthly' ? p.gstep : '1';
      const rows = new Map();
      for (const start of bucketStarts(p.since, p.until, step)) rows.set(start, emptyBucket(start, acct));
      for (const d of DATA.campaign_days || []) {
        const c = DATA.campaigns[d[0]];
        if (!c || c.a !== acct || !ids.has(d[0]) || d[1] < p.since || d[1] > p.until) continue;
        const row = rows.get(bucketOf(d[1], p.since, step));
        if (row) sumInto(row, d[2], d[3], d[4], d[5], d[6]);
      }
      return { ad_entities: [...rows.values()] };
    },

    // The open campaign's ad sets with their totals for the period.
    adsets: (acct, p) => {
      if (!p.campaign) return { ad_entities: [] };
      const c = DATA.campaigns[p.campaign];
      const key = periodKey(p);
      const totals = totalsFor('adset', key);
      if (!totals || (c && DATA.coverage.drill_complete_from && key === 'all_time' && String(c.s || '') < DATA.coverage.drill_complete_from && !(DATA.coverage.drill_all_time || []).includes(p.campaign))) {
        return notInCopy('Ad set numbers for this campaign and period');
      }
      const rows = [];
      for (const [id, a] of Object.entries(DATA.adsets)) {
        if (a.c !== p.campaign) continue;
        const m = metrics(totals.get(id));
        let targeting = null;
        try { targeting = a.t ? JSON.parse(a.t) : null; } catch (e) { targeting = null; }
        rows.push({ id, name: a.n, campaign_id: a.c, effective_status: a.st || null, optimization_goal: a.g || null, targeting, ...m, ...rates(m) });
      }
      rows.sort((x, y) => (y.amount_spent || 0) - (x.amount_spent || 0));
      return { ad_entities: rows.slice(0, 50) };
    },

    // The open campaign's ads with their totals for the period.
    ads: (acct, p) => {
      if (!p.campaign) return { ad_entities: [] };
      const c = DATA.campaigns[p.campaign];
      const key = periodKey(p);
      const totals = totalsFor('ad', key);
      if (!totals || (c && DATA.coverage.drill_complete_from && key === 'all_time' && String(c.s || '') < DATA.coverage.drill_complete_from && !(DATA.coverage.drill_all_time || []).includes(p.campaign))) {
        return notInCopy('Ad numbers for this campaign and period');
      }
      const rows = [];
      for (const [id, a] of Object.entries(DATA.ads)) {
        if (a.c !== p.campaign) continue;
        const m = metrics(totals.get(id));
        const set = DATA.adsets[a.as];
        rows.push({
          id, name: a.n, campaign_id: a.c, adset_id: a.as || null, adset_name: set ? set.n : null, creative_id: a.cr || null,
          effective_status: a.st || null, account_id: c ? c.a : acct, ...m, ...rates(m),
        });
      }
      rows.sort((x, y) => (y.amount_spent || 0) - (x.amount_spent || 0));
      return { ad_entities: rows.slice(0, 100) };
    },

    // The At-Home bookings sheet, as Google Sheets answers: only its booking (A–F) and link-tag (X–Z) columns.
    athome_bookings: () => DATA.athome_sheet || { error: 'The At-Home bookings sheet isn’t in this shared copy yet.' },

    creatives: (acct, p) => ({
      ad_creatives: (p.creatives || []).map(String).filter((id) => DATA.creatives[id]).map((id) => ({ id, ...DATA.creatives[id] })),
    }),
  };

  // ---- State, calcs and drawing ----

  const state = {};
  const sig = {};
  const loaders = {};
  const calcs = [];
  const draws = [];
  const listeners = [];
  let version = 0;
  const set = (id, s) => { state[id] = { refreshing: false, ...s, v: ++version }; };
  for (const id of SOURCE_IDS) set(id, { status: 'loading', data: null });

  const signature = (id) => JSON.stringify(DEPENDS[kindOf(id)].map((k) => params[k]));

  const resolveSource = (id) => {
    const kind = kindOf(id);
    if (kind === 'ad_preview') { set(id, { status: 'idle', data: null }); return; }
    if (kind === 'campaign_names' || kind === 'ticket_prices') { set(id, { status: 'ok', data: (DATA.lists && DATA.lists[kind]) || [] }); return; }
    const acct = accountOf(id) || params.account;
    try {
      const answer = ANSWERS[kind](acct, params);
      const loader = loaders[id];
      const out = loader ? loader.fn({ answer, args: { ad_account_id: acct, ad_id: params.ad } }) : answer;
      const data = Array.isArray(out) ? out : out && Array.isArray(out.data) ? out.data : [];
      set(id, { status: 'ok', data });
    } catch (e) {
      set(id, { status: 'error', data: null, error: String((e && e.message) || e) });
    }
  };

  const runCalcs = () => {
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (const c of calcs) {
        const ins = c.inputs.map((i) => state[i] || { status: 'loading', v: 0 });
        // Like the live engine, a calc that reads the filters runs again when they change.
        const key = ins.map((s) => s.v).join('|') + (c.usesParams ? '|' + JSON.stringify(params) : '');
        if (key === c.lastKey) continue;
        c.lastKey = key;
        changed = true;
        if (ins.some((s) => s.status === 'error')) set(c.id, { status: 'error', data: null });
        else if (ins.some((s) => s.status !== 'ok')) set(c.id, { status: 'loading', data: null });
        else {
          try { set(c.id, { status: 'ok', data: c.fn(...ins.map((s) => s.data || [])) }); } catch (e) {
            console.error('calc ' + c.id, e);
            set(c.id, { status: 'error', data: null, error: String((e && e.message) || e) });
          }
        }
      }
      if (!changed) break;
    }
  };

  const drawAll = () => {
    for (const d of draws) {
      for (const el of document.querySelectorAll('[data-draw="' + d.name + '"]')) {
        try {
          if (d.spec.mount && !d.made.has(el)) d.made.set(el, d.spec.mount(el) || {});
          if (d.spec.update) d.spec.update(el, d.made.get(el) || {});
        } catch (e) { console.error('draw ' + d.name, e); }
      }
    }
  };

  let pending = false;
  let rounds = 0;
  const schedule = () => {
    if (pending) return;
    pending = true;
    setTimeout(cycle, 0);
  };
  function cycle() {
    pending = false;
    for (const id of SOURCE_IDS) {
      const s = signature(id);
      if (s !== sig[id]) { sig[id] = s; resolveSource(id); }
    }
    runCalcs();
    for (const fn of listeners) { try { fn(); } catch (e) { console.error('onData', e); } }
    // Settings changed by the page itself are settled before anything is drawn.
    if (pending && rounds++ < 30) return;
    rounds = 0;
    drawAll();
    writeLink();
    document.documentElement.dataset.ready = '1';
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawAll, 150);
  });

  const IST = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });

  window.dash = {
    colors: ['#3d6fd6', '#d2643c', '#2e9b6c', '#8b5cc7', '#c99a2e', '#4a9fb5'],
    loader: (id, spec) => { loaders[id] = spec; },
    calc: (id, spec) => {
      calcs.push({ id, inputs: spec.inputs || [], fn: spec.fn, usesParams: /dash\.params\(/.test(String(spec.fn)), lastKey: null });
      if (!state[id]) set(id, { status: 'loading', data: null });
    },
    draw: (name, spec) => { draws.push({ name, spec: typeof spec === 'function' ? { update: spec } : spec, made: new WeakMap() }); },
    onData: (fn) => { listeners.push(fn); },
    data: (id) => state[id] || { status: 'loading', data: null, refreshing: false },
    params: () => ({ ...params }),
    setParams: (patch) => {
      let changed = false;
      for (const [k, v] of Object.entries(patch || {})) {
        if (JSON.stringify(params[k]) !== JSON.stringify(v)) { params[k] = v; changed = true; }
      }
      if (changed) schedule();
    },
    refresh: (id) => { delete sig[id]; schedule(); },
    // The day the numbers were taken, in India time: every period ends on it.
    today: () => DATA.today,
    updatedText: () => 'Numbers from Meta as of ' + IST.format(new Date(DATA.generated_at)) + ' IST'
      + (DATA.coverage && DATA.coverage.note ? ' · ' + DATA.coverage.note : ' · updates every 2 hours'),
    start: () => schedule(),
  };
})();
