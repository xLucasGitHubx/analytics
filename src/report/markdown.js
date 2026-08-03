// Rapport Markdown (§12.1) — reports/YYYY-MM/RAPPORT.md. Fonction pure :
// prend le `model` déjà calculé (KPI, insights, qualité, sorties agents) et
// renvoie une chaîne markdown. Les 10 sections sont dans l'ordre figé de la
// SPEC. Une variation en % n'est JAMAIS affichée sous le seuil de
// significativité (§9) : on écrit « volume trop faible pour conclure ».

const numberFormatter = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const decimalFormatter = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const preciseFormatter = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

function fmtNumber(n) {
  if (n == null || !Number.isFinite(n)) return "n/d";
  return numberFormatter.format(n);
}

function fmtEuros(n) {
  if (n == null || !Number.isFinite(n)) return "n/d";
  return `${numberFormatter.format(n)} €`;
}

/** Montants unitaires (revenu par session, panier moyen) : arrondir à l'euro ferait disparaître la donnée (souvent < 1 €). */
function fmtEurosPrecise(n) {
  if (n == null || !Number.isFinite(n)) return "n/d";
  return `${preciseFormatter.format(n)} €`;
}

// Commandes Shopify (§4) : chaque boutique a SA devise réelle (EN=USD,
// FR/EU=EUR) — jamais un € générique plaqué sur un montant qui n'en est pas.
const CURRENCY_SYMBOLS = { EUR: "€", USD: "$" };

function fmtMoney(n, currency) {
  if (n == null || !Number.isFinite(n)) return "n/d";
  const symbol = CURRENCY_SYMBOLS[currency] || currency || "";
  return symbol ? `${numberFormatter.format(n)} ${symbol}` : numberFormatter.format(n);
}

function fmtMoneyPrecise(n, currency) {
  if (n == null || !Number.isFinite(n)) return "n/d";
  const symbol = CURRENCY_SYMBOLS[currency] || currency || "";
  return symbol ? `${preciseFormatter.format(n)} ${symbol}` : preciseFormatter.format(n);
}

function fmtPosition(n) {
  if (n == null || !Number.isFinite(n)) return "n/d";
  return decimalFormatter.format(n);
}

/** Échappe le pipe et les retours à la ligne pour ne pas casser un tableau markdown. */
function cell(value) {
  const s = value == null ? "n/d" : String(value);
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** §9 — jamais de % sous le seuil de significativité : « volume trop faible pour conclure (N …) ». */
function fmtDelta(delta, unitLabel = "sessions") {
  if (!delta || delta.insufficient) {
    const base = delta?.base ?? 0;
    return `volume trop faible pour conclure (${fmtNumber(base)} ${unitLabel})`;
  }
  if (delta.pct == null) return "n/d";
  const sign = delta.pct > 0 ? "+" : "";
  return `${sign}${decimalFormatter.format(delta.pct)} %`;
}

function table(headers, rows) {
  if (!rows.length) return "_Pas de données disponibles._\n";
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map(cell).join(" | ")} |`).join("\n");
  return `${head}\n${sep}\n${body}\n`;
}

function agentSection(agentResult, { emptyLabel = "analyse indisponible" } = {}) {
  if (!agentResult || !agentResult.ok) {
    const reason = agentResult?.error || "raison inconnue";
    return `_${emptyLabel} (${reason})._\n`;
  }
  const d = agentResult.data;
  const lines = [d.summary, ""];
  if (d.findings?.length) {
    for (const f of d.findings) {
      lines.push(`- **${f.title}** — ${f.detail}`);
    }
    lines.push("");
  }
  if (d.watchouts?.length) {
    lines.push("Points de vigilance :");
    for (const w of d.watchouts) lines.push(`- ${w}`);
    lines.push("");
  }
  return lines.join("\n");
}

function qualityLevelLabel(level) {
  return { ok: "✅ OK", warn: "⚠️ Attention", critical: "🔴 Critique" }[level] || level;
}

function section1(model) {
  const rows = model.tiles.map((t) => [t.label, t.valueLabel, fmtDelta(t.mom, t.baseUnit), fmtDelta(t.yoy, t.baseUnit)]);
  const banner = model.dataReady
    ? ""
    : "\n> ⚠️ Ce mois est encore récent : les données GSC/GA4 peuvent ne pas être totalement consolidées (latence ~3 jours). Les chiffres ci-dessous sont ceux disponibles à la date de génération, pas une version finale.\n";
  return (
    `## 1. En un coup d'œil\n${banner}\n` +
    table(["Indicateur", "Valeur", "Δ vs mois précédent (M-1)", "Δ vs même mois l'an dernier (M-12)"], rows)
  );
}

