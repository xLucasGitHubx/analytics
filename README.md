# Lovebox Analytics

Module **analytics uniquement** : aucune action d'écriture sur les sites, aucune
suppression, aucune modification de contenu. On lit, on agrège, on explique. Le
module `Suppression BLOG Useless` reste seul responsable des actions blog.

## Objectif

Produire chaque mois un **rapport unique, simple à comprendre par toute
l'équipe** (pas seulement par un SEO), qui répond à quatre questions :

1. Combien de monde est venu, d'où, et est-ce mieux ou moins bien qu'avant ?
2. Combien on a vendu, et qu'est-ce qui a fait vendre ?
3. Où sont les opportunités concrètes (SEO, contenu, produit) ?
4. Peut-on faire confiance à ces chiffres ?

Cadence : mensuelle, sur mois calendaire, avec comparaison au mois précédent
(M-1) et au même mois l'an dernier (M-12). Exécution le **3 du mois à 08:00**
(les données GSC ont ~3 jours de latence, GA4 ~48h).

Ce module réutilise volontairement ce qui existe déjà dans
`../Suppression BLOG Useless` (token OAuth Google, patterns de collecte,
agents Claude) plutôt que de le réimplémenter — voir `SPEC.md` §2 pour le
détail des angles morts corrigés.

## Mise en route

### 1. Installer les dépendances

```bash
npm install
```

### 2. Copier les credentials

Ce module n'a **pas** de nouveau compte à créer : il réutilise le token OAuth
Google et les clés déjà configurées dans `Suppression BLOG Useless`.

```bash
cp .env.example .env
```

Puis remplis `.env` à partir du `.env` **existant** de
`../Suppression BLOG Useless` :

| Variable `.env` (ici) | Valeur à copier depuis `Suppression BLOG Useless/.env` |
| --- | --- |
| `ANTHROPIC_API_KEY` | même clé |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | mêmes valeurs |
| `GA4_PROPERTY_ID` | même propriété GA4 |
| `SHOPIFY_STORE_{EN,FR,EU}_DOMAIN` / `_TOKEN` | mêmes boutiques |
| `SLACK_BOT_TOKEN` / `SLACK_CHANNEL_ID` | même bot / canal (ou un canal dédié) |

Le token OAuth Google lui-même (`data/google-token.json`) n'est **pas copié** :
`GOOGLE_TOKEN_PATH` pointe par défaut sur
`../Suppression BLOG Useless/data/google-token.json` et ce fichier est lu en
lecture seule, jamais modifié. Si ce token doit être régénéré (révoqué,
machine différente), utilise `npm run auth-google` — ça crée un token propre à
ce module sans toucher à celui de l'autre.

### 3. Vérifier que tout est prêt

```bash
npm run doctor
```

`doctor` vérifie les credentials, teste la joignabilité réelle de
GA4/GSC/Shopify, sonde les métriques GA4 effectivement disponibles sur la
propriété, et explique précisément quoi faire si quelque chose manque
(y compris le scope Shopify `read_orders`, voir plus bas). Il ne plante
jamais : chaque problème est un warning affiché, pas une exception.

## Les 5 commandes

