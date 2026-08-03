# Lovebox Analytics — Spécification

> Module **analytics uniquement**. Aucune action d'écriture sur les sites, aucune
> suppression, aucune modification de contenu. On lit, on agrège, on explique.
> Le module « Suppression BLOG Useless » reste seul responsable des actions blog.

## 1. Objectif

Produire chaque mois un **rapport unique, simple à comprendre par toute l'équipe**
(pas seulement par un SEO), qui répond à quatre questions :

1. Combien de monde est venu, d'où, et est-ce mieux ou moins bien qu'avant ?
2. Combien on a vendu, et qu'est-ce qui a fait vendre ?
3. Où sont les opportunités concrètes (SEO, contenu, produit) ?
4. Est-ce qu'on peut faire confiance à ces chiffres ?

Cadence : **mensuelle, sur mois calendaire**, avec comparaison **M-1** (mois
précédent) et **M-12** (même mois l'an dernier). Exécution le **3 du mois** à 08:00
(les données GSC ont ~3 jours de latence, GA4 ~48h).

## 2. Ce qui existe déjà et qu'on réutilise

Le projet `../Suppression BLOG Useless` a déjà :

- Un **token OAuth Google** valide (`data/google-token.json`) avec les scopes
  `analytics.readonly` + `webmasters.readonly`. **On le réutilise tel quel**, pas
  de nouvelle authentification.
- Les credentials `.env` : `GOOGLE_CLIENT_ID/SECRET`, `GA4_PROPERTY_ID`,
  `SHOPIFY_STORE_{EN,FR,EU}_{DOMAIN,TOKEN}`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`,
  `ANTHROPIC_API_KEY`.
- Des patterns éprouvés : pagination GA4 par `offset`, `googleRequest` avec retry,
  rapport Slack Block Kit chunké à 45 blocks, agents Claude à sortie JSON schema.

**On ne modifie aucun fichier du dossier existant.** On copie/adapte ce qui sert.

### Angles morts détectés dans l'existant (à corriger ici)

| Constat | Conséquence | Traitement dans `analytics` |
| --- | --- | --- |
| `config/sites.json` ne déclare que 6 hosts, mais GA4 renvoie aussi `ca.lovebox.love`, `keep.lovebox.love`, `www.kickstarter.com` | Trafic silencieusement écarté (`classifyArticles` log un warn, l'analyse business n'en tient pas compte) | Registre de sites élargi + **découverte automatique** des hosts inconnus, remontés en alerte qualité |
| Landing pages `/web-pixels@…` polluent les top pages (jusqu'à 1 145 sessions) | Analyses faussées | Filtrage par `noise-patterns.json` + mesure du % de bruit |
| `buy`, `store`, `boutique` : sessions > 0, revenu = 0 € | Impossible de savoir si c'est un vrai zéro ou un tracking cassé | Contrôle qualité dédié + réconciliation GA4 ↔ Shopify |
| Fenêtres glissantes 30j/90j uniquement | Pas de comparaison mensuelle ni annuelle | Tout est indexé sur mois calendaire + snapshots historisés |
| Pas d'historique exploitable (seulement le dernier run) | Aucune tendance | `data/monthly/YYYY-MM.json` + commande `backfill` |
| GA4 : seulement sessions / revenu / vues | Aucun funnel, aucun AOV, aucun taux de conversion | Couverture e-commerce complète (voir §6) |

## 3. Arborescence cible

```
analytics/
  .env.example  .gitignore  README.md  SPEC.md  package.json
  config/
    sites.json          Tous les hosts + mapping propriété GSC + devise + type
    metrics.json        Catalogue déclaratif des rapports GA4 (dimensions/métriques/filtres)
    brand-terms.json    Termes de marque → split branded / non-branded
    llm-sources.json    Sources IA (copié + étendu depuis l'existant)
    noise-patterns.json Patterns d'URL/source à exclure
    kpi-targets.json    Objectifs par KPI (colorisation vert/orange/rouge)
    thresholds.json     Seuils de significativité, striking distance, alertes qualité
  src/
    index.js            CLI
    lib/
      env.js  logger.js
      google.js         OAuth (token réutilisé) + requête + backoff + quota
      cache.js          Cache disque par requête (data/cache/<mois>/<hash>.json)
      period.js         Mois calendaire, M-1, M-12, bornes ISO, latence API
      ga4.js  gsc.js  shopify.js
      normalize.js      host→site, nettoyage bruit, classification d'URL
      collect.js        Orchestration collecte → snapshot mensuel
      metrics.js        KPI purs et testables (deltas, MoM, YoY, ratios)
      quality.js        Contrôles de fiabilité des données
      insights.js       Détections déterministes (opportunités, cannibalisation…)
      claude.js         Agents + schémas JSON + vérification des chiffres
      store.js          Lecture/écriture des snapshots mensuels
    report/
      markdown.js  html.js  charts.js  slack.js
    routines/
      collect.js  backfill.js  report.js  monthly.js
  data/monthly/  data/cache/
  reports/YYYY-MM/
  scripts/  test/
```

## 4. CLI

| Commande | Effet |
| --- | --- |
| `npm run doctor` | Vérifie credentials, joignabilité GA4/GSC/Shopify/Slack/Anthropic, **sonde les métriques GA4 disponibles**, vérifie le scope `read_orders` |
| `npm run collect -- --month=2026-06` | Collecte + snapshot `data/monthly/2026-06.json`. Aucun appel IA, aucun envoi Slack |
| `npm run backfill -- --months=14` | Collecte les 14 derniers mois clos (pour disposer de M-1 et M-12 dès le premier rapport) |
| `npm run report -- --month=2026-06` | Génère MD + HTML + Slack à partir du snapshot (le collecte s'il manque). Options `--no-ai`, `--no-slack` |
| `npm run monthly` | Le run du 3 : `collect(mois précédent)` + `report` complet |

Flags globaux : `--no-cache`, `--verbose`.

## 5. Périodes (`period.js`)

- `monthBounds("2026-06")` → `{ start: "2026-06-01", end: "2026-06-30" }`
- `previousMonth`, `sameMonthLastYear`
- `latestClosedMonth(today)` → dernier mois entièrement terminé
- `isDataReady(month, today)` → `false` si on est à moins de 3 jours de la fin du
  mois (données GSC non consolidées) ; le rapport le signale au lieu de mentir.
- GA4 accepte `startDate`/`endDate` en `YYYY-MM-DD` — **utiliser des dates
  absolues, jamais `NdaysAgo`**, pour que les snapshots soient reproductibles.

## 6. Collecte GA4 (`ga4.js` + `config/metrics.json`)

Une seule propriété GA4 couvre tous les hosts → la dimension `hostName` sépare les
sites. Pagination par `offset` jusqu'à `rowCount` (reprendre le pattern
`runReportPaged` existant).

Rapports à produire, **par mois** (courant, M-1, M-12) :

| Clé | Dimensions | Métriques |
| --- | --- | --- |
| `overview` | `hostName` | sessions, totalUsers, newUsers, engagedSessions, engagementRate, averageSessionDuration, bounceRate, screenPageViews, totalRevenue, transactions |
| `channelsLastTouch` | `hostName`, `sessionDefaultChannelGroup` | sessions, totalUsers, totalRevenue, transactions |
| `channelsFirstTouch` | `hostName`, `firstUserDefaultChannelGroup` | sessions, totalUsers, totalRevenue |
| `sourceMedium` | `hostName`, `sessionSourceMedium` | sessions, totalRevenue (top 150) |
| `campaigns` | `hostName`, `sessionCampaignName` | sessions, totalRevenue (top 100) |
| `landingPages` | `hostName`, `landingPage` | sessions, engagementRate, totalRevenue, transactions (top 300) |
| `pages` | `hostName`, `pagePath` | screenPageViews, totalUsers, userEngagementDuration (top 500) |
| `ecommerce` | `hostName` | itemsViewed, addToCarts, checkouts, ecommercePurchases, purchaseRevenue, averagePurchaseRevenue |
| `products` | `itemName` | itemsViewed, itemsPurchased, itemRevenue (top 100) |
| `geo` | `hostName`, `country` | sessions, totalRevenue (top 100) |
| `devices` | `hostName`, `deviceCategory` | sessions, engagementRate, totalRevenue |
| `newVsReturning` | `hostName`, `newVsReturning` | sessions, totalRevenue |
| `llm` | `hostName`, `sessionSource`, `landingPage` | sessions, totalRevenue (filtre `llm-sources.json`) |
| `daily` | `date`, `hostName` | sessions, totalRevenue |

**Robustesse obligatoire — sonde de métriques.** Les noms de métriques GA4 varient
(`transactions` vs `ecommercePurchases`, `sessionConversionRate` vs
`sessionKeyEventRate`, certaines combinaisons dimension×métrique sont refusées).
Le collecteur doit :

1. Tenter le rapport complet.
2. Sur erreur 400 mentionnant une métrique/dimension, **retirer le champ fautif et
   réessayer** (max 3 dégradations), en journalisant chaque retrait.
3. Renvoyer `{ ok, rows, droppedFields[], error }` — jamais lever pour un rapport
   secondaire. `doctor` affiche la liste des métriques réellement disponibles.

Un rapport en échec ⇒ sa section du rapport final affiche « donnée indisponible »
avec la raison, il n'est jamais remplacé par des zéros.

## 7. Collecte GSC (`gsc.js`)

Une requête par site déclaré dans `sites.json` (propriété `gscSiteUrl`), sur les
bornes du mois. Un site inaccessible ⇒ warn, pas d'échec global (pattern existant).

| Clé | Dimensions | Volume |
| --- | --- | --- |
| `siteTotals` | — | totaux clicks/impressions/ctr/position |
| `queries` | `query` | 1000 |
| `pages` | `page` | 1000 |
| `pageQuery` | `page`, `query` | 5000 |
| `countries` | `country` | 100 |
| `devices` | `device` | 10 |
| `appearance` | `searchAppearance` | 25 |

Dérivés calculés dans `insights.js` (déterministes, sans IA) :

- **Branded vs non-branded** : split sur `brand-terms.json` (`lovebox`, `love box`,
  `lovebox.love`…). Un déclin non-branded est un vrai signal SEO ; un déclin
  branded est un signal notoriété. Les deux doivent être distingués.
- **Buckets de position** : 1-3 / 4-10 / 11-20 / 21+ (clics et impressions par bucket).
- **Striking distance** : position entre 4 et 15 **et** impressions ≥ seuil
  (`thresholds.json`, défaut 100) → top 20 opportunités, triées par
  `impressions × (CTR attendu à pos.3 − CTR actuel)`.
- **CTR sous-performant** : CTR réel < 50 % du CTR médian observé à cette position
  sur l'ensemble du corpus → titre/meta à retravailler.
- **Gagnants / perdants MoM** : requêtes et pages avec Δclics ≥ seuil, dans les deux sens.
- **Requêtes apparues / disparues** : présentes ce mois et absentes M-1 (et inverse).
- **Cannibalisation** : même requête servie par ≥ 2 pages avec chacune ≥ seuil
  d'impressions → à arbitrer.

## 8. Collecte Shopify (`shopify.js`)

`GET /admin/api/2024-10/orders.json?status=any&created_at_min=…&created_at_max=…&limit=250`,
pagination via l'en-tête `Link` (`rel="next"`), par boutique EN/FR/EU.

Agrégats par site : commandes, CA brut, remises, remboursements, CA net, panier
moyen, devise, répartition pays, nouveau vs récurrent (`customer.orders_count`),
canal (`source_name`).

**Dégradation propre obligatoire.** Les apps Shopify actuelles ont les scopes
`read_content`/`write_content` — **pas `read_orders`**. Le collecteur doit :

- Détecter `401`/`403` et renvoyer `{ ok: false, reason: "scope read_orders manquant" }`.
- `doctor` affiche exactement quoi faire : ajouter le scope `read_orders` à l'app
  custom de chaque boutique, puis relancer `npm run auth-shopify` du module existant.
- Le rapport reste complet sans cette section, avec une note explicite : le CA
  affiché vient alors de GA4 (pixel Shopify) et non des commandes réelles.

## 9. KPI (`metrics.js`) — fonctions pures, testées

Aucun appel réseau ici. Entrée : snapshots. Sortie : objets chiffrés.

- `delta(current, previous)` → `{ abs, pct, direction }`
- `mom(kpi, month)` / `yoy(kpi, month)`
- `share(value, total)` — part du total
- `revenuePerSession`, `conversionRate`, `aov`, `ctr`, `engagementRate`
- `funnel(ecommerce)` → taux de passage vue→panier→checkout→achat
- **Garde-fou de significativité** : si la base < seuil (`thresholds.json` :
  100 sessions, 5 transactions), la variation en % n'est pas affichée — on renvoie
  `{ insufficient: true, base }` et le rapport écrit « volume trop faible pour
  conclure ». C'est ce qui empêche les « +300 % » sur 4 sessions.
- `attributionGap(lastTouch, firstTouch)` — écart par canal, pour ne jamais
  déclarer un canal « non rentable » sur la seule base du dernier clic (le blog
  est structurellement un canal de découverte).

## 10. Qualité des données (`quality.js`) — section à part entière du rapport

Chaque contrôle renvoie `{ id, level: ok|warn|critical, title, detail, impact }`.

1. **Hosts inconnus** — hosts présents dans GA4 mais absents de `sites.json`
   (part du trafic concernée).
2. **Bruit de tracking** — % des sessions sur des landing pages matchant
   `noise-patterns.json` (`/web-pixels@`, `?`, `%`, `cdn-cgi`, `translate.goog`).
3. **Revenu manquant** — site avec sessions ≥ seuil et revenu = 0 € →
   « conversion non trackée » (critique).
4. **Écart GA4 ↔ Shopify** — |CA GA4 − CA Shopify| / CA Shopify > 10 % → alerte.
5. **Trous de données** — jours manquants ou à zéro dans la série `daily`.
6. **Cardinalité** — part de `(not set)` / `(other)` par dimension clé > 5 %.
7. **Couverture GSC** — propriétés injoignables, mois incomplet.
8. **Trafic non attribué** — part du channel group `Unassigned`.
9. **Métriques indisponibles** — champs retirés par la sonde GA4 (§6).

## 11. Agents Claude (`claude.js`)

SDK `@anthropic-ai/sdk`. Modèle par défaut **`claude-opus-5`** (surchargable via
`ANALYTICS_MODEL`). Paramètres :

```js
client.messages.stream({
  model: env.model,                       // claude-opus-5
  max_tokens: 20000,
  system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
  thinking: { type: "adaptive" },         // activé par défaut sur Opus 5
  output_config: {
    effort: "high",
    format: { type: "json_schema", schema },
  },
  messages: [{ role: "user", content: JSON.stringify(data) }],
});
```

Règles :

- **Streaming obligatoire** (`max_tokens` élevé ⇒ risque de timeout HTTP sinon).
- `output_config` porte **à la fois** `format` et `effort` — pas de `output_format`
  au premier niveau (paramètre déprécié).
- **Pas de `temperature`, `top_p`, `top_k`** (rejetés en 400 sur Opus 5).
- **Pas de `budget_tokens`** (rejeté ; c'est `effort` qui pilote la profondeur).
- Prompt caching : le bloc système stable porte `cache_control` ; les données
  volatiles passent dans le message utilisateur, après le préfixe caché.
- Vérifier `message.stop_reason === "refusal"` **avant** de lire `content`.
- Les 6 agents thématiques tournent en parallèle, l'agent exécutif ensuite.

### Les 7 agents

| Agent | Entrée | Rôle |
| --- | --- | --- |
| `acquisition` | channels last+first touch, sourceMedium, campaigns, geo, devices | D'où vient le trafic, quel canal progresse, écart d'attribution |
| `seo` | GSC agrégé + dérivés `insights.js` | Opportunités, pertes, cannibalisation, branded vs non-branded |
| `content` | pages blog, landing pages, contribution au revenu | Ce qui marche, ce qui est à retravailler |
| `ecommerce` | funnel, produits, AOV, conversion, Shopify | Où on perd des clients, ce qui se vend |
| `aiVisibility` | trafic LLM | Visibilité IA : quelles pages, quelle intention |
| `dataQuality` | sorties `quality.js` | Traduire les anomalies techniques en langage clair + priorité de correction |
| `executive` | sorties des 6 + KPI | **Le cœur du livrable** : 5 phrases, 3 chiffres clés, 3 actions, 1 alerte |

### Contrainte de style imposée dans le prompt système

> Écris en français, pour quelqu'un qui ne fait pas de SEO. Pas de jargon non
> expliqué (« CTR », « impressions », « bounce rate » doivent être traduits ou
> définis en une incise). Chaque affirmation chiffrée doit citer un chiffre présent
> dans les données fournies. Si une donnée manque ou est marquée peu fiable, dis-le
> plutôt que d'estimer. Ne conclus jamais qu'un canal est non rentable sur la seule
> base du dernier clic.

### Vérification des chiffres (anti-hallucination)

Après chaque agent :

1. Construire un `Set` de toutes les valeurs numériques du jeu de données fourni
   **et** de toutes les valeurs calculées par `metrics.js` (deltas, %, ratios),
   avec leurs variantes arrondies (0 / 1 / 2 décimales).
2. Extraire les nombres du texte généré (regex tolérante aux séparateurs `1 234`,
   `1,234`, `1234.5`, `+12 %`).
3. Tout nombre sans correspondance à ±2 % relatif est listé dans
   `unverifiedFigures[]`.
4. Ce n'est **pas bloquant** : le rapport affiche un encart
   « ⚠️ chiffres non retrouvés dans les données » et le log les liste. Objectif :
   rendre visible une dérive, pas censurer l'analyse.

## 12. Rapports

### 12.1 `reports/YYYY-MM/RAPPORT.md`

Structure figée, dans cet ordre :

1. **En un coup d'œil** — 6 tuiles : Visiteurs, Sessions, Chiffre d'affaires,
   Commandes, Panier moyen, Taux de conversion. Chacune avec valeur, Δ M-1, Δ M-12.
2. **Ce qui a changé ce mois-ci** — 5 phrases maximum, langage courant.
3. **D'où viennent les visiteurs** — tableau canaux + part du trafic + revenu par
   session + écart premier/dernier contact.
4. **Ce qui fait vendre** — entonnoir d'achat, top produits, pages qui convertissent.
5. **Le référencement Google** — clics / impressions / position moyenne, marque vs
   hors marque, gagnants, perdants, **top 10 opportunités concrètes**.
6. **Le blog** — trafic, meilleurs articles, contribution au revenu, articles à
   retravailler. *(Lecture seule : les actions de suppression restent dans l'autre module.)*
7. **La visibilité dans les IA** — sessions depuis ChatGPT / Perplexity / Claude /
   Gemini / Copilot, pages concernées.
8. **Peut-on faire confiance à ces chiffres ?** — sorties `quality.js`, en clair.
9. **Les 3 actions du mois** — priorité, action, où, impact attendu, qui.
10. **Annexes** — tableaux détaillés, méthodologie, définitions des termes.

### 12.2 `reports/YYYY-MM/rapport.html`

Page **autonome** : tout le CSS et tous les graphiques en ligne, **aucune
ressource externe** (pas de CDN, pas de police distante, pas d'appel réseau).

- Graphiques en **SVG inline généré côté Node** (`report/charts.js`) : sparklines
  quotidiennes, barres horizontales (canaux, pages), entonnoir, jauges KPI.
  Pas de librairie de charting.
- Thème clair **et** sombre (`prefers-color-scheme` + `:root[data-theme=…]`).
- Responsive : tableaux larges dans un conteneur `overflow-x: auto`, le corps de
  page ne défile jamais horizontalement.
- Imprimable en PDF (`@media print`).
- **Avant d'écrire le code des graphiques, charger la skill `dataviz`** (palette,
  choix de forme, accessibilité, tuiles KPI).

### 12.3 Slack (`report/slack.js`)

- **Correction** : plus de rapport détaillé posté en messages/thread. Un seul
  message court : titre + mois + les 6 tuiles KPI + les 3 actions. Rien de plus.
- Le fichier `rapport.html` est joint au message (flux Slack en 3 temps
  `files.getUploadURLExternal` → dépôt → `files.completeUploadExternal` —
  `files.upload` est déprécié/retiré). Nécessite le scope `files:write` sur le
  bot token (aujourd'hui `chat:write` seul) : sur `missing_scope`/
  `not_allowed_token_type`, dégradation propre vers `chat.postMessage` seul
  avec le chemin local du HTML, jamais de plantage. `npm run doctor` vérifie
  ce scope (sonde inoffensive, sans envoyer de fichier réel).
- Slack ne prévisualise pas le contenu HTML : l'équipe télécharge la pièce
  jointe et l'ouvre dans son navigateur.

### 12.4 `reports/YYYY-MM/data.json`

`{ collection, model }` — KPI calculés (`model`, voir §9) + sorties agents
(`model.agents`) + trace de qualité de la collecte (`collection` :
`droppedFields`, `failures`, `warnings`, voir §13). C'est la source de vérité
machine, et ce qui permet à un humain de rouvrir le mois dans Claude Code.

Le snapshot brut (`sources.{ga4,gsc,shopify}`, une ligne par dimension/période
de chaque rapport) n'est volontairement pas dupliqué ici — il resterait
identique à `data/monthly/YYYY-MM.json` (§13) tout en pesant plusieurs dizaines
de Mo pour un usage nul côté rapport. Qui a besoin du détail brut va le
chercher dans `data/monthly/YYYY-MM.json`.

## 13. Snapshots et historique (`store.js`)

`data/monthly/YYYY-MM.json` :

```json
{
  "month": "2026-06",
  "generatedAt": "2026-07-03T06:00:00.000Z",
  "bounds": { "start": "2026-06-01", "end": "2026-06-30" },
  "sources": { "ga4": {...}, "gsc": {...}, "shopify": {...} },
  "collection": { "droppedFields": [], "failures": [], "warnings": [] }
}
```

Un snapshot est **immuable une fois écrit** sauf `--force`. C'est ce qui garantit
que le rapport de juin dit la même chose en septembre qu'en juillet.

**Correction — réparation ciblée (`collect.js` → `repairSnapshot`).**
L'immuabilité protège les données *réussies*, pas des échecs devenus périmés
(ex. scope Shopify `read_orders` ajouté après l'écriture du snapshot). À
chaque `npm run report` (sauf `--no-repair`), les entrées `{ ok:false }` du
snapshot — et seulement celles-là, jamais une recollecte complète — sont
retentées ; ce qui réussit est fusionné et le snapshot est réécrit (une
entrée `repairs[]` journalise chaque réparation) ; ce qui échoue encore est
conservé tel quel, sans jamais planter.

## 14. Robustesse

- **Cache disque** par requête : `data/cache/<mois>/<sha1(payload)>.json`. Un
  relancement de rapport ne recoûte rien. `--no-cache` pour forcer.
- **Backoff** exponentiel + `Retry-After` sur 429/5xx (GA4, GSC, Shopify, Slack).
- **Isolation des pannes** : chaque collecteur renvoie `{ ok, data, error }`. Une
  source morte dégrade une section, jamais le run.
- **Jamais de zéro implicite** : une donnée absente s'affiche « indisponible », pas « 0 ».
- Alerte Slack d'échec si le run plante (pattern `sendFailureAlert` existant).

## 15. Tests (`node:test`, sans réseau)

Sur les couches pures uniquement, avec fixtures JSON :

- `period.test.js` — bornes de mois, M-1, M-12, années bissextiles, `isDataReady`.
- `metrics.test.js` — deltas, MoM/YoY, division par zéro, garde-fou de
  significativité, `attributionGap`.
- `normalize.test.js` — mapping host→site, hosts inconnus, filtrage du bruit.
- `quality.test.js` — chaque contrôle déclenche au bon seuil.
- `insights.test.js` — striking distance, cannibalisation, branded/non-branded.

`npm test` doit passer sans credentials.

## 16. Planification

`scripts/schedule-windows.ps1` — tâche Windows **le 3 de chaque mois à 08:00**
lançant `npm run monthly`. Mentionner dans le README les alternatives sans PC
allumé : `/schedule` de Claude Code, ou GitHub Actions.

## 17. Critères d'acceptation

- [ ] `npm install && npm test` passe sans credentials.
- [ ] `npm run doctor` liste précisément ce qui manque, y compris le scope
      Shopify `read_orders`, sans planter.
- [ ] `npm run collect -- --month=<mois clos>` écrit un snapshot valide même si
      Shopify et une propriété GSC échouent.
- [ ] `npm run report -- --month=<mois> --no-ai --no-slack` produit MD + HTML +
      JSON exploitables sans clé Anthropic.
- [ ] Le HTML s'ouvre hors ligne, s'affiche correctement en clair et en sombre,
      ne défile pas horizontalement, et s'imprime proprement.
- [ ] Aucun `%` de variation n'est affiché sous le seuil de significativité.
- [ ] La section qualité signale les hosts inconnus et les sites à revenu nul.
- [ ] Aucun fichier de `../Suppression BLOG Useless` n'est modifié.
