import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { siteForHost, siteForKey, detectUnknownHosts, isNoise, filterNoise, partitionNoise, classifyUrl } from "../src/lib/normalize.js";
import { loadFixture } from "./helpers.js";

describe("normalize — mapping host -> site", () => {
  test("host déclaré", () => {
    const site = siteForHost("en.lovebox.love");
    assert.equal(site.key, "EN");
    assert.equal(site.type, "editorial");
  });

  test("host non déclaré -> null", () => {
    assert.equal(siteForHost("www.kickstarter.com"), null);
  });

  test("hosts découverts (ca/keep) déclarés mais marqués `discovered`", () => {
    assert.equal(siteForHost("ca.lovebox.love")?.discovered, true);
    assert.equal(siteForHost("keep.lovebox.love")?.discovered, true);
  });

  test("siteForKey", () => {
    assert.equal(siteForKey("FR").host, "fr.lovebox.love");
    assert.equal(siteForKey("INCONNU"), null);
  });
});

describe("normalize — détection des hosts inconnus (fixture GA4 overview)", () => {
  const rows = loadFixture("ga4-overview.json");

  test("seul kickstarter.com est réellement inconnu (ca est déclaré, discovered)", () => {
    const result = detectUnknownHosts(rows);
    assert.equal(result.hosts.length, 1);
    assert.equal(result.hosts[0].host, "www.kickstarter.com");
    assert.equal(result.hosts[0].sessions, 60);
  });

  test("part de trafic (sharePct) calculée sur le total, pas seulement les inconnus", () => {
    const result = detectUnknownHosts(rows);
    const totalSessions = rows.reduce((s, r) => s + r.sessions, 0);
    assert.equal(result.totalMetric, totalSessions);
    assert.equal(result.totalUnknown, 60);
    assert.ok(Math.abs(result.sharePct - (60 / totalSessions) * 100) < 0.01);
  });

  test("aucune ligne -> tableau vide, sharePct null (pas de division par zéro)", () => {
    const result = detectUnknownHosts([]);
    assert.deepEqual(result.hosts, []);
    assert.equal(result.sharePct, null);
  });
});

describe("normalize — filtrage du bruit (noise-patterns.json)", () => {
  test("détecte les patterns connus", () => {
    assert.equal(isNoise("/web-pixels@1.2.3/sandbox/module.js"), true);
    assert.equal(isNoise("/products/lovebox?variant=123"), true);
    assert.equal(isNoise("/fr/blogs/news/mon-article"), false);
  });

  test("filterNoise retire les lignes bruitées", () => {
    const rows = [{ landingPage: "/" }, { landingPage: "/web-pixels@1.0.0/" }];
    assert.equal(filterNoise(rows, "landingPage").length, 1);
  });

  test("partitionNoise sépare proprement clean/noise", () => {
    const rows = [{ landingPage: "/" }, { landingPage: "/cdn-cgi/l/email-protection" }];
    const { clean, noise } = partitionNoise(rows, "landingPage");
    assert.equal(clean.length, 1);
    assert.equal(noise.length, 1);
  });
});

describe("normalize — classification d'URL (lecture seule)", () => {
  test("blog", () => {
    assert.equal(classifyUrl("/blogs/news/mon-article", siteForKey("EN")), "blog");
  });

  test("produit", () => {
    assert.equal(classifyUrl("/products/lovebox-original", null), "produit");
  });

  test("autre", () => {
    assert.equal(classifyUrl("/pages/about", null), "autre");
    assert.equal(classifyUrl(null, null), "autre");
  });
});
