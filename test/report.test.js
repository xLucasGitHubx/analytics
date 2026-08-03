import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/report/markdown.js";
import { renderHtml } from "../src/report/html.js";

function unavailableAgent(reason = "agents désactivés (--no-ai)") {
  return { ok: false, data: null, unverifiedFigures: [], error: reason };
}

/**
 * Modèle minimal mais complet — tous les champs lus par markdown.js/html.js
 * sont présents. Les 6 tuiles ont volontairement un delta `insufficient`
 * (base sous le seuil de significativité) et un `valueLabel` sans "%", pour
 * pouvoir vérifier qu'aucune variation en % n'apparaît dans la section 1.
 */
function buildFakeModel(overrides = {}) {
  const insufficientDelta = (base) => ({ insufficient: true, base });

  const tiles = [
    { key: "totalUsers", label: "Visiteurs", valueLabel: "42", mom: insufficientDelta(42), yoy: insufficientDelta(10), baseUnit: "sessions", direction: "up" },
    { key: "sessions", label: "Sessions", valueLabel: "50", mom: insufficientDelta(42), yoy: insufficientDelta(10), baseUnit: "sessions", direction: "up" },
    { key: "transactions", label: "Commandes", valueLabel: "2", mom: insufficientDelta(2), yoy: insufficientDelta(1), baseUnit: "transactions", direction: "up" },
    { key: "aov", label: "Panier moyen", valueLabel: "n/d", mom: insufficientDelta(2), yoy: insufficientDelta(1), baseUnit: "transactions", direction: "up" },
  ];

  return {
    month: "2026-06",
    monthLabel: "juin 2026",
    generatedAt: "2026-07-03T06:00:00.000Z",
    bounds: { start: "2026-06-01", end: "2026-06-30" },
    months: { current: "2026-06", previous: "2026-05", yearAgo: "2025-06" },
    dataReady: true,
    tiles,
    quality: {
      checks: [{ id: "unknown-hosts", level: "ok", title: "Hosts GA4 non déclarés", detail: "Tous les hosts sont déclarés.", impact: null }],
      overallLevel: "ok",
    },
    acquisition: { channels: [] },
    ecommerce: {
      funnelStages: [
        { label: "Vue produit", value: 100 },
        { label: "Ajout au panier", value: 20 },
        { label: "Paiement démarré", value: 10 },
        { label: "Achat", value: 4 },
      ],
      topProducts: [],
      convertingPages: [],
    },
    seo: {
      totals: { clicks: 10, impressions: 100, position: 12.3, ctr: 10 },
      totalsDeltas: { clicks: insufficientDelta(10), impressions: insufficientDelta(100) },
      brandSplit: { branded: { clicks: 5, impressions: 50 }, nonBranded: { clicks: 5, impressions: 50 } },
      winnersLosers: { winners: [], losers: [] },
      opportunities: [],
    },
    blog: { totalSessions: 30, totalRevenue: 0, topArticles: [], toRework: [] },
    aiVisibility: { totalSessions: 5, totalRevenue: 0, bySource: [], topPages: [] },
    agents: {
      acquisition: unavailableAgent(),
      seo: unavailableAgent(),
      content: unavailableAgent(),
      ecommerce: unavailableAgent(),
      aiVisibility: unavailableAgent(),
      dataQuality: unavailableAgent(),
      executive: unavailableAgent(),
    },
    unverifiedFigures: [],
    significance: { minSessions: 100, minTransactions: 5 },
    shopifyNote: "Données Shopify indisponibles ce mois — le chiffre d'affaires affiché provient de GA4.",
    dailySessionsSeries: [1, 2, 3, null, 5],
    ...overrides,
  };
}

function extractMarkdownSection(md, sectionTitleStart, nextSectionTitleStart) {
  const start = md.indexOf(sectionTitleStart);
  assert.notEqual(start, -1, `section "${sectionTitleStart}" introuvable`);
  const end = nextSectionTitleStart ? md.indexOf(nextSectionTitleStart, start) : md.length;
  assert.notEqual(end, -1, `section suivante "${nextSectionTitleStart}" introuvable`);
  return md.slice(start, end);
}

