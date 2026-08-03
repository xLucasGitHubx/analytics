import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sparkline, horizontalBars, funnel, kpiGauge, escapeXml, formatChartNumber, estimateTextWidth } from "../src/report/charts.js";

const FORBIDDEN_RESOURCE_PATTERNS = [/https?:\/\//i, /<image[\s>]/i, /xlink:href/i, /@import/i, /url\(/i, /<script/i];

/** Mini-vérificateur de bonne formation XML (pile de balises), sans dépendance externe. */
function assertWellFormedXml(xml, { root } = {}) {
  if (root) assert.match(xml, new RegExp(`^<${root}[\\s>]`), `doit commencer par <${root}>`);
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let match;
  let found = false;
  while ((match = tagRe.exec(xml))) {
    found = true;
    const [, closing, name, , selfClosing] = match;
    if (closing) {
      const top = stack.pop();
      assert.equal(top, name, `balise fermante </${name}> inattendue (pile: ${JSON.stringify(stack)})`);
    } else if (!selfClosing) {
      stack.push(name);
    }
  }
  assert.ok(found, "aucune balise trouvée");
  assert.deepEqual(stack, [], "toutes les balises doivent être fermées");
}

function assertNoExternalResource(svg) {
  for (const pattern of FORBIDDEN_RESOURCE_PATTERNS) {
    assert.equal(pattern.test(svg), false, `ne doit pas contenir de ressource externe (${pattern})`);
  }
}

describe("charts — escapeXml / formatChartNumber", () => {
  test("escapeXml neutralise les caractères spéciaux (protection XSS de base)", () => {
    assert.equal(escapeXml(`<script>alert("x")</script> & 'quote'`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quote&#39;");
  });

  test("formatChartNumber gère null/undefined sans planter", () => {
    assert.equal(formatChartNumber(null), "n/d");
    assert.equal(formatChartNumber(undefined), "n/d");
    assert.equal(formatChartNumber(NaN), "n/d");
  });
});

describe("charts — sparkline", () => {
  test("SVG bien formé, sans ressource externe, avec des données", () => {
    const svg = sparkline([10, 20, 15, 30, null, 25]);
    assertWellFormedXml(svg, { root: "svg" });
    assertNoExternalResource(svg);
    assert.match(svg, /<path/);
  });

  test("gère un tableau entièrement vide/null sans planter", () => {
    const svg = sparkline([null, null, null]);
    assertWellFormedXml(svg, { root: "svg" });
    assertNoExternalResource(svg);
    assert.match(svg, /Pas de données/);
  });

  test("gère un tableau vide []", () => {
    const svg = sparkline([]);
    assertWellFormedXml(svg, { root: "svg" });
  });
});

describe("charts — horizontalBars", () => {
  test("SVG bien formé, sans ressource externe, labels échappés", () => {
    const svg = horizontalBars([
      { label: "Organic Search", value: 1234 },
      { label: "<script>evil</script>", value: 500 },
      { label: "Direct", value: 300 },
    ]);
    assertWellFormedXml(svg, { root: "svg" });
    assertNoExternalResource(svg);
    assert.equal(svg.includes("<script>evil"), false, "un label malveillant ne doit jamais produire une vraie balise <script>");
    assert.match(svg, /rect/);
  });

  test("respecte maxBars", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ label: `Canal ${i}`, value: 20 - i }));
    const svg = horizontalBars(rows, { maxBars: 3 });
    const rectCount = (svg.match(/<rect/g) || []).length;
    // 2 rect par ligne (piste + barre remplie) x 3 lignes max.
    assert.equal(rectCount, 6);
  });

  test("tableau vide -> pas de données, sans planter", () => {
    const svg = horizontalBars([]);
    assertWellFormedXml(svg, { root: "svg" });
    assert.match(svg, /Pas de données/);
  });

  test("anti-débordement : une valeur formatée plus large que l'espace réservé élargit le SVG plutôt que d'être rognée", () => {
    const width = 480;
    const longValueLabel = "X".repeat(60);
    const svg = horizontalBars([{ label: "Canal", value: 100, valueLabel: longValueLabel }], { width });
    assertWellFormedXml(svg, { root: "svg" });
    const [, viewBoxWidth] = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) /);
    assert.ok(Number(viewBoxWidth) > width, "le viewBox doit s'élargir pour laisser la place à la valeur, pas la rogner");
    // Le texte de la valeur doit tenir entièrement avant le bord droit du viewBox (estimation).
    const [, valueX] = svg.match(/x="(\d+(?:\.\d+)?)" y="[^"]*" class="chart-value"/);
    assert.ok(Number(valueX) + estimateTextWidth(longValueLabel) <= Number(viewBoxWidth) + 1);
  });
});