| Commande | Effet |
| --- | --- |
| `npm run doctor` | Vérifie credentials, joignabilité GA4/GSC/Shopify/Slack/Anthropic, sonde les métriques GA4 disponibles, vérifie le scope `read_orders`. |
| `npm run collect -- --month=2026-06` | Collecte GA4 + GSC + Shopify pour le mois demandé (et ses mois de comparaison M-1/M-12) → `data/monthly/2026-06.json`. Aucun appel IA, aucun envoi Slack. |
| `npm run backfill -- --months=14` | Collecte les 14 derniers mois clos, pour disposer de M-1 et M-12 dès le premier vrai rapport. |
| `npm run report -- --month=2026-06` | Génère le rapport (MD + HTML + Slack) à partir du snapshot du mois (le collecte automatiquement s'il manque, et répare les sources en échec périmées avant de construire le rapport — voir plus bas). Options `--no-ai` (pas d'appel Claude), `--no-slack` (pas d'envoi Slack) et `--no-repair` (désactive la réparation). |
| `npm run monthly` | Le run du 3 du mois : `collect` du mois précédent puis `report` complet (agents Claude + Slack). C'est la commande lancée par la tâche planifiée. |

Flags globaux disponibles sur toutes les commandes : `--no-cache` (ignore le
cache disque), `--verbose` (logs détaillés), `--force` (autorise à écraser un
snapshot déjà existant — les snapshots sont immuables par défaut, voir
`SPEC.md` §13).

### Réparation automatique d'un snapshot (`--no-repair`)

Un snapshot est immuable une fois écrit, mais cette immuabilité protège les
**données réussies**, pas des échecs devenus périmés. Exemple concret : un
snapshot collecté avant l'ajout du scope Shopify `read_orders` contient
`{ ok:false, reason:"scope read_orders manquant" }` pour EN/FR/EU — sans
réparation, `npm run report` relirait indéfiniment cet échec périmé même après
correction du scope.

À chaque `npm run report`, si le snapshot existant contient des sources en
échec, seules ces sources précises sont retentées (jamais une recollecte
complète, jamais un coût de quota sur ce qui a déjà réussi). Ce qui réussit
cette fois est fusionné dans le snapshot et réécrit ; ce qui échoue encore est
conservé tel quel, sans jamais faire planter le run. Chaque réparation est
journalisée clairement, par exemple :

```
Réparation du snapshot 2026-06 : Shopify EN/FR/EU récupéré (échec précédent : scope read_orders manquant)
```

`--no-repair` désactive entièrement ce comportement (le rapport est alors
construit tel quel à partir du snapshot existant, échecs compris).

Exemple complet, sans clé Anthropic ni Slack (pour tester en local) :

```bash
npm run collect -- --month=2026-06
npm run report -- --month=2026-06 --no-ai --no-slack
```

## Comment lire le rapport

Chaque mois produit trois fichiers dans `reports/YYYY-MM/` :

- **`RAPPORT.md`** — la version à lire, en français courant, 10 sections dans
  un ordre fixe : en un coup d'œil (6 chiffres clés), ce qui a changé,
  acquisition, e-commerce, SEO, blog, visibilité IA, qualité des données,
  actions du mois, annexes.
- **`rapport.html`** — la même chose en page web autonome (graphiques SVG
  inline, thème clair/sombre automatique, imprimable en PDF). S'ouvre en
  double-clic, hors ligne, aucune connexion requise.
- **`data.json`** — tous les chiffres calculés (le `model` qui alimente le
  rapport) + les sorties des agents Claude + la trace de qualité de la
  collecte (`collection` : champs retirés, sources en échec, avertissements).
  C'est la source de vérité machine : rouvre ce fichier dans Claude Code pour
  creuser un mois passé (« explique-moi pourquoi le SEO a baissé en juin »
  fonctionne directement dessus). Les lignes brutes GA4/GSC/Shopify ne sont
  pas dupliquées ici — elles restent dans `data/monthly/YYYY-MM.json`.

Deux règles de lecture à connaître :

- **« volume trop faible pour conclure »** remplace un pourcentage chaque fois
  que la base de calcul est trop petite (moins de 100 sessions ou 5
  transactions) — c'est voulu, ça évite les faux « +300 % » sur 4 sessions.
- **« ⚠️ chiffres non retrouvés dans les données »** : chaque analyse générée
  par Claude est vérifiée automatiquement (les nombres qu'elle cite doivent se
  retrouver, à ±2 % près, dans les données qui lui ont été fournies). Un
  encart liste les chiffres qui n'ont pas pu être vérifiés — ce n'est pas
  bloquant, juste un signal de prudence à lire avant de citer le chiffre en
  réunion.

## Activer le chiffre d'affaires réel (scope Shopify `read_orders`)

Aujourd'hui, les apps Shopify custom des boutiques EN/FR/EU n'ont que les
scopes `read_content`/`write_content` (hérités du module `Suppression BLOG
Useless`, qui n'a jamais eu besoin de lire les commandes). Résultat : la
section e-commerce du rapport utilise le chiffre d'affaires **GA4** (pixel
Shopify), pas les commandes réelles — c'est explicitement noté dans le
rapport, jamais caché.

Pour passer aux commandes réelles :

1. Ouvre le **Partners Dashboard** Shopify de la boutique concernée (EN, FR ou
   EU), puis l'app custom existante.
2. Dans **Configuration > API access scopes**, ajoute le scope
   **`read_orders`** (ne retire aucun scope existant).
3. Sauvegarde, puis relance l'autorisation :
   ```bash
   # depuis le dossier Suppression BLOG Useless
   npm run auth-shopify
   ```
4. Relance `npm run doctor` ici : la boutique doit passer de
   `?? scope "read_orders" manquant (cas nominal aujourd'hui)` à
   `OK ... commande(s) sur <mois>`.

Aucune autre configuration n'est nécessaire : `shopify.js` détecte
automatiquement le changement de scope au run suivant (le cache ne mémorise
jamais un échec d'autorisation, uniquement les collectes réussies). Et si un
snapshot du mois existe déjà (collecté **avant** l'ajout du scope), pas besoin
de `--force` pour le recollecter en entier : le prochain `npm run report`
répare automatiquement uniquement l'entrée Shopify en échec (voir « Réparation
automatique d'un snapshot » ci-dessus).

## Nouveau vs récurrent vs invité (scope Shopify `read_customers`)

Le scope `read_customers` est actif sur les boutiques EN/FR/EU. Mais contrairement
à ce qu'on pourrait attendre, ça ne suffit **pas** à faire apparaître
`orders_count`/`total_spent` sur l'objet `customer` embarqué dans chaque
commande (`GET /admin/api/2024-10/orders.json`) : vérifié en direct, cet objet
ne porte jamais ces champs, scope ou pas. Seul l'endpoint client dédié,
`GET /admin/api/2024-10/customers/{id}.json`, les renvoie. D'où l'architecture
retenue (`resolveCustomerSegments` dans `shopify.js`) :

1. Les commandes du mois sont dédoublonnées par `customer.id` (une commande
   sans client associé — panier invité — compte à part, dans une catégorie
   **« Invités »**, jamais classée nouveau/récurrent en silence).
2. Chaque client unique est résolu par **un appel API supplémentaire dédié**
   (`customers/{id}.json`), qui donne `orders_count` : nouveau si `<= 1`,
   récurrent si `> 1`.
3. Un client dont la résolution échoue (client supprimé — 404 —, erreur
   réseau, etc.) est journalisé et exclu du calcul — jamais un échec de la
   boutique entière (l'ensemble des commandes/CA reste affiché normalement).

Le rapport affiche, dans le tableau « Commandes réelles (Shopify) », un
sous-tableau **« Nouveaux vs récurrents vs invités (et part du CA brut) »** :
nombre de nouveaux clients, de clients récurrents, d'invités, et la part de
CA brut que représente chaque catégorie (en %, donc comparable même entre
boutiques de devises différentes). Jamais un `0` par défaut : si la
résolution échoue totalement pour une boutique (scope réellement absent, ou
toutes les résolutions individuelles en échec), la ligne est **absente** et la
raison est affichée juste en dessous — comme pour le CA réel lui-même.

### Limite native Shopify — pas contournable

`orders_count` est le nombre **total** de commandes du client **au moment de
l'appel API**, pas "au moment de la fin du mois rapporté". Shopify n'expose
aucun moyen de demander une version historique de ce champ. Concrètement : un
client qui passe sa 1ʳᵉ commande en juin puis une 2ᵉ en juillet apparaîtra
« récurrent » si le rapport de juin est régénéré après juillet, alors qu'au
moment de sa commande de juin il était bel et bien un nouveau client. C'est
une limite structurelle de l'API Shopify, documentée aussi en commentaire dans
`shopify.js` (`resolveCustomerSegments`) — pas un bug de ce module.

### Coût en appels API

**Un appel Shopify supplémentaire par client unique, par mois collecté** — pas
par commande : un client qui passe 3 commandes le même mois ne coûte qu'un
seul appel (dédoublonnage par `customer.id`). Un rapport complet collecte 3
périodes (mois courant, M-1, M-12) × 3 boutiques (EN/FR/EU), donc ce coût est
multiplié par autant de combinaisons boutique/période ayant des commandes.

Pour que ce coût reste maîtrisé :

- **Cache client dédié**, séparé du cache mensuel des commandes :
  `data/cache/customers/<siteKey>/<customerId>.json`, avec une durée de vie
  courte (24h par défaut, `config/thresholds.json` →
  `shopify.customerCacheTtlHours`) indexée sur le client — pas sur le mois du
  rapport. Un même client vu sur plusieurs commandes du mois, ou sur plusieurs
  relances du rapport le même jour, n'est donc re-fetché qu'une fois par
  fenêtre de 24h.
- **Budget d'appels plafonné** : au-delà de `config/thresholds.json` →
  `shopify.maxCustomersPerStore` (500 par défaut) clients uniques à résoudre
  sur une boutique/période, la résolution s'arrête là — un avertissement est
  journalisé, et le rapport affiche explicitement une note « résolution
  partielle (X/Y clients uniques résolus) » plutôt qu'un chiffre qui semble
  complet mais ne l'est pas.

**Mesuré en conditions réelles** (3 boutiques, 3 périodes — mois courant/M-1/M-12,
juin 2026) : environ 720 clients uniques résolus au total (532 EN, 118 FR, 69 EU),
pour une collecte complète en 6 à 7 minutes. Le trafic généré déclenche des `429`
Shopify de façon quasi continue sur la boutique la plus active (EN) ; le backoff
existant (`shopifyFetch`) les absorbe sans jamais faire échouer une boutique, mais
c'est ce qui explique la durée — pas une régression, un vrai coût de ce niveau de
détail.

⚠️ **`--no-cache` contourne aussi le cache client** (même convention que le cache
mensuel — voir plus haut) : une collecte lancée avec `--no-cache` résout bien tous
les clients, mais n'écrit rien dans `data/cache/customers/`. Le premier
`npm run report` qui suit (sans `--no-cache`) doit donc re-résoudre les mêmes
clients une deuxième fois pour, cette fois, les mettre en cache — le flux
d'activation ci-dessous paie donc le coût deux fois de suite la toute première
fois. Les relances suivantes le même jour, elles, sont rapides (cache client
plein).

### Recalculer une donnée déjà collectée

Comme pour le scope `read_orders` : **la réparation automatique de snapshot ne
suffit pas ici**. Les entrées Shopify d'un snapshot déjà collecté sont déjà
`ok:true` (les commandes existent), donc `repairSnapshot` — qui ne retente que
les entrées en échec (`ok:false`) — ne les touche jamais. Un mois déjà
collecté avant l'ajout de cette fonctionnalité affichera `newCustomers: null`
tant qu'il n'est pas recollecté explicitement :

```bash
npm run collect -- --month=2026-06 --no-cache --force
npm run report -- --month=2026-06
```

`--force` est ce qui compte vraiment ici (il contourne le "déjà collecté,
rien à faire" de `collect` et relance une collecte complète du mois) ;
`--no-cache` garantit en plus que les commandes brutes elles-mêmes sont
rechargées depuis Shopify plutôt que depuis le cache disque, pour une donnée
de bout en bout fraîche.

## Recevoir le rapport sur Slack

Sauf `--no-slack`, chaque rapport envoie dans `SLACK_CHANNEL_ID` :

- un **message court** : titre, mois, les 6 tuiles KPI et les 3 actions du
  mois — rien de plus (plus de rapport détaillé posté en messages ou en
  thread) ;
- le fichier **`rapport.html` en pièce jointe**, pour que l'équipe le
  télécharge et l'ouvre dans son navigateur. **Slack ne prévisualise pas le
  contenu d'un fichier HTML** : il apparaît comme une pièce jointe à
  télécharger, pas comme une page affichée dans Slack.

### Le scope `files:write`

Envoyer un fichier utilise le flux Slack actuel en trois temps
(`files.getUploadURLExternal` → dépôt du fichier → `files.completeUploadExternal`)
— l'ancien `files.upload` est déprécié et retiré côté Slack. Ce flux nécessite
le scope **`files:write`** sur le bot token, qui n'a aujourd'hui que
`chat:write`.

Si ce scope manque, le rapport **ne plante pas** : le message court est
envoyé seul, avec le chemin local du HTML indiqué en clair (à ouvrir
manuellement dans un navigateur), et la marche à suivre exacte est affichée
dans les logs. Pour activer la pièce jointe :

1. [api.slack.com/apps](https://api.slack.com/apps) → l'app Lovebox → **OAuth
   & Permissions**.
2. **Bot Token Scopes** : ajoute `files:write` (ne retire aucun scope
   existant).
3. Réinstalle l'app dans le workspace (bouton **Reinstall to Workspace**).
4. Vérifie avec `npm run doctor` — la section Slack doit passer de
   `?? Scope "files:write" manquant` à `OK Scope "files:write" présent`.

`npm run doctor` teste ce scope de façon inoffensive (une URL d'upload est
demandée puis jamais utilisée — aucun fichier n'est réellement envoyé dans le
channel pendant le contrôle).

## Planification

`scripts/schedule-windows.ps1` enregistre une tâche planifiée Windows qui
exécute `npm run monthly` le **3 de chaque mois à 08:00** (le 3 est choisi
pour laisser le temps aux données de se consolider : latence GA4 ~48h, GSC ~3
jours). À lancer une fois :

```powershell
# Terminal PowerShell (clic droit > Exécuter avec PowerShell, ou terminal admin)
.\scripts\schedule-windows.ps1
```

Pour supprimer la tâche :

```powershell
Unregister-ScheduledTask -TaskName "Lovebox Analytics Monthly"
```

**Cette approche nécessite que le PC soit allumé le 3 à 08:00.** Si ce n'est
pas garanti, deux alternatives sans dépendre d'un poste local :

- La skill **`/schedule`** de Claude Code (routine cloud programmée).
- Un workflow **GitHub Actions** planifié (`cron`) sur ce dépôt, qui lance
  `npm run monthly` dans un environnement éphémère — nécessite d'y stocker les
  secrets `.env` en tant que secrets GitHub Actions.

## Angles morts corrigés par ce module

Constats faits sur l'existant (`Suppression BLOG Useless`) et traitement
apporté ici (détail complet dans `SPEC.md` §2) :

| Constat sur l'existant | Traitement dans `analytics` |
| --- | --- |
| `sites.json` ne déclarait que 6 hosts, mais GA4 en voit d'autres (`ca.lovebox.love`, `keep.lovebox.love`, `www.kickstarter.com`) — trafic silencieusement écarté | Registre de sites élargi + **découverte automatique** des hosts inconnus, remontée en alerte qualité (§10.1), jamais juste ignorée |
| Landing pages `/web-pixels@…` et autres URL de bruit polluaient les analyses de trafic | Filtrage par `config/noise-patterns.json` + mesure explicite du % de bruit (§10.2) |
| Sessions > 0 mais revenu = 0 € sur `buy`/`store`/`boutique` : impossible de distinguer un vrai zéro d'un tracking cassé | Contrôle qualité dédié (§10.3) + réconciliation GA4 ↔ Shopify (§10.4) |
| Fenêtres glissantes 30j/90j uniquement — aucune comparaison mensuelle ou annuelle propre | Tout est indexé sur mois calendaire, avec comparaison M-1 et M-12 systématique |
| Pas d'historique exploitable (seul le dernier run comptait) | Snapshots mensuels immuables (`data/monthly/YYYY-MM.json`) + commande `backfill` |
| GA4 limité à sessions/revenu/vues | Couverture e-commerce complète : entonnoir d'achat, AOV, taux de conversion, produits, visibilité IA, écart 1er contact/dernier clic |
| Un canal pouvait être jugé « non rentable » sur la seule base du dernier clic | `attributionGap` (premier contact vs dernier clic) systématiquement calculé et rappelé dans le prompt système des agents — jamais de conclusion hâtive sur le blog ou un canal de découverte |
| Des variations en % pouvaient s'afficher sur des volumes minuscules (« +300 % » sur 4 sessions) | Garde-fou de significativité (§9) : sous 100 sessions ou 5 transactions, on écrit « volume trop faible pour conclure », jamais un pourcentage trompeur |
| Aucune vérification que les analyses générées par IA citent des chiffres réels | Vérification automatique des chiffres (§11) : tout nombre cité par un agent sans correspondance (±2 %) dans les données fournies est listé en encart « chiffres non retrouvés » |

## Développement

```bash
npm test          # tests unitaires, sans réseau ni credentials
```

Les tests couvrent les couches pures (`period.js`, `metrics.js`,
`normalize.js`, `quality.js`, `insights.js`, `charts.js`, `report/markdown.js`,
`report/html.js`) avec des fixtures JSON, ainsi que la passe de réparation des
snapshots (`lib/collect.js` → `repairSnapshot`, testée via un collecteur
injecté pour rester sans réseau) — aucun test n'appelle GA4, GSC, Shopify,
Slack ou Anthropic.
