#!/usr/bin/env node
/**
 * Lance le flow OAuth2 Google une seule fois. Utile UNIQUEMENT si le token
 * partagé avec `Suppression BLOG Useless` (GOOGLE_TOKEN_PATH) est
 * révoqué/expiré et doit être régénéré — en usage normal, `analytics`
 * réutilise tel quel le token déjà généré par l'autre module.
 *
 * IMPORTANT : ce module ne doit jamais écrire dans le dossier de l'autre
 * module. Le nouveau token est donc TOUJOURS sauvegardé ici, dans
 * `analytics/data/google-token.json` — jamais à l'emplacement de
 * GOOGLE_TOKEN_PATH même si celui-ci pointe ailleurs. Pour que ce module
 * l'utilise, mets à jour GOOGLE_TOKEN_PATH dans `.env` vers ce nouveau
 * fichier (ou copie-le toi-même par-dessus le token partagé si tu veux
 * aussi mettre à jour `Suppression BLOG Useless`).
 *
 * Usage : npm run auth-google
 */
import "dotenv/config";
import { OAuth2Client } from "google-auth-library";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_PATH = path.join(ROOT, "data", "google-token.json");
const DATA_DIR = path.join(ROOT, "data");

const SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
];

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const redirectUri = "http://localhost:3000/oauth2callback";

if (!clientId || !clientSecret) {
  console.error("Erreur : GOOGLE_CLIENT_ID ou GOOGLE_CLIENT_SECRET manquant dans .env");
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const client = new OAuth2Client(clientId, clientSecret, redirectUri);

const authUrl = client.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES,
  prompt: "consent", // force le refresh_token même si déjà autorisé
});

console.log("\nOuverture du navigateur pour l'autorisation Google...");
console.log("Si le navigateur ne s'ouvre pas, copie cette URL :\n");
console.log(authUrl, "\n");

// Ouvre le navigateur (Windows)
exec(`start "" "${authUrl}"`);

// Serveur local pour recevoir le callback
const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/oauth2callback")) return;

  const url = new URL(req.url, "http://localhost:3000");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.end(`<h2>Erreur : ${error}</h2><p>Ferme cette fenêtre.</p>`);
    server.close();
    console.error(`Autorisation refusée : ${error}`);
    process.exit(1);
  }

  try {
    const { tokens } = await client.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

    res.end(`
      <h2>Autorisation réussie !</h2>
      <p>Token sauvegardé dans analytics/data/google-token.json.</p>
      <p>Mets à jour GOOGLE_TOKEN_PATH dans .env si tu veux que ce module l'utilise.</p>
    `);
    server.close();

    console.log(`Token sauvegardé dans ${TOKEN_PATH}`);
    console.log("Mets à jour GOOGLE_TOKEN_PATH dans .env pour que ce module l'utilise, puis lance : npm run doctor");
    process.exit(0);
  } catch (err) {
    res.end(`<h2>Erreur : ${err.message}</h2>`);
    server.close();
    console.error("Erreur lors de l'échange du code :", err.message);
    process.exit(1);
  }
});

server.listen(3000, () => {
  console.log("En attente du callback sur http://localhost:3000/oauth2callback ...");
});
