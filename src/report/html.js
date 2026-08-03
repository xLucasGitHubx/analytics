import { escapeXml as esc, sparkline, horizontalBars, funnel, kpiGauge, formatChartNumber } from "./charts.js";

// Page HTML autonome (§12.2) — reports/YYYY-MM/rapport.html. Tout le CSS et
// tous les graphiques (SVG) sont en ligne : aucune ressource externe (pas de
// CDN, pas de police distante, pas d'appel réseau). Thème clair ET sombre
// (`prefers-color-scheme` + surcharge `:root[data-theme]`). Tableaux larges
// dans un conteneur `overflow-x: auto` — le corps de page ne défile jamais
// horizontalement. `@media print` propre. Tout contenu injecté est échappé.

const decimalFormatter = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const preciseFormatter = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

function fmtEuros(n) {
  if (n == null || !Number.isFinite(n)) return "n/d";
  return `${formatChartNumber(n)} €`;
}

/** Montants unitaires (revenu par session, panier moyen) : arrondir à l'euro ferait disparaître la donnée (souvent < 1 €). */
function fmtEurosPrecise(n) {
  if (n == null || !Number.isFinite(n)) return "n/d";
  return `${preciseFormatter.format(n)} €`;
}

// Commandes Shopify : chaque boutique a SA devise réelle (EN=USD, FR/EU=EUR).
const CURRENCY_SYMBOLS = { EUR: "€", USD: "$" };

function fmtMoney(n, currency) {
  if (n == null || !Number.isFinite(n)) return "n/d";
  const symbol = CURRENCY_SYMBOLS[currency] || currency || "";
  return symbol ? `${formatChartNumber(n)} ${symbol}` : formatChartNumber(n);
}

function fmtMoneyPrecise(n, currency) {
  if (n == null || !Number.isFinite(n)) return "n/d";
  const symbol = CURRENCY_SYMBOLS[currency] || currency || "";
  return symbol ? `${preciseFormatter.format(n)} ${symbol}` : preciseFormatter.format(n);
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return "n/d";
  return `${decimalFormatter.format(n)} %`;
}

function deltaTone(delta, direction = "up") {
  if (!delta || delta.insufficient || delta.pct == null) return "neutral";
  const normalized = direction === "down" ? -delta.pct : delta.pct;
  return normalized >= 0 ? "good" : "bad";
}

function deltaText(delta, unitLabel) {
  if (!delta || delta.insufficient) {
    return `volume trop faible pour conclure (${formatChartNumber(delta?.base ?? 0)} ${unitLabel})`;
  }
  if (delta.pct == null) return "n/d";
  const sign = delta.pct > 0 ? "+" : "";
  return `${sign}${decimalFormatter.format(delta.pct)} %`;
}

