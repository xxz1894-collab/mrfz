/* =========================================================
   终末地 · 工业配平器  —  app.js
   数据：fz.wiki 工厂建筑 / 生产配方（data.json）
   ========================================================= */
'use strict';

(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

  const nf = (n, d = 2) => {
    if (n == null || !isFinite(n)) return '—';
    const p = 10 ** d;
    return String(Math.round(n * p) / p);
  };

  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true });

  /* ---------------- state ---------------- */
  const S = {
    data: null,
    items: new Map(),     // name -> {name, icon, rarity, id}
    prod: new Map(),      // name -> [{key, building, power, recipe, outcome, outRate}]
    use: new Map(),       // name -> [{building, recipe, product}]
    bld: new Map(),       // name -> building
    order: new Map(),     // building -> sort index
    target: '',
    rate: 60,
    overrides: new Map(),
    plan: null,
    view: 'calc',
    itemFilter: 'all',
    itemQuery: '',
    selItem: null,
    recipeQuery: '',
    recipeMachine: 'all',
    bldQuery: '',
    bldFilter: 'prod',
    comboHl: -1,
    comboTimer: null,
    meta: {},
    flowRate: 60,
  };

  const BUILDING_ORDER = [
    '精炼炉', '粉碎机', '研磨机', '配件机', '塑形机', '封装机', '反应池', '扩容反应池',
    '固气转化机', '液气转化机', '灌装机', '拆解机', '提纯机', '气体反应炉', '天有洪炉',
    '装备原件机', '采种机', '种植机', '废水处理机', '二型耐酸水泵', '水泵',
    '热能池', '产物排出口', '气体收集泵', '气体散布机', '污水接入口',
  ];

  const QUICK = ['高容谷地电池', '分离芯', '钢制零件', '赤铜零件', '息壤', '液化息壤', '碳块', '蓝铁瓶'];

  /* ---------------- boot ---------------- */
  init();

  async function init() {
    try {
      const res = await fetch('data.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      S.data = await res.json();
    } catch (err) {
      $('#planMeta').textContent = '数据加载失败：' + err.message;
      $('#chainTable').innerHTML = '<div class="empty">无法加载 data.json，请确认通过 HTTP 服务访问本站。</div>';
      return;
    }
    index();
    buildStaticUI();
    route();
    window.addEventListener('hashchange', route);
    const stamp = $('#dataStamp');
    if (stamp) stamp.textContent = '数据 · ' + (S.data.fetchedAt || '—');
  }

  function num(v) {
    const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.\-]/g, ''));
    return isFinite(n) ? n : 0;
  }

  /* ---------------- indexing ---------------- */
  function index() {
    const D = S.data;
    S.meta = D.itemMeta || {};
    if (D.items && !Array.isArray(D.items)) {
      Object.entries(D.items).forEach(([id, it]) => {
        S.items.set(it.name, { name: it.name, icon: it.icon, rarity: it.rarity || 0, id });
      });
    }
    BUILDING_ORDER.forEach((n, i) => S.order.set(n, i));

    (D.buildings || []).forEach((b) => {
      S.bld.set(b.name, b);
      const power = num(b.power);
      (b.production || []).forEach((r) => {
        const perSec = r.craftSeconds > 0 ? 60 / r.craftSeconds : 0;
        (r.outcomes || []).forEach((o) => {
          if (!S.items.has(o.name)) {
            S.items.set(o.name, { name: o.name, icon: o.icon, rarity: o.rarity || 0, id: o.itemId });
          }
          const entry = {
            key: b.name + '::' + r.recipeId,
            building: b.name,
            power,
            recipe: r,
            outcome: o,
            outRate: o.ratePerMin || o.count * perSec,
          };
          if (!S.prod.has(o.name)) S.prod.set(o.name, []);
          S.prod.get(o.name).push(entry);
        });
        (r.ingredients || []).forEach((i) => {
          if (!S.items.has(i.name)) {
            S.items.set(i.name, { name: i.name, icon: i.icon, rarity: i.rarity || 0, id: i.itemId });
          }
          if (!S.use.has(i.name)) S.use.set(i.name, []);
          if (r.outcomes && r.outcomes[0]) {
            S.use.get(i.name).push({ building: b.name, recipe: r, product: r.outcomes[0].name });
          }
        });
      });
    });

    // 生产设备优先级排序
    S.prod.forEach((list) => {
      list.sort((a, b) => (S.order.get(a.building) ?? 99) - (S.order.get(b.building) ?? 99));
    });
  }

  /* ---------------- recipe selection & plan ---------------- */
  /** 该产物的候选配方：排除「同物料回灌」的自指/回收配方（拆解机、灌装机把罐又变回罐）。
   *  只有净产出（产物数 > 自耗数）的自指配方才保留。 */
  function candidates(name) {
    const list = S.prod.get(name) || [];
    const pool = list.filter((e) => {
      const self = (e.recipe.ingredients || []).filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
      return !(self > 0 && e.outcome.count <= self);
    });
    const use = pool.length ? pool : list;
    return use.slice().sort(cmpRecipe);
  }

  function pickRecipe(name) {
    const list = S.prod.get(name);
    if (!list || !list.length) return null;
    const key = S.overrides.get(name);
    if (key) {
      const found = list.find((e) => e.key === key);
      if (found) return found;
    }
    return candidates(name)[0] || null;
  }

  function cmpRecipe(a, b) {
    const ia = (a.recipe.ingredients || []).length;
    const ib = (b.recipe.ingredients || []).length;
    // 优先「不依赖其它被生产产物」的路线：原料越直接越好，避免 罐→气→罐 这类 1:1 闭环
    const sa = scoreRecipe(a);
    const sb = scoreRecipe(b);
    if (sa.nonRaw !== sb.nonRaw) return sa.nonRaw - sb.nonRaw;
    if (sa.raw !== sb.raw) return sb.raw - sa.raw;
    if (ia !== ib) return ia - ib;
    if (b.outRate !== a.outRate) return b.outRate - a.outRate;
    return (S.order.get(a.building) ?? 99) - (S.order.get(b.building) ?? 99);
  }

  const scoreCache = new Map();
  function scoreRecipe(e) {
    if (scoreCache.has(e.key)) return scoreCache.get(e.key);
    const ings = e.recipe.ingredients || [];
    const raw = ings.filter((i) => !S.prod.has(i.name)).length;
    const s = { raw, nonRaw: ings.length - raw };
    scoreCache.set(e.key, s);
    return s;
  }

  /** 从目标出发沿原料 BFS，补全每个中间产物选定的配方 */
  function expandRecipes(target, seed) {
    const chosen = new Map(seed || []);
    const queue = [target];
    const seen = new Set(queue);
    let guard = 0;
    while (queue.length && guard++ < 4000) {
      const name = queue.shift();
      if (!S.prod.has(name)) continue;
      const entry = chosen.get(name) || pickRecipe(name);
      if (!entry || !(entry.outcome.count > 0)) continue;
      chosen.set(name, entry);
      (entry.recipe.ingredients || []).forEach((i) => {
        if (!seen.has(i.name)) { seen.add(i.name); queue.push(i.name); }
      });
    }
    return chosen;
  }

  const choicesKey = (chosen) => Array.from(chosen.entries()).map(([n, e]) => n + '=' + e.key).sort().join('|');

  /**
   * 物料平衡：p_i = 配方 i 的每分钟执行次数
   * 对每个产物 i：p_i × 每次产出数 = 目标需求 + 被其他配方消耗量
   * 不动点迭代，可正确处理 砂叶 ⇄ 砂叶种子 这类增益 < 1 的循环链；
   * 遇到增益 ≥ 1 的循环（如 息壤 ⇄ 息壤气 1:1）会发散，由 computePlan 换配方修复。
   */
  function solveBalance(chosen, target, rate) {
    let p = new Map();
    let iterations = 0;
    let converged = false;
    let diverged = false;
    let peak = 0;

    for (let it = 0; it < 260; it++) {
      iterations = it + 1;
      const demand = new Map();
      demand.set(target, rate);
      chosen.forEach((e, name) => {
        const pj = p.get(name) || 0;
        if (!(pj > 0)) return;
        (e.recipe.ingredients || []).forEach((i) => {
          demand.set(i.name, (demand.get(i.name) || 0) + pj * i.count);
        });
      });

      let delta = 0;
      let maxv = 1;
      chosen.forEach((e, name) => {
        const v = (demand.get(name) || 0) / e.outcome.count;
        delta = Math.max(delta, Math.abs(v - (p.get(name) || 0)));
        maxv = Math.max(maxv, v);
      });

      peak = Math.max(peak, maxv);
      if (maxv > 1e6 * Math.max(rate, 60) + 1e6) { diverged = true; break; }

      const damp = it > 130 ? 0.5 : 1;
      const next = new Map();
      chosen.forEach((e, name) => {
        const raw = (demand.get(name) || 0) / e.outcome.count;
        next.set(name, (1 - damp) * (p.get(name) || 0) + damp * raw);
      });
      p = next;
      if (delta <= 1e-9 * Math.max(1, maxv)) { converged = true; break; }
    }
    return { p, converged, diverged, iterations, peak };
  }

  /**
   * 选择配方：启发式选路后做「发散修复」——多步贪心，把峰值规模压下去直到物料平衡收敛；
   * 实在无解时把失控的中间品当外部采购（截断），保证表格自洽。
   */
  function chooseRecipes(target, rate) {
    const base = expandRecipes(target);
    let best = { chosen: base, sol: solveBalance(base, target, rate) };
    if (best.sol.converged) return { chosen: best.chosen, sol: best.sol, truncated: false };

    const tried = new Set([choicesKey(base)]);
    const namesByPeak = () => Array.from(best.chosen.keys())
      .sort((a, b) => (best.sol.p.get(b) || 0) - (best.sol.p.get(a) || 0));

    for (let step = 0; step < 10 && !best.sol.converged; step++) {
      let moved = false;
      for (const name of namesByPeak()) {
        if (S.overrides.has(name)) continue;
        const cur = best.chosen.get(name);
        if (!cur) continue;
        for (const alt of candidates(name)) {
          if (alt.key === cur.key) continue;
          const seed = new Map(best.chosen);
          seed.set(name, alt);
          const trial = expandRecipes(target, seed);
          const key = choicesKey(trial);
          if (tried.has(key)) continue;
          tried.add(key);
          const s = solveBalance(trial, target, rate);
          if (s.converged) return { chosen: trial, sol: s, truncated: false };
          if (s.peak < best.sol.peak * 0.85) {
            best = { chosen: trial, sol: s };
            moved = true;
            break;
          }
        }
        if (moved) break;
      }
      if (!moved) break;
    }

    // 截断兜底：把规模失控的中间品直接当外部原料买入
    const cut = new Map(best.chosen);
    best.sol.p.forEach((v, n) => {
      if (n !== target && v > 1000 * Math.max(1, rate / 60)) cut.delete(n);
    });
    const s3 = solveBalance(cut, target, rate);
    const ok = s3.converged ? s3 : best.sol;
    return { chosen: cut, sol: ok, truncated: cut.size < best.chosen.size };
  }

  function computePlan(target, rate) {
    const picked = chooseRecipes(target, rate);
    const chosen = picked.chosen;
    const sol = picked.sol;
    const p = sol.p;
    const iterations = sol.iterations;
    const converged = sol.converged;
    const truncated = !!sol.truncated || !!picked.truncated;
    const bp = new Map();

    // 收敛后的最终物料流
    const demand = new Map();
    demand.set(target, rate);
    chosen.forEach((e, name) => {
      const pj = p.get(name) || 0;
      if (!(pj > 0)) return;
      (e.recipe.ingredients || []).forEach((i) => {
        demand.set(i.name, (demand.get(i.name) || 0) + pj * i.count);
      });
      (e.recipe.outcomes || []).forEach((o) => {
        if (o.name !== name) bp.set(o.name, (bp.get(o.name) || 0) + pj * o.count);
      });
    });

    // 层级：从目标出发的最短层级
    const depth = new Map([[target, 1]]);
    const queue = [target];
    while (queue.length) {
      const n = queue.shift();
      const e = chosen.get(n);
      if (!e) continue;
      const d = (depth.get(n) || 1) + 1;
      (e.recipe.ingredients || []).forEach((i) => {
        if (!depth.has(i.name) || d < depth.get(i.name)) { depth.set(i.name, d); queue.push(i.name); }
      });
    }

    // 循环链标记
    const color = new Map();
    const stack = [];
    const loops = new Set();
    const visit = (n) => {
      color.set(n, 1);
      stack.push(n);
      const e = chosen.get(n);
      if (e) {
        (e.recipe.ingredients || []).forEach((i) => {
          const c = color.get(i.name) || 0;
          if (c === 0) visit(i.name);
          else if (c === 1) {
            const idx = stack.indexOf(i.name);
            if (idx >= 0) stack.slice(idx).forEach((x) => loops.add(x));
          }
        });
      }
      stack.pop();
      color.set(n, 2);
    };
    if (chosen.has(target) || S.prod.has(target)) visit(target);

    const rows = [];
    const raw = [];
    demand.forEach((amount, name) => {
      if (!(amount > 1e-6)) return;
      const info = S.items.get(name) || { name };
      const e = chosen.get(name);
      if (e && p.get(name) > 0) {
        const outRate = e.outcome.count * (e.recipe.craftSeconds > 0 ? 60 / e.recipe.craftSeconds : 0);
        const machines = p.get(name) * (e.recipe.craftSeconds > 0 ? e.recipe.craftSeconds / 60 : 0);
        const plan = Math.ceil(machines - 1e-9);
        rows.push({
          name, info, depth: depth.get(name) || 1, need: amount,
          entry: e, outRate, crafts: p.get(name),
          machines, plan, power: (e.power || 0) * plan,
          loop: loops.has(name),
        });
      } else {
        raw.push({ name, info, need: amount });
      }
    });

    rows.sort((a, b) => a.depth - b.depth || b.need - a.need);
    raw.sort((a, b) => b.need - a.need);

    const totals = {
      machines: rows.reduce((s, r) => s + r.plan, 0),
      power: rows.reduce((s, r) => s + r.power, 0),
      raw: raw.length,
      maxDepth: rows.reduce((s, r) => Math.max(s, r.depth), 0),
      buildings: new Set(rows.map((r) => r.entry.building)).size,
      iterations, converged, truncated,
    };

    return {
      rows, raw, totals, loops: Array.from(loops),
      bp: Array.from(bp.entries())
        .filter(([, v]) => v > 1e-6)
        .map(([name, v]) => ({ name, rate: v, info: S.items.get(name) || { name } }))
        .sort((a, b) => b.rate - a.rate),
    };
  }

  function computeAndRender() {
    if (!S.target) return;
    S.plan = computePlan(S.target, S.rate);
    renderCalc();
  }

  /* ---------------- DOM helpers ---------------- */
  function icoHTML(info, extra) {
    if (info && info.icon) {
      return `<span class="ico ${extra || ''}"><img src="${esc(info.icon)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('empty');this.remove()"></span>`;
    }
    return `<span class="ico empty ${extra || ''}"></span>`;
  }

  function rarHTML(r) {
    const n = Math.max(0, Math.min(5, r || 0));
    return `<span class="rar r${n}"><i></i><i></i><i></i><i></i><i></i></span>`;
  }

  function recipeLine(r, withOutcome) {
    const ing = r.ingredients
      .map((i) => `<span class="amt">${esc(i.name)}×${nf(i.count, 2)}</span>`)
      .join('<span class="arw">+</span>');
    if (!withOutcome) return ing;
    const out = r.outcomes
      .map((o) => `<span class="op">${esc(o.name)}×${nf(o.count, 2)}</span>`)
      .join('<span class="arw">+</span>');
    return `${ing}<span class="arw">→</span>${out}`;
  }

  /* ---------------- static UI ---------------- */
  function buildStaticUI() {
    // 快速目标
    const chips = $('#quickChips');
    chips.innerHTML = '<span class="lbl">快速目标</span>' +
      QUICK.filter((n) => S.prod.has(n))
        .map((n) => `<button class="chip" data-target="${esc(n)}">${esc(n)}</button>`)
        .join('');
    chips.addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      setTarget(b.dataset.target);
    });

    // 目标输入框
    const input = $('#targetInput');
    const combo = $('#combo');
    const list = $('#comboList');

    input.value = S.target;
    updateComboIcon();

    input.addEventListener('focus', () => {
      if (input.value === S.target) input.value = '';
      openCombo(input.value);
    });
    input.addEventListener('input', () => {
      S.comboHl = -1;
      openCombo(input.value);
    });
    input.addEventListener('keydown', onComboKey);
    list.addEventListener('mousedown', (e) => {
      const opt = e.target.closest('.combo-opt');
      if (!opt) return;
      e.preventDefault();
      chooseTarget(opt.dataset.name);
    });
    document.addEventListener('click', (e) => {
      if (!combo.contains(e.target)) closeCombo();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== input) {
        e.preventDefault();
        input.focus();
      }
    });

    // 产能
    const rate = $('#rateInput');
    rate.value = S.rate;
    rate.addEventListener('input', () => {
      const v = parseFloat(rate.value);
      if (!isFinite(v) || v <= 0) return;
      S.rate = v;
      clearTimeout(S.comboTimer);
      S.comboTimer = setTimeout(computeAndRender, 260);
    });
    rate.addEventListener('change', () => {
      const v = parseFloat(rate.value);
      if (!isFinite(v) || v <= 0) { rate.value = S.rate; return; }
      S.rate = v;
      computeAndRender();
    });
    rate.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); computeAndRender(); }
    });

    $('#calcBtn').addEventListener('click', () => {
      const v = parseFloat(rate.value);
      if (isFinite(v) && v > 0) S.rate = v;
      computeAndRender();
    });

    $('#planMeta').addEventListener('click', (e) => {
      if (e.target.closest('#ovReset')) {
        S.overrides.clear();
        computeAndRender();
      }
    });

    $('#copyPlanBtn').addEventListener('click', copyPlanText);
    $('#shareBtn').addEventListener('click', copyShareLink);

    $('#chainTable').addEventListener('change', (e) => {
      const sel = e.target.closest('select.mini');
      if (!sel) return;
      S.overrides.set(sel.dataset.name, sel.value);
      computeAndRender();
    });

    // 物品视图
    const flowRate = $('#flowRate');
    if (flowRate) {
      flowRate.value = S.flowRate;
      const syncFlow = () => {
        const v = parseFloat(flowRate.value);
        S.flowRate = isFinite(v) && v > 0 ? v : 60;
        if (S.selItem) renderItemFlow(S.selItem);
      };
      flowRate.addEventListener('change', syncFlow);
      flowRate.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); syncFlow(); }
      });
    }

    $('#itemSearch').addEventListener('input', (e) => {
      S.itemQuery = e.target.value.trim();
      renderItems();
    });
    $('#itemFilter').addEventListener('click', (e) => {
      const b = e.target.closest('.segbtn');
      if (!b) return;
      S.itemFilter = b.dataset.f;
      $$('#itemFilter .segbtn').forEach((x) => x.classList.toggle('active', x === b));
      renderItems();
    });
    $('#itemsGrid').addEventListener('click', (e) => {
      const card = e.target.closest('.item-card');
      if (!card) return;
      S.selItem = card.dataset.name;
      renderItems();
      renderItemDetail(S.selItem);
      renderItemFlow(S.selItem);
    });
    $('#itemDetail').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'calc') {
        setTarget(btn.dataset.name);
        location.hash = '#calc';
        computeAndRender();
      } else if (btn.dataset.act === 'use') {
        setTarget(btn.dataset.name);
        location.hash = '#calc';
        computeAndRender();
      } else if (btn.dataset.act === 'flow') {
        renderItemFlow(btn.dataset.name);
        const panel = $('#itemFlow');
        if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });

    // 配方视图
    $('#recipeSearch').addEventListener('input', (e) => {
      S.recipeQuery = e.target.value.trim();
      renderRecipes();
    });
    const machineSel = $('#recipeMachine');
    const bldNames = Array.from(S.bld.values()).filter((b) => (b.production || []).length).map((b) => b.name);
    bldNames.sort((a, b) => (S.order.get(a) ?? 99) - (S.order.get(b) ?? 99) || collator.compare(a, b));
    machineSel.innerHTML = '<option value="all">全部设备</option>' +
      bldNames.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    machineSel.addEventListener('change', () => {
      S.recipeMachine = machineSel.value;
      renderRecipes();
    });

    // 设备视图
    $('#bldSearch').addEventListener('input', (e) => {
      S.bldQuery = e.target.value.trim();
      renderBuildings();
    });
    $('#bldFilter').addEventListener('click', (e) => {
      const b = e.target.closest('.segbtn');
      if (!b) return;
      S.bldFilter = b.dataset.f;
      $$('#bldFilter .segbtn').forEach((x) => x.classList.toggle('active', x === b));
      renderBuildings();
    });
    $('#bldGrid').addEventListener('click', (e) => {
      const b = e.target.closest('[data-recipes]');
      if (!b) return;
      S.recipeMachine = b.dataset.recipes;
      $('#recipeMachine').value = S.recipeMachine;
      S.recipeQuery = '';
      $('#recipeSearch').value = '';
      location.hash = '#recipes';
      renderRecipes();
    });

    // 默认目标
    const initial = new URLSearchParams(location.search);
    const pItem = initial.get('item');
    const pRate = parseFloat(initial.get('rate'));
    let target = pItem && S.prod.has(pItem) ? pItem : '高容谷地电池';
    if (!S.prod.has(target)) {
      target = Array.from(S.prod.keys()).sort(collator.compare)[0] || '';
    }
    S.target = target;
    if (isFinite(pRate) && pRate > 0) S.rate = pRate;
    input.value = S.target;
    rate.value = S.rate;
    updateComboIcon();
  }

  function setTarget(name) {
    if (!name || !S.prod.has(name)) return;
    S.target = name;
    S.overrides.delete(name);
    $('#targetInput').value = name;
    updateComboIcon();
    closeCombo();
    computeAndRender();
  }

  function updateComboIcon() {
    const info = S.items.get(S.target);
    const el = $('#comboIcon');
    if (info && info.icon) el.innerHTML = `<img src="${esc(info.icon)}" alt="">`;
    else el.innerHTML = '';
  }

  /* ---------------- combobox ---------------- */
  function comboMatches(q) {
    const list = Array.from(S.prod.keys());
    const s = (q || '').trim().toLowerCase();
    const filtered = s ? list.filter((n) => n.toLowerCase().includes(s)) : list;
    filtered.sort((a, b) => {
      if (s) {
        const ia = a.toLowerCase().indexOf(s);
        const ib = b.toLowerCase().indexOf(s);
        if (ia !== ib) return ia - ib;
      }
      return collator.compare(a, b);
    });
    return filtered.slice(0, 200);
  }

  function comboGroup(name) {
    const m = metaOf(name);
    if (m.typeCode === 'TacticalItem') return '战术物品与消耗品';
    if (m.typeCode === 'Material') return '工业材料与产物';
    return '其他可生产产物';
  }

  function openCombo(q) {
    const list = $('#comboList');
    const names = comboMatches(q);
    const combo = $('#combo');
    combo.classList.add('open');
    if (!names.length) {
      list.innerHTML = '<div class="combo-empty">没有匹配的可生产物品</div>';
      list.hidden = false;
      return;
    }
    const groups = new Map();
    names.forEach((n) => {
      const g = comboGroup(n);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(n);
    });
    let html = '';
    let idx = 0;
    groups.forEach((arr, g) => {
      html += `<div class="combo-group"><span>${esc(g)}</span><i>${arr.length}</i></div>`;
      arr.forEach((n) => {
        const info = S.items.get(n);
        const p = S.prod.get(n)[0];
        html += `<div class="combo-opt${idx === S.comboHl ? ' hl' : ''}" data-name="${esc(n)}">
          ${icoHTML(info)}
          <span class="nm">${esc(n)}</span>
          <span class="by">${esc(p.building)}</span>
        </div>`;
        idx++;
      });
    });
    list.innerHTML = html;
    list.hidden = false;
  }

  function closeCombo() {
    $('#comboList').hidden = true;
    $('#combo').classList.remove('open');
    const input = $('#targetInput');
    if (!input.value.trim()) input.value = S.target;
  }

  function onComboKey(e) {
    const list = $('#comboList');
    const opts = $$('.combo-opt', list);
    if (e.key === 'Escape') { closeCombo(); e.target.blur(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (S.comboHl >= 0 && opts[S.comboHl]) chooseTarget(opts[S.comboHl].dataset.name);
      else if (opts[0]) chooseTarget(opts[0].dataset.name);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!opts.length) return;
      S.comboHl = (S.comboHl + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      opts.forEach((o, i) => o.classList.toggle('hl', i === S.comboHl));
      opts[S.comboHl].scrollIntoView({ block: 'nearest' });
    }
  }

  function chooseTarget(name) {
    const input = $('#targetInput');
    input.value = name;
    setTarget(name);
  }

  /* ---------------- render: calc ---------------- */
  function renderCalc() {
    const plan = S.plan;
    if (!plan) return;
    const t = plan.totals;

    $('#summary').innerHTML = `
      <div class="stat"><div class="k">设备总台数</div><div class="v">${t.machines}<small>台</small></div><div class="s">${t.buildings} 种生产设备</div></div>
      <div class="stat"><div class="k">总耗电</div><div class="v">${nf(t.power, 0)}<small>kW</small></div><div class="s">按规划台数计</div></div>
      <div class="stat"><div class="k">原料种类</div><div class="v">${t.raw}<small>种</small></div><div class="s">需外部采集输入</div></div>
      <div class="stat"><div class="k">工序层级</div><div class="v">${t.maxDepth}<small>级</small></div><div class="s">T1 为终端成品</div></div>`;

    const ovCount = S.overrides.size;
    $('#planMeta').innerHTML = `目标 <b>${esc(S.target)}</b> · ${nf(S.rate, 2)}/min · ${plan.rows.length} 道工序` +
      (ovCount ? ` · <button class="linkbtn" id="ovReset">已改 ${ovCount} 道工序配方 · 重置</button>` : '') +
      ` · 数据 ${esc(S.data.fetchedAt || '')}`;

    // 生产链表格
    if (!plan.rows.length) {
      $('#chainTable').innerHTML = '<div class="empty">该目标是原料，没有上游生产链。</div>';
    } else {
      const body = plan.rows.map((r) => {
        const list = S.prod.get(r.name) || [];
        const sameRecipe = dedupeByRecipe(list);
        const options = sameRecipe.map((e) =>
          `<option value="${esc(e.key)}"${e.key === r.entry.key ? ' selected' : ''}>${esc(e.building)} · ${nf(e.outRate, 1)}/min</option>`
        ).join('');
        const deviceCell = sameRecipe.length > 1
          ? `<select class="mini" data-name="${esc(r.name)}" title="切换生产配方">${options}</select>`
          : `<span class="mono" style="font-size:11.5px;color:#a9bacc">${esc(r.entry.building)}</span>`;
        const outs = r.entry.recipe.outcomes.filter((o) => o.name !== r.name);
        const outNote = outs.length
          ? `<div class="rec" style="margin-top:3px;color:#6f8299">副产 ${outs.map((o) => `<span class="op">${esc(o.name)}×${nf(o.count, 2)}</span>`).join('、')}</div>`
          : '';
        return `<tr>
          <td><span class="tier${r.depth === 1 ? ' t1' : ''}">T${r.depth}</span></td>
          <td><div class="itemcell">${icoHTML(r.info)}<b title="${esc(r.name)}">${esc(r.name)}</b>${r.loop ? '<span class="loopbadge">循环</span>' : ''}</div></td>
          <td>${deviceCell}</td>
          <td><div class="rec">${recipeLine(r.entry.recipe, false)}${outNote}</div></td>
          <td class="td-r"><span class="num amber">${nf(r.need, 2)}</span></td>
          <td class="td-r"><span class="num soft">${nf(r.outRate, 2)}</span></td>
          <td class="td-r"><span class="num soft">${nf(r.machines, 3)}</span></td>
          <td class="td-r"><span class="plan-num">${r.plan}</span></td>
          <td class="td-r"><span class="num soft">${r.entry.power ? nf(r.power, 0) : '—'}${r.entry.power ? ' kW' : ''}</span></td>
        </tr>`;
      }).join('');

      $('#chainTable').innerHTML = `
        <table class="chain">
          <thead><tr>
            <th style="width:52px">层级</th>
            <th>产物</th>
            <th style="width:150px">生产设备</th>
            <th>单次配方</th>
            <th class="th-r" style="width:76px">需求/min</th>
            <th class="th-r" style="width:76px">单机/min</th>
            <th class="th-r" style="width:76px">精确台数</th>
            <th class="th-r" style="width:66px">规划</th>
            <th class="th-r" style="width:82px">耗电</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>`;
    }

    $('#chainNote').innerHTML = `台数 = 需求 ÷ 单机产能，向上取整；点击「生产设备」下拉可切换该工序的替代配方。` +
      (plan.loops.length ? ` 检测到循环链：${plan.loops.map(esc).join('、')}（已按物料平衡联立求解，供需对齐）。` : '') +
      (plan.totals.converged
        ? (plan.totals.truncated ? ' 部分中间品存在无法闭合的循环配方，已按外部采购处理。' : '')
        : ' 该配方组合存在无法自洽的循环，部分中间品已按外部采购处理。');

    renderSide(plan);
  }

  function dedupeByRecipe(list) {
    const seen = new Set();
    const out = [];
    list.forEach((e) => {
      if (seen.has(e.recipe.recipeId)) return;
      seen.add(e.recipe.recipeId);
      out.push(e);
    });
    return out;
  }

  function renderSide(plan) {
    const rows = plan.rows.slice().sort((a, b) => b.plan - a.plan || b.need - a.need).slice(0, 9);
    const maxPlan = rows.reduce((m, r) => Math.max(m, r.plan), 1);

    const rawHTML = plan.raw.length
      ? plan.raw.map((r) => `<div class="rowline">${icoHTML(r.info)}<span class="nm" title="${esc(r.name)}">${esc(r.name)}</span><span class="rt">${nf(r.need, 2)}</span></div>`).join('')
      : '<div class="mini-note">该目标为终端采集物，无需上游原料。</div>';

    const bpHTML = plan.bp.length
      ? plan.bp.map((b) => `<div class="rowline">${icoHTML(b.info)}<span class="nm" title="${esc(b.name)}">${esc(b.name)}</span><span class="rt cy">${nf(b.rate, 2)}</span></div>`).join('')
      : '<div class="mini-note">当前配方无副产物产出。</div>';

    const barsHTML = rows.length
      ? rows.map((r) => `<div class="bar"><span class="bn" title="${esc(r.name)}">${esc(r.name)}</span><span class="bt"><i style="width:${Math.max(4, (r.plan / maxPlan) * 100)}%"></i></span><span class="bv">${r.plan} 台</span></div>`).join('')
      : '<div class="mini-note">—</div>';

    $('#sidePanel').innerHTML = `
      <div class="side-sec">
        <h3>原料需求 <span class="h3count">${plan.raw.length} 种</span></h3>
        <div class="raw-list">${rawHTML}</div>
        <div class="mini-note">单位 /min · 未计入已开采的野外资源点。</div>
      </div>
      <div class="side-sec">
        <h3>副产物 <span class="h3count">${plan.bp.length} 种</span></h3>
        <div class="bp-list">${bpHTML}</div>
      </div>
      <div class="side-sec">
        <h3>设备台数分布 <span class="h3count">前 9</span></h3>
        <div class="bars">${barsHTML}</div>
        <div class="mini-note">总耗电 ${nf(plan.totals.power, 0)} kW · 共 ${plan.totals.machines} 台。</div>
      </div>`;
  }

  /* ---------------- render: items ---------------- */
  /* ---------------- 获取途径 ---------------- */
  const KIND = {
    craft: { label: '工厂生产', note: '' },
    extract: { label: '资源点抽取', note: '从野外存放点 / 矿点抽取' },
    plant: { label: '种植产出', note: '种植机播种收获' },
    seed: { label: '采种产出', note: '采种机留种' },
    salvage: { label: '拆解回收', note: '拆解机拆解获得' },
  };
  const KIND_ORDER = ['craft', 'extract', 'plant', 'seed', 'salvage'];

  function entryKind(e) {
    const b = e.building;
    if (b.indexOf('水泵') >= 0 || b.indexOf('气体收集泵') >= 0) return 'extract';
    if (b.indexOf('种植机') >= 0) return 'plant';
    if (b.indexOf('采种机') >= 0) return 'seed';
    if (b.indexOf('拆解机') >= 0) return 'salvage';
    return 'craft';
  }

  function metaOf(name) { return S.meta[name] || {}; }

  function obtainOf(name) {
    const producers = dedupeByRecipe(S.prod.get(name) || []);
    const groups = new Map();
    producers.forEach((e) => {
      const k = entryKind(e);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    });
    const meta = metaOf(name);
    const maps = meta.maps || [];
    const field = maps.length > 0 || meta.showingType === 'Ore' || meta.showingType === 'Plant';
    return { producers, groups, meta, maps, field };
  }

  function typeLabel(name) {
    const m = metaOf(name);
    if (m.typeCode === 'TacticalItem') return '战术物品';
    return m.showingTypeName || '物品';
  }

  /* ---------------- render: items ---------------- */
  function renderItems() {
    const all = Array.from(S.items.values());
    const q = S.itemQuery.toLowerCase();
    const list = all.filter((it) => {
      const m = metaOf(it.name);
      if (S.itemFilter === 'mat' && m.typeCode !== 'Material') return false;
      if (S.itemFilter === 'tact' && m.typeCode !== 'TacticalItem') return false;
      if (S.itemFilter === 'field' && !obtainOf(it.name).field) return false;
      if (!q) return true;
      return it.name.toLowerCase().includes(q) || (it.id || '').toLowerCase().includes(q) ||
        (m.desc || '').toLowerCase().includes(q) || (m.deco || '').toLowerCase().includes(q);
    });
    list.sort((a, b) => {
      const ma = metaOf(a.name), mb = metaOf(b.name);
      if (ma.typeCode !== mb.typeCode) return ma.typeCode === 'Material' ? -1 : 1;
      if ((b.rarity || 0) !== (a.rarity || 0)) return (b.rarity || 0) - (a.rarity || 0);
      return collator.compare(a.name, b.name);
    });

    $('#itemCount').textContent = `${list.length} / ${all.length} 种物品`;
    if (!list.length) {
      $('#itemsGrid').innerHTML = '<div class="empty" style="grid-column:1/-1">没有匹配的物品</div>';
      return;
    }
    $('#itemsGrid').innerHTML = list.map((it) => {
      const acq = obtainOf(it.name);
      const main = acq.producers[0];
      const sub = main ? `${KIND[entryKind(main)].label} · ${main.building}` : '暂无获取途径';
      const mark = acq.field ? '<i class="fieldmark" title="野外可采集"></i>' : '';
      return `<button class="item-card${it.name === S.selItem ? ' active' : ''}" data-name="${esc(it.name)}">
        ${icoHTML(it)}
        <span class="txt"><b>${esc(it.name)}</b><small>${esc(sub)}</small></span>
        <span class="card-tail">${rarHTML(it.rarity)}${mark}</span>
      </button>`;
    }).join('');
  }

  function obtainRowsHTML(name, acq) {
    const blocks = KIND_ORDER.filter((k) => acq.groups.has(k)).map((k) => {
      const rows = acq.groups.get(k).map((e) => {
        const outs = (e.recipe.outcomes || []).filter((o) => o.name !== name);
        return `<div class="ob-row">
          <div class="ob-main">${recipeLine(e.recipe, true)}</div>
          <div class="ob-sub">
            <span class="tag">${esc(e.building)}</span>
            <span class="num soft">单机 ${nf(e.outRate, 2)}/min</span>
            <span class="num soft">耗时 ${nf(e.recipe.craftSeconds, 1)}s</span>
            <span class="num soft">${e.power || 0} kW</span>
            ${outs.length ? `<span class="num soft">副产 ${outs.map((o) => esc(o.name)).join('、')}</span>` : ''}
          </div>
        </div>`;
      }).join('');
      return `<div class="obtain">
        <div class="ob-head"><b>${KIND[k].label}</b>${KIND[k].note ? `<span>${KIND[k].note}</span>` : ''}</div>
        ${rows}
      </div>`;
    }).join('');

    const fieldBlock = acq.field ? `<div class="obtain">
      <div class="ob-head"><b>野外采集</b><span>${esc(acq.meta.showingTypeName || '采集物')} · 可直接在大世界采集</span></div>
      <div class="ob-row"><div class="ob-sub">
        ${acq.maps.length
        ? acq.maps.map((m) => `<span class="tag amber">地图 ${esc(m.map || '—')}</span>`).join('')
        : '<span class="num soft">Wiki 未标注刷新点位 · 可在游戏内地图直接采集</span>'}
      </div></div>
    </div>` : '';

    if (!blocks && !fieldBlock) return '<div class="mini-note">Wiki 暂未收录该物品的获取方式。</div>';
    return blocks + fieldBlock;
  }

  function renderItemDetail(name) {
    const info = S.items.get(name);
    if (!info) return;
    const acq = obtainOf(name);
    const uses = (S.use.get(name) || []).slice();
    const seen = new Set();
    const uniqUses = [];
    uses.forEach((u) => {
      if (seen.has(u.product)) return;
      seen.add(u.product);
      uniqUses.push(u);
    });

    const useHTML = uniqUses.length
      ? uniqUses.slice(0, 12).map((u) =>
        `<button class="use-chip" data-act="use" data-name="${esc(u.product)}">${esc(u.product)}</button>`
      ).join('') + (uniqUses.length > 12 ? `<span class="mini-note" style="margin:0">+${uniqUses.length - 12} 项</span>` : '')
      : '<div class="mini-note">暂无下游配方引用。</div>';

    const m = acq.meta;
    $('#itemDetail').innerHTML = `
      <div class="detail-head">
        ${icoHTML(info)}
        <div>
          <h2>${esc(info.name)}</h2>
          <div class="sub">${rarHTML(info.rarity)}<span>${esc(typeLabel(name))}${m.group && m.group !== '物品' ? ' · ' + esc(m.group) : ''}</span></div>
        </div>
      </div>
      ${m.deco || m.desc ? `<p class="detail-desc">${esc(m.deco || m.desc)}</p>` : ''}
      <div class="detail-sec">
        <h4>获取途径</h4>
        ${obtainRowsHTML(name, acq)}
      </div>
      <div class="detail-sec">
        <h4>作为原料用于</h4>
        <div class="use-list">${useHTML}</div>
      </div>
      <div class="detail-actions">
        ${S.prod.has(name) ? `<button class="btn primary full" data-act="calc" data-name="${esc(name)}">以此为目标配平</button>` : ''}
        <button class="btn full" data-act="flow" data-name="${esc(name)}">查看自动化生产流程</button>
      </div>`;
    $('#itemDetail').dataset.name = name;
  }

  /* ---------------- 自动化生产流程（SVG） ---------------- */
  function fmtFlow(v) {
    if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
    if (v >= 10) return String(Math.round(v));
    return v.toFixed(1);
  }

  function renderItemFlow(name, rateArg) {
    const panel = $('#itemFlow');
    const wrap = $('#flowWrap');
    if (!panel || !wrap) return;
    if (!name || !S.prod.has(name)) { panel.hidden = true; wrap.innerHTML = ''; return; }
    const rate = rateArg || S.flowRate || 60;
    const savedOv = S.overrides;
    S.overrides = new Map();
    let plan;
    try { plan = computePlan(name, rate); } finally { S.overrides = savedOv; }

    const maxDepth = plan.rows.reduce((m, r) => Math.max(m, r.depth), 1);
    const ncols = maxDepth + 1;
    const NW = ncols >= 8 ? 140 : ncols >= 7 ? 150 : 166;
    const COLW = NW + (ncols >= 8 ? 32 : 46);
    const NH = 48, GAPY = 14, PAD = 16, TOP = 44;
    const nodes = new Map();
    plan.rows.forEach((r) => nodes.set(r.name, {
      name: r.name, info: r.info, depth: r.depth, need: r.need, plan: r.plan,
      outRate: r.outRate, raw: false, loop: r.loop, building: r.entry.building,
    }));
    plan.raw.forEach((x) => nodes.set(x.name, {
      name: x.name, info: x.info, depth: maxDepth + 1, need: x.need, raw: true, loop: false,
    }));

    const edges = [];
    plan.rows.forEach((r) => {
      (r.entry.recipe.ingredients || []).forEach((i) => {
        if (!nodes.has(i.name)) {
          nodes.set(i.name, {
            name: i.name, info: S.items.get(i.name) || { name: i.name },
            depth: maxDepth + 1, need: i.count, raw: true, loop: false,
          });
        }
        edges.push({ from: i.name, to: r.name, flow: r.crafts * i.count });
      });
    });

    const cols = new Map();
    nodes.forEach((n) => {
      n.col = Math.max(0, maxDepth + 1 - n.depth);
      if (!cols.has(n.col)) cols.set(n.col, []);
      cols.get(n.col).push(n);
    });
    const colList = [];
    for (let c = 0; c <= maxDepth; c++) colList.push(cols.get(c) || []);
    let maxRows = 1;
    colList.forEach((arr) => {
      arr.sort((a, b) => b.need - a.need);
      maxRows = Math.max(maxRows, arr.length);
      arr.forEach((n, i) => { n._row = i; n.x = PAD + n.col * COLW; n.y = TOP + i * (NH + GAPY); });
    });

    const preds = new Map();
    const succs = new Map();
    nodes.forEach((n) => { preds.set(n, []); succs.set(n, []); });
    edges.forEach((e) => {
      const a = nodes.get(e.from), b = nodes.get(e.to);
      if (!a || !b) return;
      preds.get(b).push(a);
      succs.get(a).push(b);
    });

    for (let pass = 0; pass < 2; pass++) {
      const rel = pass === 0 ? preds : succs;
      const cols2 = pass === 0 ? colList.slice(1) : colList.slice(0, -1).reverse();
      cols2.forEach((arr) => {
        const score = new Map();
        arr.forEach((n, i) => {
          const adj = (rel.get(n) || []).filter((x) => Math.abs(x.col - n.col) === 1);
          score.set(n, adj.length ? adj.reduce((sum, x) => sum + x._row, 0) / adj.length : n._row ?? i);
        });
        arr.sort((a, b) => (score.get(a) - score.get(b)) || (b.need - a.need));
        arr.forEach((n, i) => { n._row = i; n.y = TOP + i * (NH + GAPY); });
      });
    }
    const W = PAD * 2 + maxDepth * COLW + NW;
    const H = TOP + maxRows * (NH + GAPY) + PAD;

    const paths = [];
    const labels = [];
    const labelSpots = [];
    edges.forEach((e) => {
      const a = nodes.get(e.from), b = nodes.get(e.to);
      if (!a || !b) return;
      const x1 = a.x + NW, y1 = a.y + NH / 2;
      const x2 = b.x, y2 = b.y + NH / 2;
      const cyc = a.x >= b.x;
      const span = Math.max(1, b.col - a.col);
      const bow = 26 + span * 14;
      const d = cyc
        ? `M${x1} ${y1} C${x1 + 54} ${y1 - 40}, ${x2 - 54} ${y2 - 40}, ${x2} ${y2}`
        : `M${x1} ${y1} C${x1 + bow} ${y1}, ${x2 - bow} ${y2}, ${x2} ${y2}`;
      paths.push(`<path class="fl-edge${cyc ? ' cyc' : ''}" d="${d}" marker-end="url(#flArr)"><title>${esc(a.name)} → ${esc(b.name)}：${nf(e.flow, 2)}/min</title></path>`);
      const adjacent = b.col - a.col === 1;
      if (e.flow >= 0.05 && adjacent) {
        const flat = Math.abs(y2 - y1) <= 6;
        let lx = (x1 + x2) / 2;
        let ly = flat ? y1 - 7 : (y1 + y2) / 2 - 5;
        for (let guard = 0; guard < 8; guard++) {
          const clash = labelSpots.some((p) => Math.abs(p.x - lx) < 26 && Math.abs(p.y - ly) < 10);
          if (!clash) break;
          ly -= 9;
        }
        labelSpots.push({ x: lx, y: ly });
        labels.push(`<text class="fl-ew" x="${lx}" y="${ly}" text-anchor="middle">${fmtFlow(e.flow)}</text>`);
      }
    });

    const svgNodes = Array.from(nodes.values()).map((n) => {
      const cls = 'fl-node' + (n.raw ? ' raw' : '') + (n.col === maxDepth ? ' target' : '') + (n.loop ? ' loop' : '');
      const icon = n.info && n.info.icon
        ? `<image href="${esc(n.info.icon)}" x="${n.x + 9}" y="${n.y + 12}" width="26" height="26" preserveAspectRatio="xMidYMid meet"/>`
        : `<rect class="fl-noicon" x="${n.x + 9}" y="${n.y + 12}" width="26" height="26" rx="6"/>`;
      const cut = NW >= 158 ? 8 : 7;
      const nm = n.name.length > cut ? n.name.slice(0, cut) + '…' : n.name;
      const sub = n.raw
        ? `<tspan>${nf(n.need, 1)}/min · 外部</tspan>`
        : `<tspan>${n.plan} 台 · ${nf(n.need, 1)}/min</tspan>`;
      const badge = n.loop ? `<text class="fl-loop" x="${n.x + NW - 8}" y="${n.y + 15}" text-anchor="end">循环</text>` : '';
      return `<g class="${cls}">
        <rect x="${n.x}" y="${n.y}" width="${NW}" height="${NH}" rx="9"/>
        ${icon}
        <text class="fl-name" x="${n.x + 43}" y="${n.y + 20}">${esc(nm)}</text>
        <text class="fl-sub" x="${n.x + 43}" y="${n.y + 36}">${sub}</text>
        ${badge}
        <title>${esc(n.name)}${n.raw ? '（外部原料）' : ' · ' + esc(n.building || '') + ' · ' + n.plan + ' 台'}</title>
      </g>`;
    }).join('');

    let heads = '';
    for (let c = 0; c <= maxDepth; c++) {
      heads += `<text class="fl-th" x="${PAD + c * COLW + 2}" y="24">${c === 0 ? '外部原料' : 'T' + (maxDepth + 1 - c)}</text>`;
    }

    wrap.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="flArr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill="#6f8299"></path>
        </marker>
      </defs>
      ${heads}
      ${paths.join('')}
      ${svgNodes}
      <g class="fl-labels">${labels.join('')}</g>
    </svg>`;

    $('#flowMeta').textContent = `${nf(rate, 2)}/min · ${plan.rows.length} 道工序 · ${plan.totals.machines} 台 · ${plan.totals.power} kW · 原料 ${plan.totals.raw} 种`;
    panel.hidden = false;
    const hint = $('#flowHint');
    if (hint) hint.hidden = W <= wrap.clientWidth + 24;
    if (plan.totals.truncated) {
      $('#flowMeta').textContent += ' · 含外部采购';
    }
  }

  /* ---------------- render: recipes ---------------- */
  function renderRecipes() {
    const q = S.recipeQuery.toLowerCase();
    const rows = [];
    S.bld.forEach((b) => {
      if ((b.production || []).length === 0) return;
      if (S.recipeMachine !== 'all' && b.name !== S.recipeMachine) return;
      b.production.forEach((r) => {
        if (!r.outcomes || !r.outcomes.length) return;
        if (q) {
          const hit = r.outcomes.some((o) => o.name.toLowerCase().includes(q)) ||
            r.ingredients.some((i) => i.name.toLowerCase().includes(q)) ||
            (r.desc || '').toLowerCase().includes(q);
          if (!hit) return;
        }
        rows.push({ b, r });
      });
    });
    rows.sort((a, b) => (S.order.get(a.b.name) ?? 99) - (S.order.get(b.b.name) ?? 99) ||
      collator.compare(a.r.outcomes[0].name, b.r.outcomes[0].name));

    $('#recipeCount').textContent = `${rows.length} 条配方`;

    if (!rows.length) {
      $('#recipeTable').innerHTML = '<div class="empty">没有匹配的配方</div>';
      return;
    }

    const body = rows.map(({ b, r }) => {
      const main = r.outcomes[0];
      const extra = r.outcomes.slice(1);
      const rate = main.ratePerMin || (r.craftSeconds > 0 ? (main.count * 60) / r.craftSeconds : 0);
      return `<tr>
        <td><div class="itemcell">${icoHTML(S.items.get(main.name))}<b class="prodname">${esc(main.name)}</b></div></td>
        <td><span class="tag">${esc(b.name)}</span></td>
        <td class="td-r"><span class="num soft">${nf(r.craftSeconds, 1)}s</span></td>
        <td><div class="ing-line">${r.ingredients.map((i) => `<span class="ing">${esc(i.name)} <span class="amt">×${nf(i.count, 2)}</span></span>`).join('')}</div></td>
        <td class="td-r"><span class="num amber">${nf(rate, 2)}</span></td>
        <td><div class="ing-line">${extra.length ? extra.map((o) => `<span class="ing">${esc(o.name)} <span class="amt">×${nf(o.count, 2)}</span></span>`).join('') : '<span class="ing" style="color:#42515f">—</span>'}</div></td>
      </tr>`;
    }).join('');

    $('#recipeTable').innerHTML = `
      <table class="chain recipe-table">
        <thead><tr>
          <th>产物</th><th style="width:104px">设备</th><th class="th-r" style="width:62px">耗时</th>
          <th>原料消耗</th><th class="th-r" style="width:76px">产出/min</th><th style="width:200px">副产物</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  /* ---------------- render: buildings ---------------- */
  function renderBuildings() {
    const q = S.bldQuery.toLowerCase();
    const list = Array.from(S.bld.values()).filter((b) => {
      if (S.bldFilter === 'prod' && !(b.production || []).length) return false;
      if (!q) return true;
      return (b.name || '').toLowerCase().includes(q) || (b.desc || '').toLowerCase().includes(q);
    });
    list.sort((a, b) => {
      const pa = (a.production || []).length ? 0 : 1;
      const pb = (b.production || []).length ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return (S.order.get(a.name) ?? 99) - (S.order.get(b.name) ?? 99) || collator.compare(a.name, b.name);
    });

    $('#bldCount').textContent = `${list.length} 座建筑`;
    if (!list.length) {
      $('#bldGrid').innerHTML = '<div class="empty" style="grid-column:1/-1">没有匹配的建筑</div>';
      return;
    }

    $('#bldGrid').innerHTML = list.map((b) => {
      const specs = b.specs || {};
      const keys = Object.keys(specs).filter((k) => specs[k] != null && specs[k] !== '');
      const specHTML = keys.map((k) => `<div class="spec"><span class="sk">${esc(k)}</span><span class="sv">${esc(specs[k])}</span></div>`).join('');
      const n = (b.production || []).length;
      return `<div class="panel bld-card">
        <div class="bld-head">
          ${icoHTML({ icon: b.icon, name: b.name })}
          <div><h3>${esc(b.name)}</h3><div class="cat">${esc(b.category || '未分类')}${b.power ? ' · ' + esc(b.power) + ' kW' : ''}</div></div>
          <span class="tag">${n ? n + ' 配方' : '无配方'}</span>
        </div>
        <div class="specs">${specHTML}</div>
        <div class="bld-foot">
          <span class="rc">${esc(b.buildingId || '')}</span>
          ${n ? `<button class="linkbtn" data-recipes="${esc(b.name)}">查看配方 →</button>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  /* ---------------- routing ---------------- */
  function route() {
    const h = (location.hash || '#calc').replace('#', '') || 'calc';
    const view = ['calc', 'items', 'recipes', 'buildings'].includes(h) ? h : 'calc';
    S.view = view;

    $$('.view').forEach((v) => { v.hidden = v.id !== 'view-' + view; });
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === view));
    window.scrollTo({ top: 0, behavior: 'auto' });

    if (view === 'calc') computeAndRender();
    if (view === 'items') {
      if (!S.selItem) {
        const first = Array.from(S.items.keys()).sort(collator.compare).find((n) => S.prod.has(n));
        S.selItem = first || null;
      }
      renderItems();
      if (S.selItem) {
        renderItemDetail(S.selItem);
        renderItemFlow(S.selItem);
      }
    }
    if (view === 'recipes') renderRecipes();
    if (view === 'buildings') renderBuildings();
  }

  /* ---------------- actions ---------------- */
  function planText() {
    const p = S.plan;
    if (!p) return '';
    const lines = [];
    lines.push('【终末地 · 工业配平方案】');
    lines.push(`目标：${S.target}  ${nf(S.rate, 2)}/min`);
    lines.push(`设备总台数 ${p.totals.machines} 台 · 总耗电 ${nf(p.totals.power, 0)} kW · 原料 ${p.totals.raw} 种 · ${p.rows.length} 道工序`);
    lines.push('');
    lines.push('— 生产链 —');
    p.rows.forEach((r) => {
      lines.push(`T${r.depth} ${r.name}  ${r.entry.building}×${r.plan}  需求 ${nf(r.need, 2)}/min  单机 ${nf(r.outRate, 2)}/min`);
      lines.push(`    配方：${r.entry.recipe.ingredients.map((i) => i.name + '×' + nf(i.count, 2)).join(' + ')}`);
    });
    lines.push('');
    lines.push('— 原料需求 —');
    p.raw.forEach((r) => lines.push(`${r.name}  ${nf(r.need, 2)}/min`));
    if (p.bp.length) {
      lines.push('');
      lines.push('— 副产物 —');
      p.bp.forEach((b) => lines.push(`${b.name}  ${nf(b.rate, 2)}/min`));
    }
    return lines.join('\n');
  }

  function copyText(text, okMsg) {
    const done = () => toast(okMsg || '已复制到剪贴板');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选择文本'); }
    document.body.removeChild(ta);
  }

  function copyPlanText() {
    const txt = planText();
    if (!txt) { toast('请先生成配平方案'); return; }
    copyText(txt, '配平方案已复制');
  }

  function copyShareLink() {
    const url = `${location.origin}${location.pathname}?item=${encodeURIComponent(S.target)}&rate=${S.rate}#calc`;
    copyText(url, '分享链接已复制');
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => { el.hidden = true; }, 220);
    }, 2200);
  }
})();