describe("report/markdown — garde-fou de significativité (§9)", () => {
  test("aucune variation en % n'est affichée sous le seuil — « volume trop faible pour conclure » à la place", () => {
    const model = buildFakeModel();
    const md = renderMarkdown(model);
    const section1 = extractMarkdownSection(md, "## 1. En un coup d'œil", "## 2.");

    assert.match(section1, /volume trop faible pour conclure/);
    // Les 4 tuiles ont volontairement des valeurs sans "%" et des deltas
    // insuffisants : aucun caractère "%" ne doit apparaître dans cette section.
    assert.equal(section1.includes("%"), false, "aucun % de variation ne doit apparaître sous le seuil de significativité");
  });

  test("un delta suffisant affiche bien un pourcentage", () => {
    const model = buildFakeModel({
      tiles: [
        { key: "sessions", label: "Sessions", valueLabel: "1 500", mom: { insufficient: false, base: 1000, abs: 500, pct: 50, direction: "up" }, yoy: { insufficient: false, base: 900, abs: 600, pct: 66.7, direction: "up" }, baseUnit: "sessions", direction: "up" },
      ],
    });
    const md = renderMarkdown(model);
    const section1 = extractMarkdownSection(md, "## 1. En un coup d'œil", "## 2.");
    assert.match(section1, /\+50[.,]0 %/);
  });

  test("les 10 sections sont présentes, dans l'ordre", () => {
    const md = renderMarkdown(buildFakeModel());
    const titles = [
      "## 1. En un coup d'œil",
      "## 2. Ce qui a changé ce mois-ci",
      "## 3. D'où viennent les visiteurs",
      "## 4. Ce qui fait vendre",
      "## 5. Le référencement Google",
      "## 6. Le blog",
      "## 7. La visibilité dans les IA",
      "## 8. Peut-on faire confiance à ces chiffres ?",
      "## 9. Les 3 actions du mois",
      "## 10. Annexes",
    ];
    let cursor = -1;
    for (const title of titles) {
      const idx = md.indexOf(title);
      assert.ok(idx > cursor, `section "${title}" manquante ou mal ordonnée`);
      cursor = idx;
    }
  });

  test("agent indisponible -> « analyse indisponible » avec la raison, pas de crash", () => {
    const md = renderMarkdown(buildFakeModel());
    assert.match(md, /analyse indisponible \(agents désactivés \(--no-ai\)\)/);
  });
});

describe("report/markdown — bloc Commandes réelles (Shopify) (§ défauts #1/#2/#3)", () => {
  function shopifyModel(shopifyOverrides = {}) {
    return buildFakeModel({
      ecommerce: {
        funnelStages: [
          { label: "Vue produit", value: 100 },
          { label: "Ajout au panier", value: 20 },
          { label: "Paiement démarré", value: 10 },
          { label: "Achat", value: 4 },
        ],
        topProducts: [],
        convertingPages: [],
        shopify: {
          ok: true,
          scopeMissing: false,
          bySite: [
            {
              siteKey: "EN", ok: true, reason: null, currency: "USD", orders: 219,
              grossRevenue: 20713.58, discounts: 5383.81, refunds: 671.4, netRevenue: 20042.18, aov: 91.52,
              newCustomers: null, returningCustomers: null,
              newCustomersUnavailableReason: "scope Shopify \"read_customers\" manquant : ...",
            },
            {
              siteKey: "FR", ok: true, reason: null, currency: "EUR", orders: 58,
              grossRevenue: 3800, discounts: 262.12, refunds: 0, netRevenue: 3537.88, aov: 61.0,
              newCustomers: null, returningCustomers: null,
              newCustomersUnavailableReason: "scope Shopify \"read_customers\" manquant : ...",
            },
          ],
          subtotalsByCurrency: [{ currency: "EUR", orders: 58, netRevenue: 3537.88, grossRevenue: 3800, siteKeys: ["FR"] }],
          topCountries: [{ country: "US", orders: 214 }, { country: "CA", orders: 5 }],
          channels: [
            { channel: "web", label: "Boutique en ligne", orders: 20 },
            { channel: "9764908", label: "Application n°9764908", orders: 93 },
          ],
          ...shopifyOverrides,
        },
      },
      shopifyNote: "Commandes réelles Shopify disponibles pour EN, FR — voir le détail dans cette section.",
    });
  }

  test("chaque boutique affiche SA devise, jamais un total mélangeant EUR et USD", () => {
    const md = renderMarkdown(shopifyModel());
    const section4 = extractMarkdownSection(md, "## 4. Ce qui fait vendre", "## 5.");
    const nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
    assert.ok(section4.includes(`${nf.format(20042.18)} $`), "EN doit être en dollars");
    assert.ok(section4.includes(`${nf.format(3537.88)} €`), "FR doit être en euros");
    // Pas de tableau qui mélangerait silencieusement les deux devises dans une seule cellule totale.
    assert.ok(!section4.includes(nf.format(20042.18 + 3537.88)), "aucune somme brute EN+FR ne doit apparaître");
  });

  test("canaux techniques traduits en libellés lisibles", () => {
    const md = renderMarkdown(shopifyModel());
    const section4 = extractMarkdownSection(md, "## 4. Ce qui fait vendre", "## 5.");
    assert.match(section4, /Boutique en ligne/);
    assert.match(section4, /Application n°9764908/);
  });

  test("nouveau vs récurrent indisponible -> pas de ligne à 0, la raison est affichée", () => {
    const md = renderMarkdown(shopifyModel());
    const section4 = extractMarkdownSection(md, "## 4. Ce qui fait vendre", "## 5.");
    assert.doesNotMatch(section4, /Nouveaux clients.*\n.*\| 0 \|/);
    assert.match(section4, /read_customers/);
  });

  test("pas de bloc Shopify quand la donnée est indisponible (comportement existant préservé)", () => {
    const md = renderMarkdown(buildFakeModel());
    const section4 = extractMarkdownSection(md, "## 4. Ce qui fait vendre", "## 5.");
    assert.doesNotMatch(section4, /Commandes réelles \(Shopify\)/);
  });
});