function section2(model) {
  const exec = model.agents.executive;
  if (!exec?.ok) {
    return `## 2. Ce qui a changé ce mois-ci\n\n_synthèse indisponible (${exec?.error || "raison inconnue"})._\n`;
  }
  const lines = [exec.data.synthesis, ""];
  if (exec.data.keyFigures?.length) {
    for (const figure of exec.data.keyFigures) lines.push(`- ${figure}`);
    lines.push("");
  }
  return `## 2. Ce qui a changé ce mois-ci\n\n${lines.join("\n")}`;
}

function section3(model) {
  const rows = model.acquisition.channels.map((c) => [
    c.channel,
    c.sharePct != null ? `${decimalFormatter.format(c.sharePct)} %` : "n/d",
    fmtEurosPrecise(c.revenuePerSession),
    c.sessionsGap != null ? fmtNumber(c.sessionsGap) : "n/d",
  ]);
  return (
    `## 3. D'où viennent les visiteurs\n\n` +
    table(["Canal", "Part du trafic", "Revenu par session", "Écart 1er contact vs dernier clic (sessions)"], rows) +
    `\n${agentSection(model.agents.acquisition)}`
  );
}

/**
 * Bloc « Commandes réelles (Shopify) » (§4, défaut #1) : un tableau par
 * boutique dans SA devise réelle, jamais une somme mêlant EUR et USD (§ défaut
 * #2 — au pire un sous-total par devise). Répartition pays/canal : un
 * comptage de commandes, agrégeable sans risque de devise.
 */
