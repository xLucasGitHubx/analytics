import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { aggregateOrders, channelLabel, resolveCustomerSegments, fetchCustomer } from "../src/lib/shopify.js";

function order(overrides = {}) {
  return {
    total_price: "100.00",
    total_discounts: "0.00",
    currency: "USD",
    refunds: [],
    shipping_address: { country_code: "US" },
    source_name: "web",
    ...overrides,
  };
}

describe("shopify — aggregateOrders : devise", () => {
  test("la devise renvoyée est celle de la 1ère commande, jamais une supposition", () => {
    const r = aggregateOrders([order({ currency: "USD" }), order({ currency: "USD" })]);
    assert.equal(r.currency, "USD");
  });

  test("aucune commande -> currency null, aov null (pas de zéro implicite)", () => {
    const r = aggregateOrders([]);
    assert.equal(r.currency, null);
    assert.equal(r.aov, null);
    assert.equal(r.orders, 0);
  });
});

describe("shopify — aggregateOrders : nouveau vs récurrent (§ défaut #3)", () => {
  test("customer.orders_count absent sur toutes les commandes (scope read_customers manquant) -> null + raison, jamais 0", () => {
    const orders = [
      order({ customer: { id: 1, email: "a@a.com" } }), // pas de orders_count : reflète le comportement réel de l'API sans read_customers
      order({ customer: { id: 2, email: "b@b.com" } }),
    ];
    const r = aggregateOrders(orders);
    assert.equal(r.newCustomers, null);
    assert.equal(r.returningCustomers, null);
    assert.match(r.newCustomersUnavailableReason, /read_customers/);
  });

  test("aucune commande n'a d'objet customer du tout -> null + raison distincte", () => {
    const orders = [order({ customer: null }), order({ customer: null })];
    const r = aggregateOrders(orders);
    assert.equal(r.newCustomers, null);
    assert.equal(r.returningCustomers, null);
    assert.match(r.newCustomersUnavailableReason, /aucune commande/);
  });

  test("orders_count disponible -> décompte réel nouveau (1) vs récurrent (>1)", () => {
    const orders = [
      order({ customer: { orders_count: 1 } }),
      order({ customer: { orders_count: 1 } }),
      order({ customer: { orders_count: 3 } }),
    ];
    const r = aggregateOrders(orders);
    assert.equal(r.newCustomers, 2);
    assert.equal(r.returningCustomers, 1);
    assert.equal(r.newCustomersUnavailableReason, null);
  });
});