function table(headers, rows, { emptyText = "Pas de données disponibles." } = {}) {
  if (!rows.length) {
    return `<p class="muted">${esc(emptyText)}</p>`;
  }
  const head = `<tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`;
  const body = rows
    .map((r) => `<tr>${r.map((c) => `<td>${c == null ? "n/d" : esc(String(c))}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function agentBlock(agentResult, { emptyLabel = "Analyse indisponible" } = {}) {
  if (!agentResult || !agentResult.ok) {
    const reason = esc(agentResult?.error || "raison inconnue");
    return `<p class="muted">${esc(emptyLabel)} (${reason}).</p>`;
  }
  const d = agentResult.data;
  const findings = d.findings?.length
    ? `<ul class="findings">${d.findings.map((f) => `<li><span class="tag tag-${esc(f.severity)}">${esc(f.severity)}</span> <strong>${esc(f.title)}</strong> — ${esc(f.detail)}</li>`).join("")}</ul>`
    : "";
  const watchouts = d.watchouts?.length
    ? `<p class="watchouts-title">Points de vigilance :</p><ul class="watchouts">${d.watchouts.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`
    : "";
  return `<p>${esc(d.summary)}</p>${findings}${watchouts}`;
}

function qualityBadge(level) {
  const label = { ok: "OK", warn: "Attention", critical: "Critique" }[level] || level;
  return `<span class="badge badge-${esc(level)}">${esc(label)}</span>`;
}

function section(id, title, bodyHtml) {
  return `<section id="${id}" class="report-section"><h2>${esc(title)}</h2>${bodyHtml}</section>`;
}

function renderKpiTiles(model) {
  const tiles = model.tiles
    .map((t) => {
      const momTone = deltaTone(t.mom, t.direction);
      const yoyTone = deltaTone(t.yoy, t.direction);
      const gauge = kpiGauge(t.mom?.insufficient ? null : t.mom?.pct ?? null, { direction: t.direction, green: t.green ?? 0, warn: t.warn ?? -10 });
      return `
        <div class="kpi-tile">
          <div class="kpi-label">${esc(t.label)}</div>
          <div class="kpi-value">${esc(t.valueLabel)}</div>
          <div class="kpi-gauge">${gauge}</div>
          <div class="kpi-delta tone-${momTone}">M-1 : ${esc(deltaText(t.mom, t.baseUnit))}</div>
          <div class="kpi-delta tone-${yoyTone}">M-12 : ${esc(deltaText(t.yoy, t.baseUnit))}</div>
        </div>`;
    })
    .join("");
  return `<div class="kpi-grid">${tiles}</div>`;
}

function renderSection1(model) {
  const banner = model.dataReady
    ? ""
    : `<p class="banner banner-warn">⚠️ Ce mois est encore récent : les données GSC/GA4 peuvent ne pas être totalement consolidées (latence ~3 jours). Les chiffres ci-dessous sont ceux disponibles à la date de génération.</p>`;
  const trend = model.dailySessionsSeries?.length
    ? `<div class="chart-block"><div class="chart-caption">Sessions par jour ce mois-ci</div>${sparkline(model.dailySessionsSeries, { width: 480, height: 64 })}</div>`
    : "";
  return section("apercu", "1. En un coup d'œil", `${banner}${renderKpiTiles(model)}${trend}`);
}

function renderSection2(model) {
  const exec = model.agents.executive;
  let body;
  if (!exec?.ok) {
    body = `<p class="muted">Synthèse indisponible (${esc(exec?.error || "raison inconnue")}).</p>`;
  } else {
    const keyFigures = exec.data.keyFigures?.length
      ? `<ul class="key-figures">${exec.data.keyFigures.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`
      : "";
    body = `<p>${esc(exec.data.synthesis)}</p>${keyFigures}`;
  }
  return section("changements", "2. Ce qui a changé ce mois-ci", body);
}

function renderSection3(model) {
  const chart = horizontalBars(
    model.acquisition.channels.map((c) => ({ label: c.channel, value: c.sessions })),
    { width: 520 }
  );
  const rows = model.acquisition.channels.map((c) => [
    c.channel,
    c.sharePct != null ? fmtPct(c.sharePct) : "n/d",
    fmtEurosPrecise(c.revenuePerSession),
    c.sessionsGap != null ? formatChartNumber(c.sessionsGap) : "n/d",
  ]);
  const body =
    `<div class="chart-block">${chart}</div>` +
    table(["Canal", "Part du trafic", "Revenu par session", "Écart 1er contact vs dernier clic"], rows) +
    agentBlock(model.agents.acquisition);
  return section("acquisition", "3. D'où viennent les visiteurs", body);
}

/**
 * Bloc « Commandes réelles (Shopify) » : un tableau par boutique dans SA
 * devise réelle (jamais une somme mêlant EUR et USD — au pire un sous-total
 * par devise). Répartition pays/canal : un comptage de commandes, agrégeable
 * sans risque de devise.
 */
function shopifySectionHtml(shopify) {
  if (!shopify || !shopify.ok) return "";

  const okSites = shopify.bySite.filter((s) => s.ok);
  const siteRows = okSites.map((s) => [
    s.siteKey,
    formatChartNumber(s.orders),
    fmtMoney(s.netRevenue, s.currency),
    fmtMoney(s.grossRevenue, s.currency),
    fmtMoney(s.discounts, s.currency),
    fmtMoney(s.refunds, s.currency),
    fmtMoneyPrecise(s.aov, s.currency),
  ]);

  const subtotals =
    shopify.subtotalsByCurrency.length > 1
      ? `<p class="muted">Sous-totaux par devise (jamais additionnés entre devises différentes) :</p><ul>${shopify.subtotalsByCurrency
          .map((g) => `<li><strong>${esc(g.currency)}</strong> (${esc(g.siteKeys.join(", "))}) : ${formatChartNumber(g.orders)} commandes, ${fmtMoney(g.netRevenue, g.currency)} net</li>`)
          .join("")}</ul>`
      : "";

  const countryRows = shopify.topCountries.map((c) => [c.country, formatChartNumber(c.orders)]);
  const channelRows = shopify.channels.map((c) => [c.label, formatChartNumber(c.orders)]);

  const availableForCustomers = okSites.filter((s) => s.newCustomers != null);
  const unavailableForCustomers = okSites.filter((s) => s.newCustomers == null && s.newCustomersUnavailableReason);
  const partialForCustomers = availableForCustomers.filter((s) => s.customerResolutionPartial);
  const customerRows = availableForCustomers.map((s) => [
    s.siteKey,
    formatChartNumber(s.newCustomers),
    formatChartNumber(s.returningCustomers),
    formatChartNumber(s.guestOrders),
    fmtPct(s.newCustomersRevenueSharePct),
    fmtPct(s.returningCustomersRevenueSharePct),
    fmtPct(s.guestRevenueSharePct),
  ]);
  const customersHtml =
    (availableForCustomers.length
      ? `<h3>Nouveaux vs récurrents vs invités (et part du CA brut)</h3>${table(
          ["Boutique", "Nouveaux clients", "Clients récurrents", "Invités", "Part CA — nouveaux", "Part CA — récurrents", "Part CA — invités"],
          customerRows
        )}`
      : "") +
    (partialForCustomers.length
      ? `<p class="banner banner-warn">Résolution partielle (budget d'appels API dépassé) pour ${esc(
          partialForCustomers.map((s) => `${s.siteKey} (${s.resolvedCustomerCount}/${s.totalUniqueCustomerCount} clients uniques résolus)`).join(", ")
        )} — les chiffres ci-dessus ne portent que sur les clients réellement résolus, pas l'ensemble.</p>`
      : "") +
    (unavailableForCustomers.length
      ? `<p class="muted">Nouveaux vs récurrents indisponible pour ${esc(unavailableForCustomers.map((s) => s.siteKey).join(", "))} : ${esc(unavailableForCustomers[0].newCustomersUnavailableReason)}</p>`
      : "");

  return (
    `<h3>Commandes réelles (Shopify)</h3>` +
    `<p>Ces chiffres sont les vraies commandes Shopify (la référence commerciale) ; les 6 tuiles du haut du rapport restent calculées à partir de GA4 pour comparer ce mois aux mois précédents de la même façon.</p>` +
    table(["Boutique", "Commandes", "CA net", "CA brut", "Remises", "Remboursements", "Panier moyen"], siteRows) +
    subtotals +
    customersHtml +
    `<h3>Répartition par pays (top 5)</h3>${table(["Pays", "Commandes"], countryRows)}` +
    `<h3>Répartition par canal de vente</h3>${table(["Canal", "Commandes"], channelRows)}`
  );
}

function renderSection4(model) {
  const e = model.ecommerce;
  const funnelSvg = funnel(e.funnelStages, { width: 480 });
  const productsChart = horizontalBars(e.topProducts.map((p) => ({ label: p.name, value: p.revenue })), { width: 520 });
  const pageRows = e.convertingPages.map((p) => [p.page, formatChartNumber(p.sessions), fmtEuros(p.revenue), formatChartNumber(p.transactions)]);
  const shopifyNote = model.shopifyNote ? `<p class="banner banner-info">ℹ️ ${esc(model.shopifyNote)}</p>` : "";
  const body =
    `<div class="chart-block"><div class="chart-caption">Entonnoir d'achat</div>${funnelSvg}` +
    `<div class="chart-caption">Le pourcentage entre parenthèses est le taux de passage depuis le stade précédent.</div></div>` +
    shopifyNote +
    shopifySectionHtml(e.shopify) +
    `<h3>Top produits</h3><div class="chart-block">${productsChart}</div>` +
    `<h3>Pages qui convertissent</h3>${table(["Page", "Sessions", "Revenu", "Commandes"], pageRows)}` +
    agentBlock(model.agents.ecommerce);
  return section("ecommerce", "4. Ce qui fait vendre", body);
}

function renderSection5(model) {
  const s = model.seo;
  const totalsRows = [
    ["Clics", formatChartNumber(s.totals.clicks), deltaText(s.totalsDeltas?.clicks, "clics")],
    ["Impressions", formatChartNumber(s.totals.impressions), deltaText(s.totalsDeltas?.impressions, "impressions")],
    ["Position moyenne", s.totals.position != null ? decimalFormatter.format(s.totals.position) : "n/d", "—"],
    ["CTR moyen", s.totals.ctr != null ? fmtPct(s.totals.ctr) : "n/d", "—"],
  ];
  const brandChart = horizontalBars(
    [
      { label: "Marque (Lovebox)", value: s.brandSplit.branded.clicks },
      { label: "Hors marque", value: s.brandSplit.nonBranded.clicks },
    ],
    { width: 480, maxBars: 2 }
  );
  const winners = s.winnersLosers.winners.slice(0, 10).map((w) => [w.query, formatChartNumber(w.clicksBefore), formatChartNumber(w.clicksNow), `+${formatChartNumber(w.delta)}`]);
  const losers = s.winnersLosers.losers.slice(0, 10).map((w) => [w.query, formatChartNumber(w.clicksBefore), formatChartNumber(w.clicksNow), formatChartNumber(w.delta)]);
  const opportunities = s.opportunities.slice(0, 10).map((o) => [
    o.query,
    o.position != null ? decimalFormatter.format(o.position) : "n/d",
    formatChartNumber(o.impressions),
    formatChartNumber(o.clicks),
    o.potentialCtrGain != null ? `${decimalFormatter.format(o.potentialCtrGain * 100)} pts` : "n/d",
  ]);
  const body =
    table(["Indicateur", "Valeur", "Δ vs mois précédent"], totalsRows) +
    `<h3>Marque vs hors marque</h3><div class="chart-block">${brandChart}</div>` +
    `<h3>Gagnants</h3>${table(["Requête", "Clics M-1", "Clics ce mois", "Variation"], winners)}` +
    `<h3>Perdants</h3>${table(["Requête", "Clics M-1", "Clics ce mois", "Variation"], losers)}` +
    `<h3>Top 10 opportunités concrètes</h3>${table(["Requête", "Position", "Impressions", "Clics", "Gain de CTR potentiel"], opportunities)}` +
    agentBlock(model.agents.seo);
  return section("seo", "5. Le référencement Google", body);
}

function renderSection6(model) {
  const b = model.blog;
  const chart = horizontalBars(b.topArticles.map((a) => ({ label: a.page, value: a.sessions })), { width: 520 });
  const reworkRows = b.toRework.map((a) => [a.page, formatChartNumber(a.sessions), a.engagementRate != null ? fmtPct(a.engagementRate) : "n/d"]);
  const body =
    `<p class="muted">Lecture seule : les actions de suppression/refresh d'articles restent dans le module « Suppression BLOG Useless ».</p>` +
    `<p>Trafic blog ce mois : <strong>${formatChartNumber(b.totalSessions)} sessions</strong>, <strong>${fmtEuros(b.totalRevenue)}</strong> de revenu attribué.</p>` +
    `<h3>Meilleurs articles</h3><div class="chart-block">${chart}</div>` +
    `<h3>Articles à retravailler</h3>${table(["Article", "Sessions", "Taux d'engagement"], reworkRows)}` +
    agentBlock(model.agents.content);
  return section("blog", "6. Le blog", body);
}

function renderSection7(model) {
  const a = model.aiVisibility;
  const chart = horizontalBars(a.bySource.map((s) => ({ label: s.source, value: s.sessions })), { width: 480 });
  const pageRows = a.topPages.map((p) => [p.page, p.source, formatChartNumber(p.sessions)]);
  const body =
    `<p>Sessions en provenance des assistants IA ce mois : <strong>${formatChartNumber(a.totalSessions)}</strong>.</p>` +
    `<div class="chart-block">${chart}</div>` +
    `<h3>Pages concernées</h3>${table(["Page", "Source", "Sessions"], pageRows)}` +
    agentBlock(model.agents.aiVisibility);
  return section("ia", "7. La visibilité dans les IA", body);
}

function renderSection8(model) {
  const rows = model.quality.checks.map((c) => [qualityBadge(c.level), c.title, c.detail, c.impact || "—"]);
  const rowsHtml = rows.length
    ? `<div class="table-wrap"><table><thead><tr><th>Statut</th><th>Contrôle</th><th>Détail</th><th>Impact</th></tr></thead><tbody>${rows
        .map((r) => `<tr><td>${r[0]}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td>${esc(r[3])}</td></tr>`)
        .join("")}</tbody></table></div>`
    : `<p class="muted">Pas de contrôle disponible.</p>`;
  const figures = model.unverifiedFigures?.length
    ? `<p class="banner banner-warn">⚠️ Chiffres non retrouvés dans les données (vérification automatique, non bloquant) :</p><ul>${model.unverifiedFigures
        .map((u) => `<li>Agent « ${esc(u.agent)} » : ${esc(u.figures.join(", "))}</li>`)
        .join("")}</ul>`
    : "";
  const body = rowsHtml + figures + agentBlock(model.agents.dataQuality);
  return section("qualite", "8. Peut-on faire confiance à ces chiffres ?", body);
}

function renderSection9(model) {
  const exec = model.agents.executive;
  if (!exec.ok) {
    return section("actions", "9. Les 3 actions du mois", `<p class="muted">Actions indisponibles (${esc(exec.error)}).</p>`);
  }
  const rows = [...exec.data.actions].sort((a, b) => a.priority - b.priority).map((a) => [a.priority, a.action, a.where, a.expectedImpact, a.owner]);
  const alert = exec.data.alert ? `<p class="banner banner-critical">🚨 Alerte : ${esc(exec.data.alert)}</p>` : "";
  return section("actions", "9. Les 3 actions du mois", table(["Priorité", "Action", "Où", "Impact attendu", "Qui"], rows) + alert);
}

function renderSection10(model) {
  const body = `
    <h3>Méthodologie</h3>
    <ul>
      <li>Période : ${esc(model.bounds.start)} → ${esc(model.bounds.end)} (mois calendaire). Comparaisons : M-1 = ${esc(model.months.previous)}, M-12 = ${esc(model.months.yearAgo)}.</li>
      <li>Garde-fou de significativité : une variation en % n'est affichée que si le volume sous-jacent atteint ${formatChartNumber(model.significance.minSessions)} sessions (ou ${formatChartNumber(model.significance.minTransactions)} transactions pour les métriques e-commerce).</li>
      <li>Sources : Google Analytics 4, Google Search Console, Shopify (si le scope <code>read_orders</code> est disponible).</li>
      <li>Rapport généré le ${esc(model.generatedAt)}.</li>
    </ul>
    <h3>Définitions</h3>
    <ul>
      <li><strong>CTR</strong> (taux de clic) : part des impressions qui se transforment en clic.</li>
      <li><strong>Impressions</strong> : nombre de fois où une page est apparue dans les résultats Google, sans forcément avoir été cliquée.</li>
      <li><strong>Taux d'engagement</strong> : part des sessions avec une interaction réelle — l'inverse du taux de rebond.</li>
      <li><strong>Écart 1er contact vs dernier clic</strong> : différence entre le canal de découverte et celui crédité de la conversion.</li>
      <li><strong>Striking distance</strong> : requêtes en position 4 à 15, déjà visibles mais sous-cliquées.</li>
    </ul>`;
  return section("annexes", "10. Annexes", body);
}

const STYLE = `
  :root {
    color-scheme: light;
    --chart-surface: #fcfcfb;
    --page-plane: #f9f9f7;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --text-muted: #898781;
    --grid: #e1e0d9;
    --baseline: #c3c2b7;
    --border: rgba(11,11,11,0.10);
    --chart-good: #006300;
    --chart-warn-fill: #b8860b;
    --chart-critical: #d03b3b;
    --chart-track: #e1e0d9;
    --chart-series-1: #2a78d6; --chart-series-2: #eb6834; --chart-series-3: #1baf7a; --chart-series-4: #eda100;
    --chart-series-5: #e87ba4; --chart-series-6: #008300; --chart-series-7: #4a3aa7; --chart-series-8: #e34948;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --chart-surface: #1a1a19; --page-plane: #0d0d0d; --text-primary: #ffffff; --text-secondary: #c3c2b7;
      --text-muted: #898781; --grid: #2c2c2a; --baseline: #383835; --border: rgba(255,255,255,0.10);
      --chart-good: #0ca30c; --chart-warn-fill: #c98500; --chart-critical: #e66767; --chart-track: #2c2c2a;
      --chart-series-1: #3987e5; --chart-series-2: #d95926; --chart-series-3: #199e70; --chart-series-4: #c98500;
      --chart-series-5: #d55181; --chart-series-6: #008300; --chart-series-7: #9085e9; --chart-series-8: #e66767;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --chart-surface: #1a1a19; --page-plane: #0d0d0d; --text-primary: #ffffff; --text-secondary: #c3c2b7;
    --text-muted: #898781; --grid: #2c2c2a; --baseline: #383835; --border: rgba(255,255,255,0.10);
    --chart-good: #0ca30c; --chart-warn-fill: #c98500; --chart-critical: #e66767; --chart-track: #2c2c2a;
    --chart-series-1: #3987e5; --chart-series-2: #d95926; --chart-series-3: #199e70; --chart-series-4: #c98500;
    --chart-series-5: #d55181; --chart-series-6: #008300; --chart-series-7: #9085e9; --chart-series-8: #e66767;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; overflow-x: hidden; }
  body {
    background: var(--page-plane); color: var(--text-primary);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1.55; padding: 24px; max-width: 960px; margin: 0 auto;
  }
  h1 { font-size: 1.6rem; margin-bottom: 4px; }
  h2 { font-size: 1.25rem; border-bottom: 1px solid var(--border); padding-bottom: 6px; margin-top: 40px; }
  h3 { font-size: 1.02rem; color: var(--text-secondary); margin-top: 24px; }
  .subtitle { color: var(--text-secondary); margin-top: 0; }
  .theme-toggle {
    position: fixed; top: 12px; right: 12px; z-index: 10;
    background: var(--chart-surface); color: var(--text-primary); border: 1px solid var(--border);
    border-radius: 999px; padding: 6px 12px; font-size: 0.8rem; cursor: pointer;
  }
  .report-section { background: var(--chart-surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 20px; margin-bottom: 16px; }
  .muted { color: var(--text-muted); }
  .banner { border-radius: 8px; padding: 10px 14px; font-size: 0.92rem; }
  .banner-warn { background: color-mix(in srgb, var(--chart-warn-fill) 15%, var(--chart-surface)); }
  .banner-info { background: color-mix(in srgb, var(--chart-series-1) 12%, var(--chart-surface)); }
  .banner-critical { background: color-mix(in srgb, var(--chart-critical) 15%, var(--chart-surface)); font-weight: 600; }
  .table-wrap { overflow-x: auto; margin: 12px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 0.92rem; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
  th { color: var(--text-secondary); font-weight: 600; }
  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 12px; }
  .kpi-tile { border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: var(--page-plane); }
  .kpi-label { color: var(--text-secondary); font-size: 0.82rem; }
  .kpi-value { font-size: 1.4rem; font-weight: 600; margin: 2px 0 8px; }
  .kpi-gauge { margin-bottom: 6px; }
  .kpi-delta { font-size: 0.8rem; }
  .tone-good { color: var(--chart-good); }
  .tone-bad { color: var(--chart-critical); }
  .tone-neutral { color: var(--text-muted); }
  .chart-block { margin: 10px 0; max-width: 100%; }
  .chart-caption { color: var(--text-secondary); font-size: 0.82rem; margin-bottom: 4px; }
  .chart-svg { max-width: 100%; height: auto; display: block; }
  .chart-label, .chart-value { fill: var(--text-secondary); font-size: 11px; }
  .chart-muted { fill: var(--text-muted); font-size: 12px; }
  .chart-value-on-fill { font-size: 11px; }
  .chart-value-below { fill: currentColor; font-size: 11px; }
  .chart-track { fill: var(--chart-track); }
  .findings, .watchouts, .key-figures { padding-left: 20px; }
  .findings li { margin-bottom: 4px; }
  .key-figures li { margin-bottom: 4px; font-weight: 600; }
  .tag { display: inline-block; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.02em; border-radius: 4px; padding: 1px 6px; margin-right: 4px; }
  .tag-positif { background: color-mix(in srgb, var(--chart-good) 20%, transparent); color: var(--chart-good); }
  .tag-neutre { background: var(--grid); color: var(--text-secondary); }
  .tag-attention { background: color-mix(in srgb, var(--chart-warn-fill) 25%, transparent); color: var(--chart-warn-fill); }
  .tag-critique { background: color-mix(in srgb, var(--chart-critical) 20%, transparent); color: var(--chart-critical); }
  .badge { font-size: 0.75rem; border-radius: 999px; padding: 2px 10px; white-space: nowrap; }
  .badge-ok { background: color-mix(in srgb, var(--chart-good) 20%, transparent); color: var(--chart-good); }
  .badge-warn { background: color-mix(in srgb, var(--chart-warn-fill) 25%, transparent); color: var(--chart-warn-fill); }
  .badge-critical { background: color-mix(in srgb, var(--chart-critical) 20%, transparent); color: var(--chart-critical); }
  footer { color: var(--text-muted); font-size: 0.78rem; margin-top: 32px; text-align: center; }
  @media print {
    body { max-width: none; padding: 0; background: #fff; color: #000; }
    .theme-toggle { display: none; }
    .report-section { border: none; page-break-inside: avoid; }
    .table-wrap { overflow-x: visible; }
  }
`;

/** Rend la page HTML autonome (§12.2). Aucune ressource externe, tout est en ligne. */
export function renderHtml(model) {
  const sections = [renderSection1, renderSection2, renderSection3, renderSection4, renderSection5, renderSection6, renderSection7, renderSection8, renderSection9, renderSection10]
    .map((fn) => fn(model))
    .join("\n");

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Rapport Lovebox Analytics — ${esc(model.monthLabel)}</title>
<style>${STYLE}</style>
</head>
<body>
<button type="button" class="theme-toggle" onclick="(function(){var r=document.documentElement;var cur=r.getAttribute('data-theme');r.setAttribute('data-theme', cur==='dark'?'light':'dark');})()">Clair / sombre</button>
<h1>Rapport Lovebox Analytics — ${esc(model.monthLabel)}</h1>
<p class="subtitle">Généré le ${esc(model.generatedAt)} · module lecture seule, aucune action d'écriture sur les sites.</p>
${sections}
<footer>Lovebox Analytics — ${esc(model.monthLabel)} · qualité des données : ${esc(model.quality.overallLevel)}</footer>
</body>
</html>`;
}