function shopifyBlock(shopify) {
  if (!shopify || !shopify.ok) return "";

  const okSites = shopify.bySite.filter((s) => s.ok);
  const siteRows = okSites.map((s) => [
    s.siteKey,
    fmtNumber(s.orders),
    fmtMoney(s.netRevenue, s.currency),
    fmtMoney(s.grossRevenue, s.currency),
    fmtMoney(s.discounts, s.currency),
    fmtMoney(s.refunds, s.currency),
    fmtMoneyPrecise(s.aov, s.currency),
  ]);

  const subtotals =
    shopify.subtotalsByCurrency.length > 1
      ? `\n_Sous-totaux par devise (jamais additionnés entre devises différentes)_ :\n\n` +
        shopify.subtotalsByCurrency
          .map((g) => `- **${g.currency}** (${g.siteKeys.join(", ")}) : ${fmtNumber(g.orders)} commandes, ${fmtMoney(g.netRevenue, g.currency)} net`)
          .join("\n") +
        "\n"
      : "";

  const countryRows = shopify.topCountries.map((c) => [c.country, fmtNumber(c.orders)]);
  const channelRows = shopify.channels.map((c) => [c.label, fmtNumber(c.orders)]);

  const availableForCustomers = okSites.filter((s) => s.newCustomers != null);
  const unavailableForCustomers = okSites.filter((s) => s.newCustomers == null && s.newCustomersUnavailableReason);
  const partialForCustomers = availableForCustomers.filter((s) => s.customerResolutionPartial);
  const fmtSharePct = (pct) => (pct != null ? `${decimalFormatter.format(pct)} %` : "n/d");
  const customerRows = availableForCustomers.map((s) => [
    s.siteKey,
    fmtNumber(s.newCustomers),
    fmtNumber(s.returningCustomers),
    fmtNumber(s.guestOrders),
    fmtSharePct(s.newCustomersRevenueSharePct),
    fmtSharePct(s.returningCustomersRevenueSharePct),
    fmtSharePct(s.guestRevenueSharePct),
  ]);
  const customersBlock =
    (availableForCustomers.length
      ? `\n**Nouveaux vs récurrents vs invités (et part du CA brut)**\n\n` +
        table(
          ["Boutique", "Nouveaux clients", "Clients récurrents", "Invités", "Part CA — nouveaux", "Part CA — récurrents", "Part CA — invités"],
          customerRows
        ) +
        "\n"
      : "") +
    (partialForCustomers.length
      ? `\n_Résolution partielle (budget d'appels API dépassé) pour ${partialForCustomers
          .map((s) => `${s.siteKey} (${fmtNumber(s.resolvedCustomerCount)}/${fmtNumber(s.totalUniqueCustomerCount)} clients uniques résolus)`)
          .join(", ")} — les chiffres ci-dessus ne portent que sur les clients réellement résolus, pas l'ensemble._\n`
      : "") +
    (unavailableForCustomers.length
      ? `\n_Nouveaux vs récurrents indisponible pour ${unavailableForCustomers.map((s) => s.siteKey).join(", ")} : ${unavailableForCustomers[0].newCustomersUnavailableReason}_\n`
      : "");

  return (
    `**Commandes réelles (Shopify)**\n\n` +
    `Ces chiffres sont les vraies commandes Shopify (la référence commerciale) ; les 6 tuiles du haut du rapport restent calculées à partir de GA4 pour comparer ce mois aux mois précédents de la même façon.\n\n` +
    table(["Boutique", "Commandes", "CA net", "CA brut", "Remises", "Remboursements", "Panier moyen"], siteRows) +
    subtotals +
    customersBlock +
    `\n**Répartition par pays (top 5)**\n\n${table(["Pays", "Commandes"], countryRows)}\n` +
    `**Répartition par canal de vente**\n\n${table(["Canal", "Commandes"], channelRows)}\n`
  );
}

function section4(model) {
  const e = model.ecommerce;
  const funnelLines = e.funnelStages
    .map((s, i) => {
      const prev = e.funnelStages[i - 1];
      const pct = prev && prev.value ? ((s.value / prev.value) * 100).toFixed(0) : null;
      return `${i + 1}. **${s.label}** : ${fmtNumber(s.value)}${pct != null ? ` (${pct}% du stade précédent)` : ""}`;
    })
    .join("\n");
  const productRows = e.topProducts.map((p) => [p.name, fmtEuros(p.revenue), fmtNumber(p.itemsPurchased)]);
  const pageRows = e.convertingPages.map((p) => [p.page, fmtNumber(p.sessions), fmtEuros(p.revenue), fmtNumber(p.transactions)]);
  const shopifyNote = model.shopifyNote ? `\n> ℹ️ ${model.shopifyNote}\n` : "";
  return (
    `## 4. Ce qui fait vendre\n\n` +
    `**Entonnoir d'achat**\n\n${funnelLines}\n${shopifyNote}\n` +
    shopifyBlock(e.shopify) +
    `\n**Top produits**\n\n${table(["Produit", "Revenu", "Unités vendues"], productRows)}\n` +
    `**Pages qui convertissent**\n\n${table(["Page", "Sessions", "Revenu", "Commandes"], pageRows)}\n` +
    `\n${agentSection(model.agents.ecommerce)}`
  );
}

