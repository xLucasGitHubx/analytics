import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const paths = {
	root: ROOT,
	config: path.join(ROOT, "config"),
	data: path.join(ROOT, "data"),
	cache: path.join(ROOT, "data", "cache"),
	monthly: path.join(ROOT, "data", "monthly"),
	reports: path.join(ROOT, "reports"),
};

for (const dir of [paths.data, paths.cache, paths.monthly, paths.reports]) {
	fs.mkdirSync(dir, { recursive: true });
}

export function loadConfig(name) {
	return JSON.parse(fs.readFileSync(path.join(paths.config, `${name}.json`), "utf8"));
}

/**
 * Chemin du token OAuth Google. Par défaut, on réutilise TEL QUEL celui déjà
 * généré par le module `Suppression BLOG Useless` (voir .env.example) — pas de
 * nouvelle authentification. `GOOGLE_TOKEN_PATH` peut être absolu ou relatif
 * à la racine de `analytics/`.
 */
function resolveGoogleTokenPath() {
	const raw = process.env.GOOGLE_TOKEN_PATH || "../Suppression BLOG Useless/data/google-token.json";
	return path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
}

function numberOrNull(raw) {
	if (raw === undefined || raw === "") return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
}

export const env = {
	anthropicKey: process.env.ANTHROPIC_API_KEY || "",
	analyticsModel: process.env.ANALYTICS_MODEL || "claude-sonnet-5",

	googleClientId: process.env.GOOGLE_CLIENT_ID || "",
	googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
	googleRedirectUri: "http://localhost:3000/oauth2callback",
	googleTokenPath: resolveGoogleTokenPath(),

	ga4PropertyId: process.env.GA4_PROPERTY_ID || "",

	slackToken: process.env.SLACK_BOT_TOKEN || "",
	slackChannel: process.env.SLACK_CHANNEL_ID || "",

	shopify: {
		EN: { domain: process.env.SHOPIFY_STORE_EN_DOMAIN || "", token: process.env.SHOPIFY_STORE_EN_TOKEN || "" },
		FR: { domain: process.env.SHOPIFY_STORE_FR_DOMAIN || "", token: process.env.SHOPIFY_STORE_FR_TOKEN || "" },
		EU: { domain: process.env.SHOPIFY_STORE_EU_DOMAIN || "", token: process.env.SHOPIFY_STORE_EU_TOKEN || "" },
	},

	// Surcharge optionnelle des seuils de config/thresholds.json (significance.*)
	// sans avoir à toucher au fichier — null = pas de surcharge, on garde la config.
	significanceOverrides: {
		minSessions: numberOrNull(process.env.SIGNIFICANCE_MIN_SESSIONS),
		minTransactions: numberOrNull(process.env.SIGNIFICANCE_MIN_TRANSACTIONS),
	},
};

/**
 * Vérifie les credentials. Retourne la liste des problèmes (vide = tout bon).
 * `scope` permet de ne vérifier que ce dont une routine a besoin.
 * Ne vérifie JAMAIS la joignabilité réseau — voir `doctor` pour ça.
 */
export function checkEnv(scope = ["google", "anthropic", "shopify"]) {
	const problems = [];
	if (scope.includes("google")) {
		if (!env.googleClientId) problems.push("GOOGLE_CLIENT_ID manquant");
		if (!env.googleClientSecret) problems.push("GOOGLE_CLIENT_SECRET manquant");
		if (!env.ga4PropertyId) problems.push("GA4_PROPERTY_ID manquant");
		if (!fs.existsSync(env.googleTokenPath)) {
			problems.push(
				`Token Google absent (${env.googleTokenPath}) — vérifie GOOGLE_TOKEN_PATH dans .env, ` + `ou régénère-le avec : npm run auth-google`,
			);
		}
	}
	if (scope.includes("anthropic") && !env.anthropicKey) problems.push("ANTHROPIC_API_KEY manquant");
	if (scope.includes("slack")) {
		if (!env.slackToken) problems.push("SLACK_BOT_TOKEN manquant");
		if (!env.slackChannel) problems.push("SLACK_CHANNEL_ID manquant");
	}
	if (scope.includes("shopify")) {
		for (const [key, s] of Object.entries(env.shopify)) {
			if (!s.domain || !s.token) problems.push(`Shopify ${key}: domaine ou token manquant`);
		}
	}
	return problems;
}