describe("shopify — resolveCustomerSegments (résolution réseau par client unique, cf. `fetchCustomer`)", () => {
  test("invités (customer null) comptés à part, jamais nouveau/récurrent, aucun appel réseau requis", async () => {
    const orders = [order({ customer: null, total_price: "50.00" }), order({ customer: null, total_price: "30.00" })];
    const r = await resolveCustomerSegments("EN", orders, {
      noCache: true,
      fetchCustomerFn: async () => { throw new Error("ne doit jamais être appelé : aucun client à résoudre"); },
    });
    assert.equal(r.guestOrders, 2);
    assert.equal(r.guestRevenue, 80);
    assert.equal(r.newCustomers, 0);
    assert.equal(r.returningCustomers, 0);
    assert.equal(r.newCustomersUnavailableReason, null);
  });

  test("un même client référencé par 3 commandes -> une seule résolution réseau (dédoublonnage par customer.id)", async () => {
    const orders = [
      order({ customer: { id: 42 }, total_price: "10.00" }),
      order({ customer: { id: 42 }, total_price: "20.00" }),
      order({ customer: { id: 42 }, total_price: "30.00" }),
    ];
    let calls = 0;
    const fetchCustomerFn = async (siteKey, customerId) => {
      calls++;
      assert.equal(customerId, 42);
      return { ok: true, reason: null, customer: { id: 42, orders_count: 3 } };
    };
    const r = await resolveCustomerSegments("EN", orders, { noCache: true, fetchCustomerFn });
    assert.equal(calls, 1, "un client référencé par 3 commandes ne doit être résolu qu'une fois");
    assert.equal(r.returningCustomers, 1);
    assert.equal(r.newCustomers, 0);
    assert.equal(r.returningCustomersRevenue, 60);
  });

  test("orders_count <= 1 -> nouveau ; > 1 -> récurrent, avec la bonne part de CA par catégorie", async () => {
    const orders = [
      order({ customer: { id: 1 }, total_price: "100.00" }),
      order({ customer: { id: 2 }, total_price: "50.00" }),
    ];
    const fetchCustomerFn = async (siteKey, customerId) => ({
      ok: true,
      reason: null,
      customer: { id: customerId, orders_count: customerId === 1 ? 1 : 5 },
    });
    const r = await resolveCustomerSegments("EN", orders, { noCache: true, fetchCustomerFn });
    assert.equal(r.newCustomers, 1);
    assert.equal(r.returningCustomers, 1);
    assert.equal(r.newCustomersRevenue, 100);
    assert.equal(r.returningCustomersRevenue, 50);
  });

  test("client individuel en échec (404) -> journalisé et exclu du calcul, jamais un plantage ni une indisponibilité totale", async () => {
    const orders = [
      order({ customer: { id: 1 }, total_price: "100.00" }),
      order({ customer: { id: 2 }, total_price: "50.00" }),
    ];
    const fetchCustomerFn = async (siteKey, customerId) => {
      if (customerId === 1) return { ok: false, reason: "Shopify EN → HTTP 404: client introuvable", customer: null };
      return { ok: true, reason: null, customer: { id: 2, orders_count: 1 } };
    };
    const r = await resolveCustomerSegments("EN", orders, { noCache: true, fetchCustomerFn });
    assert.equal(r.newCustomers, 1);
    assert.equal(r.resolvedCustomerCount, 1);
    assert.equal(r.totalUniqueCustomerCount, 2);
    assert.equal(r.unresolvedCustomers, 1);
    assert.equal(r.unresolvedRevenue, 100);
    assert.equal(r.newCustomersUnavailableReason, null, "au moins une résolution a réussi -> pas 'indisponible'");
  });

  test("exception inattendue sur un client -> journalisée et exclue, les autres clients restent résolus normalement", async () => {
    const orders = [order({ customer: { id: 1 }, total_price: "10.00" }), order({ customer: { id: 2 }, total_price: "20.00" })];
    const fetchCustomerFn = async (siteKey, customerId) => {
      if (customerId === 1) throw new Error("panne réseau simulée");
      return { ok: true, reason: null, customer: { id: 2, orders_count: 2 } };
    };
    const r = await resolveCustomerSegments("EN", orders, { noCache: true, fetchCustomerFn });
    assert.equal(r.returningCustomers, 1);
    assert.equal(r.resolvedCustomerCount, 1);
  });

  test("scope read_customers manquant dès le 1er client -> arrêt immédiat (pas d'appel pour les autres), indisponible + raison", async () => {
    const orders = [
      order({ customer: { id: 1 }, total_price: "10.00" }),
      order({ customer: { id: 2 }, total_price: "20.00" }),
    ];
    let calls = 0;
    const fetchCustomerFn = async () => {
      calls++;
      return { ok: false, reason: "scope read_customers manquant", customer: null };
    };
    const r = await resolveCustomerSegments("EN", orders, { noCache: true, fetchCustomerFn });
    assert.equal(calls, 1, "inutile de répéter le même échec de scope pour chaque client (le scope est au niveau de l'app)");
    assert.equal(r.newCustomers, null);
    assert.equal(r.returningCustomers, null);
    assert.match(r.newCustomersUnavailableReason, /read_customers/);
  });

  test("budget d'appels dépassé -> résolution plafonnée, résultat marqué partiel, jamais bloquant", async () => {
    const orders = [1, 2, 3, 4, 5].map((id) => order({ customer: { id }, total_price: "10.00" }));
    let calls = 0;
    const fetchCustomerFn = async (siteKey, customerId) => {
      calls++;
      return { ok: true, reason: null, customer: { id: customerId, orders_count: 1 } };
    };

    const originalLog = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(" "));
    let r;
    try {
      r = await resolveCustomerSegments("EN", orders, { noCache: true, fetchCustomerFn, maxCustomers: 2 });
    } finally {
      console.log = originalLog;
    }

    assert.equal(calls, 2, "le budget doit plafonner le nombre d'appels réseau réellement effectués");
    assert.equal(r.totalUniqueCustomerCount, 5);
    assert.equal(r.resolvedCustomerCount, 2);
    assert.equal(r.partial, true);
    assert.equal(r.newCustomers, 2);
    assert.ok(lines.some((l) => /budget/i.test(l) && /EN/.test(l)), "un avertissement de budget plafonné doit être journalisé");
  });

  test("aucune commande -> tout à zéro (vrai décompte), jamais marqué indisponible", async () => {
    const r = await resolveCustomerSegments("EN", [], {
      noCache: true,
      fetchCustomerFn: async () => { throw new Error("ne doit jamais être appelé"); },
    });
    assert.equal(r.newCustomers, 0);
    assert.equal(r.returningCustomers, 0);
    assert.equal(r.guestOrders, 0);
    assert.equal(r.newCustomersUnavailableReason, null);
  });
});

describe("shopify — fetchCustomer", () => {
  test("boutique sans credentials déclarés -> ok:false explicite, jamais un appel réseau", async () => {
    const r = await fetchCustomer("__SITE_INCONNUE_TEST__", 123);
    assert.equal(r.ok, false);
    assert.match(r.reason, /Credentials Shopify manquants/);
    assert.equal(r.customer, null);
  });
});

describe("shopify — channelLabel (§ défaut #1, config/shopify-channels.json)", () => {
  test("canal connu -> libellé lisible", () => {
    assert.equal(channelLabel("web"), "Boutique en ligne");
    assert.equal(channelLabel("subscription_contract_checkout_one"), "Abonnement");
    assert.equal(channelLabel("shopify_draft_order"), "Commande manuelle");
    assert.equal(channelLabel("amazon"), "Amazon");
  });

  test("identifiant purement numérique (app custom) -> « Application n°<id> »", () => {
    assert.equal(channelLabel("9764908"), "Application n°9764908");
    assert.equal(channelLabel("294517"), "Application n°294517");
  });

  test("canal texte inconnu -> renvoyé tel quel (déjà lisible)", () => {
    assert.equal(channelLabel("1800 Flowers"), "1800 Flowers");
  });

  test("canal absent -> « Inconnu », jamais une chaîne vide silencieuse", () => {
    assert.equal(channelLabel(null), "Inconnu");
    assert.equal(channelLabel(undefined), "Inconnu");
  });
});