function section5(model) {
  const s = model.seo;
  const totalsRows = [
    ["Clics", fmtNumber(s.totals.clicks), fmtDelta(s.totalsDeltas?.clicks, "clics")],
    ["Impressions", fmtNumber(s.totals.impressions), fmtDelta(s.totalsDeltas?.impressions, "impressions")],
    ["Position moyenne", fmtPosition(s.totals.position), "—"],
    ["CTR moyen (part des impressions qui deviennent un clic)", s.totals.ctr != null ? `${decimalFormatter.format(s.totals.ctr)} %` : "n/d", "—"],
  ];
  const brandRows = [
    ["Marque (nom Lovebox)", fmtNumber(s.brandSplit.branded.clicks), fmtNumber(s.brandSplit.branded.impressions)],
    ["Hors marque", fmtNumber(s.brandSplit.nonBranded.clicks), fmtNumber(s.brandSplit.nonBranded.impressions)],
  ];
  const winners = s.winnersLosers.winners.slice(0, 10).map((w) => [w.query, fmtNumber(w.clicksBefore), fmtNumber(w.clicksNow), `+${fmtNumber(w.delta)}`]);
  const losers = s.winnersLosers.losers.slice(0, 10).map((w) => [w.query, fmtNumber(w.clicksBefore), fmtNumber(w.clicksNow), fmtNumber(w.delta)]);
  const opportunities = s.opportunities.slice(0, 10).map((o) => [
    o.query,
    fmtPosition(o.position),
    fmtNumber(o.impressions),
    fmtNumber(o.clicks),
    o.potentialCtrGain != null ? `${decimalFormatter.format(o.potentialCtrGain * 100)} pts` : "n/d",
  ]);
  return (
    `## 5. Le référencement Google\n\n` +
    table(["Indicateur", "Valeur", "Δ vs mois précédent"], totalsRows) +
    `\n**Marque (« Lovebox ») vs hors marque** — un déclin sur la marque est un signal de notoriété, un déclin hors marque est un vrai signal SEO :\n\n` +
    table(["Catégorie", "Clics", "Impressions"], brandRows) +
    `\n**Gagnants (clics en hausse)**\n\n${table(["Requête", "Clics M-1", "Clics ce mois", "Variation"], winners)}\n` +
    `**Perdants (clics en baisse)**\n\n${table(["Requête", "Clics M-1", "Clics ce mois", "Variation"], losers)}\n` +
    `**Top 10 opportunités concrètes** (position 4 à 15, déjà visibles mais sous-cliquées) :\n\n` +
    table(["Requête", "Position", "Impressions", "Clics", "Gain de CTR potentiel"], opportunities) +
    `\n${agentSection(model.agents.seo)}`
  );
}

function section6(model) {
  const b = model.blog;
  const topRows = b.topArticles.map((a) => [a.page, fmtNumber(a.sessions), fmtEuros(a.revenue), a.engagementRate != null ? `${decimalFormatter.format(a.engagementRate)} %` : "n/d"]);
  const reworkRows = b.toRework.map((a) => [a.page, fmtNumber(a.sessions), a.engagementRate != null ? `${decimalFormatter.format(a.engagementRate)} %` : "n/d"]);
  return (
    `## 6. Le blog\n\n` +
    `> Lecture seule : les actions de suppression/refresh d'articles restent dans le module \`Suppression BLOG Useless\`.\n\n` +
    `Trafic blog ce mois : **${fmtNumber(b.totalSessions)} sessions**, **${fmtEuros(b.totalRevenue)}** de revenu attribué.\n\n` +
    `**Meilleurs articles**\n\n${table(["Article", "Sessions", "Revenu", "Taux d'engagement (part des sessions avec interaction réelle)"], topRows)}\n` +
    `**Articles à retravailler** (trafic significatif, engagement faible)\n\n${table(["Article", "Sessions", "Taux d'engagement"], reworkRows)}\n` +
    `\n${agentSection(model.agents.content)}`
  );
}

function section7(model) {
  const a = model.aiVisibility;
  const sourceRows = a.bySource.map((s) => [s.source, fmtNumber(s.sessions), fmtEuros(s.revenue)]);
  const pageRows = a.topPages.map((p) => [p.page, p.source, fmtNumber(p.sessions)]);
  return (
    `## 7. La visibilité dans les IA\n\n` +
    `Sessions en provenance des assistants IA (ChatGPT, Perplexity, Claude, Gemini, Copilot…) ce mois : **${fmtNumber(a.totalSessions)}**.\n\n` +
    `**Par source**\n\n${table(["Source", "Sessions", "Revenu"], sourceRows)}\n` +
    `**Pages concernées**\n\n${table(["Page", "Source", "Sessions"], pageRows)}\n` +
    `\n${agentSection(model.agents.aiVisibility)}`
  );
}

