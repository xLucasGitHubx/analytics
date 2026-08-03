import { OAuth2Client } from "google-auth-library";
import fs from "node:fs";
import { env } from "./env.js";
import { logger } from "./logger.js";

let cachedClient = null;

export function getOAuth2Client() {
  return new OAuth2Client(env.googleClientId, env.googleClientSecret, env.googleRedirectUri);
}

/**
 * Client Google authentifié. Réutilise TEL QUEL le token OAuth déjà généré
 * par le module `Suppression BLOG Useless` (GOOGLE_TOKEN_PATH) — pas de
 * nouvelle authentification.
 *
 * Important : ce fichier de token appartient à l'autre module et reste en
 * LECTURE SEULE ici, y compris à l'exécution. Si l'access token expire,
 * google-auth-library le rafraîchit en mémoire (via le refresh_token déjà
 * présent) pour la durée du process, mais on ne réécrit jamais le fichier
 * source — c'est un choix assumé pour ne jamais risquer de modifier un
 * fichier de l'autre module. Si le token doit être régénéré (refresh_token
 * révoqué), voir `scripts/auth-google.js`.
 */
export async function googleClient() {
  if (cachedClient) return cachedClient;

  if (!fs.existsSync(env.googleTokenPath)) {
    throw new Error(
      "Token Google absent.\n" +
      `  Attendu : ${env.googleTokenPath}\n` +
      "  Ce module réutilise par défaut le token déjà généré par `Suppression BLOG Useless`.\n" +
      "  Vérifie GOOGLE_TOKEN_PATH dans .env, ou régénère un token ici avec : npm run auth-google"
    );
  }

  let tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(env.googleTokenPath, "utf8"));
  } catch (err) {
    throw new Error(`Token Google illisible (${env.googleTokenPath}) : ${err.message}`);
  }

  const client = getOAuth2Client();
  client.setCredentials(tokens);

  cachedClient = client;
  return cachedClient;
}

/**
 * Requête Google authentifiée avec backoff exponentiel + respect de
 * `Retry-After` sur 429/5xx (GA4 et Search Console partagent ce pattern).
 * Ne retente jamais sur une erreur 4xx non liée au quota (400, 403 métier…) —
 * ces erreurs remontent immédiatement pour être traitées par l'appelant
 * (ex. sonde de métriques GA4, tolérance GSC par site).
 */
export async function googleRequest(url, body, { maxAttempts = 5 } = {}) {
  const client = await googleClient();
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await client.request({
        url,
        method: body ? "POST" : "GET",
        data: body,
      });
      return res.data;
    } catch (err) {
      const status = err.response?.status ?? err.code;
      const retryable = status === 429 || (typeof status === "number" && status >= 500 && status < 600);
      if (!retryable || attempt >= maxAttempts) throw err;

      const retryAfterHeader = err.response?.headers?.["retry-after"];
      const waitMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : Math.min(30000, 500 * 2 ** attempt); // backoff exponentiel plafonné à 30s

      logger.warn(`Google API ${status} — nouvelle tentative dans ${waitMs}ms (${attempt}/${maxAttempts})`, url);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