describe("report/markdown+html — nouveaux vs récurrents vs invités (résolution client réseau)", () => {
  function shopifyModelWithCustomers(bySiteOverrides = {}) {
    return buildFakeModel({
      ecommerce: {
        funnelStages: [
          { label: "Vue produit", value: 100 },
          { label: "Ajout au panier", value: 20 },
          { label: "Paiement démarré", value: 10 },
          { label: "Achat", value: 4 },
        ],
        topProducts: [],
        convertingPages: [],
        shopify: {
          ok: true,
          scopeMissing: false,
          bySite: [
            {
              siteKey: "EN", ok: true, reason: null, currency: "USD", orders: 100,
              grossRevenue: 1000, discounts: 0, refunds: 0, netRevenue: 1000, aov: 10,
              newCustomers: 6, returningCustomers: 3, newCustomersUnavailableReason: null,
              guestOrders: 1, guestRevenue: 100, guestRevenueSharePct: 10,
              newCustomersRevenue: 600, newCustomersRevenueSharePct: 60,
              returningCustomersRevenue: 300, returningCustomersRevenueSharePct: 30,
              customerResolutionPartial: false, resolvedCustomerCount: 9, totalUniqueCustomerCount: 9,
              ...bySiteOverrides,
            },
          ],
          subtotalsByCurrency: [],
          topCountries: [],
          channels: [],
        },
      },
    });
  }

  test("markdown : nouveaux, récurrents et invités affichés avec leur part de CA — jamais des null/0 par défaut", () => {
    const md = renderMarkdown(shopifyModelWithCustomers());
    const section4 = extractMarkdownSection(md, "## 4. Ce qui fait vendre", "## 5.");
    assert.match(section4, /Nouveaux vs récurrents vs invités/);
    assert.match(section4, /\| EN \| 6 \| 3 \| 1 \|/);
    assert.match(section4, /60,0 %/);
    assert.match(section4, /30,0 %/);
    assert.match(section4, /10,0 %/);
  });

  test("markdown : résolution partielle -> note explicite avec X/Y résolus, pas un chiffre qui semble complet", () => {
    const md = renderMarkdown(
      shopifyModelWithCustomers({ customerResolutionPartial: true, resolvedCustomerCount: 4, totalUniqueCustomerCount: 9 })
    );
    const section4 = extractMarkdownSection(md, "## 4. Ce qui fait vendre", "## 5.");
    assert.match(section4, /[Rr]ésolution partielle/);
    assert.match(section4, /4\/9/);
  });

  test("html : mêmes informations, échappées et sans note de partiel quand la résolution est complète", () => {
    const html = renderHtml(shopifyModelWithCustomers());
    assert.match(html, /Nouveaux vs récurrents vs invités/);
    assert.doesNotMatch(html, /[Rr]ésolution partielle/);
  });

  test("html : résolution partielle -> bannière explicite", () => {
    const html = renderHtml(
      shopifyModelWithCustomers({ customerResolutionPartial: true, resolvedCustomerCount: 4, totalUniqueCustomerCount: 9 })
    );
    assert.match(html, /[Rr]ésolution partielle/);
    assert.match(html, /4\/9/);
  });
});

describe("report/html — autonomie et sécurité", () => {
  test("aucune URL externe (http/https) et aucun <script src>", () => {
    const html = renderHtml(buildFakeModel());
    assert.equal(/https?:\/\//i.test(html), false, "le HTML ne doit contenir aucune URL http(s) externe");
    assert.equal(/<script[^>]*\bsrc\s*=/i.test(html), false, "le HTML ne doit contenir aucun <script src>");
  });

  test("contenu injecté échappé (pas d'injection HTML via une donnée)", () => {
    const model = buildFakeModel({
      acquisition: { channels: [{ channel: "<img src=x onerror=alert(1)>", sessions: 10, sharePct: 100, revenuePerSession: 1, sessionsGap: null }] },
    });
    const html = renderHtml(model);
    assert.equal(html.includes("<img src=x onerror"), false, "une donnée hostile ne doit jamais produire une vraie balise HTML");
    assert.match(html, /&lt;img/);
  });

  test("thème clair/sombre présent (prefers-color-scheme + data-theme)", () => {
    const html = renderHtml(buildFakeModel());
    assert.match(html, /prefers-color-scheme:\s*dark/);
    assert.match(html, /\[data-theme="dark"\]/);
  });

  test("tableaux larges dans un conteneur overflow-x auto", () => {
    const html = renderHtml(buildFakeModel());
    assert.match(html, /overflow-x:\s*auto/);
    // Le corps de page lui-même ne doit jamais défiler horizontalement.
    assert.match(html, /overflow-x:\s*hidden/);
  });

  test("règle @media print présente", () => {
    const html = renderHtml(buildFakeModel());
    assert.match(html, /@media print/);
  });

  test("document HTML bien formé (doctype, html, head, body)", () => {
    const html = renderHtml(buildFakeModel());
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<html[ >]/);
    assert.match(html, /<\/html>\s*$/);
  });
});