function section8(model) {
  const rows = model.quality.checks.map((c) => [qualityLevelLabel(c.level), c.title, c.detail, c.impact || "—"]);
  const figures = model.unverifiedFigures?.length
    ? `\n> ⚠️ **Chiffres non retrouvés dans les données** (vérification automatique, non bloquant — §11) :\n` +
      model.unverifiedFigures.map((u) => `> - Agent « ${u.agent} » : ${u.figures.join(", ")}`).join("\n") +
      "\n"
    : "";
  return (
    `## 8. Peut-on faire confiance à ces chiffres ?\n\n` +
    table(["Statut", "Contrôle", "Détail", "Impact"], rows) +
    figures +
    `\n${agentSection(model.agents.dataQuality)}`
  );
}

function section9(model) {
  const exec = model.agents.executive;
  if (!exec.ok) {
    return `## 9. Les 3 actions du mois\n\n_actions indisponibles (${exec.error})._\n`;
  }
  const rows = [...exec.data.actions].sort((a, b) => a.priority - b.priority).map((a) => [a.priority, a.action, a.where, a.expectedImpact, a.owner]);
  const alert = exec.data.alert ? `\n> 🚨 **Alerte** : ${exec.data.alert}\n` : "";
  return `## 9. Les 3 actions du mois\n\n${table(["Priorité", "Action", "Où", "Impact attendu", "Qui"], rows)}${alert}`;
}

function section10(model) {
  const lines = [
    "## 10. Annexes",
    "",
    "**Méthodologie**",
    "",
    `- Période : ${model.bounds.start} → ${model.bounds.end} (mois calendaire). Comparaisons : M-1 = ${model.months.previous}, M-12 = ${model.months.yearAgo}.`,
    `- Garde-fou de significativité : une variation en % n'est affichée que si le volume sous-jacent atteint ${fmtNumber(model.significance.minSessions)} sessions (ou ${fmtNumber(model.significance.minTransactions)} transactions pour les métriques e-commerce). En dessous, le rapport écrit « volume trop faible pour conclure ».`,
    "- Sources : Google Analytics 4 (trafic, e-commerce), Google Search Console (référencement), Shopify (commandes réelles, si le scope `read_orders` est disponible).",
    `- Rapport généré le ${model.generatedAt}.`,
    "",
    "**Définitions**",
    "",
    "- **CTR** (taux de clic) : part des impressions (apparitions dans les résultats Google) qui se transforment en clic.",
    "- **Impressions** : nombre de fois où une page est apparue dans les résultats de recherche, sans forcément avoir été cliquée.",
    "- **Taux d'engagement** : part des sessions avec une interaction réelle (plus de 10 secondes, un événement clé, ou plusieurs pages vues) — l'inverse du taux de rebond.",
    "- **Écart 1er contact vs dernier clic** : différence entre le canal qui a amené le visiteur la première fois (découverte) et celui qui a reçu le crédit de la conversion (dernier clic avant achat). Un canal de découverte comme le blog peut sembler faible en dernier clic tout en étant un vrai moteur en première visite.",
    "- **Striking distance** : requêtes déjà bien positionnées (entre la 4e et la 15e position) mais encore sous-cliquées — l'opportunité la plus rapide à activer.",
    "",
  ];
  return lines.join("\n");
}

/** Rend le rapport Markdown complet (§12.1), les 10 sections dans l'ordre figé. */
export function renderMarkdown(model) {
  const title = `# Rapport Lovebox Analytics — ${model.monthLabel}`;
  const sections = [section1, section2, section3, section4, section5, section6, section7, section8, section9, section10].map((fn) => fn(model));
  return [title, "", ...sections].join("\n\n");
}