describe("charts — funnel", () => {
  test("SVG bien formé, sans ressource externe", () => {
    const svg = funnel([
      { label: "Vue produit", value: 1000 },
      { label: "Ajout au panier", value: 200 },
      { label: "Paiement démarré", value: 100 },
      { label: "Achat", value: 40 },
    ]);
    assertWellFormedXml(svg, { root: "svg" });
    assertNoExternalResource(svg);
    assert.match(svg, /Vue produit/);
  });

  test("stades vides -> pas de données", () => {
    const svg = funnel([]);
    assertWellFormedXml(svg, { root: "svg" });
    assert.match(svg, /Pas de données/);
  });
});

describe("charts — funnel : anti-débordement des libellés (correction lisibilité)", () => {
  test("libellé conservé À L'INTÉRIEUR de la barre quand il y tient", () => {
    const svg = funnel([{ label: "Vue produit", value: 1000 }]);
    assertWellFormedXml(svg, { root: "svg" });
    assert.match(svg, /class="chart-value-on-fill"/);
    assert.equal(svg.includes('class="chart-value-below"'), false, "aucun libellé ne doit sortir de la barre si l'estimation dit qu'il tient");
  });

  test("libellé sorti SOUS la barre, en currentColor, quand la barre est trop étroite (cas rapporté : étapes basses de l'entonnoir)", () => {
    // Reproduit le cas signalé : "Paiement démarré — 886 (23 %)" et
    // "Achat — 317 (36 %)" sur des barres beaucoup trop étroites pour leur texte.
    const svg = funnel([
      { label: "Vue produit", value: 12000 },
      { label: "Ajout au panier", value: 3852 },
      { label: "Paiement démarré", value: 886 },
      { label: "Achat", value: 317 },
    ]);
    assertWellFormedXml(svg, { root: "svg" });
    assertNoExternalResource(svg);
    assert.match(svg, /class="chart-value-below"/);
    assert.match(svg, /fill="currentColor"/);
    // Le libellé complet doit être un texte RENDU (visible sans survol), pas seulement présent dans le <title>.
    assert.match(svg, />Paiement démarré — 886 \(23 %\)<\/text>/);
    assert.match(svg, />Achat — 317 \(36 %\)<\/text>/);
    // Le format court remplace l'ancien « — 23% du stade précédent » : la mention complète reste dans le <title> (tooltip), pas dans le texte visible.
    assert.equal(svg.includes("du stade précédent</text>"), false);
  });

  test("aucun chevauchement : la hauteur du SVG grandit exactement de la ligne supplémentaire par libellé sorti", () => {
    const svg = funnel(
      [
        { label: "Vue produit", value: 10000 }, // tient (stade 1, pas de %)
        { label: "Achat", value: 50 }, // ne tient pas
      ],
      { stageHeight: 40, gap: 6 }
    );
    const [, viewBoxHeight] = svg.match(/viewBox="0 0 \d+ (\d+)"/);
    // 1 stade qui tient (40px) + 1 qui ne tient pas (40px + 16px de ligne sous la barre) + 1 gap (6px).
    assert.equal(Number(viewBoxHeight), 40 + (40 + 16) + 6);
  });

  test("le texte ne dépend jamais du survol : présent dans le SVG rendu, pas seulement dans <title>", () => {
    const svg = funnel([{ label: "Achat", value: 1 }, { label: "Achat", value: 1 }]);
    const withoutTitles = svg.replace(/<title>.*?<\/title>/gs, "");
    assert.match(withoutTitles, /<text[^>]*>Achat/);
  });
});

describe("charts — kpiGauge", () => {
  test("delta null -> jauge neutre n/d, bien formée", () => {
    const svg = kpiGauge(null);
    assertWellFormedXml(svg, { root: "svg" });
    assertNoExternalResource(svg);
    assert.match(svg, /n\/d/);
  });

  test("delta positif (direction up) -> bien formé", () => {
    const svg = kpiGauge(12.5, { direction: "up" });
    assertWellFormedXml(svg, { root: "svg" });
    assertNoExternalResource(svg);
  });

  test("delta négatif (direction down, ex. bounceRate) -> bien formé", () => {
    const svg = kpiGauge(-8, { direction: "down" });
    assertWellFormedXml(svg, { root: "svg" });
    assertNoExternalResource(svg);
  });
});
