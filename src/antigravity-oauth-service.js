"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { spawn } = require("node:child_process");

const QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_RESPONSE_BYTES = 1024 * 1024;

function readWindowsCredentials() {
  if (process.platform !== "win32") return Promise.reject(new Error("Antigravity Windows sign-in is unavailable"));
  const temporary = path.join(process.env.AI_QUOTA_USER_DATA_PATH || path.join(os.homedir(), ".ai-quota-widget"), "oauth-helper-temp");
  fs.mkdirSync(temporary, { recursive: true });
  const script = fs.readFileSync(path.join(__dirname, "antigravity-credential-reader.ps1"), "utf8");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TEMP: temporary, TMP: temporary }
    });
    let output = "", bytes = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error("Antigravity sign-in read timed out")); }, 5000);
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 65536) { child.kill(); reject(new Error("Invalid Antigravity sign-in record")); }
      else output += chunk.toString("utf8");
    });
    child.stderr.resume(); // Never surface credential/helper output in diagnostics.
    child.on("error", () => { clearTimeout(timer); reject(new Error("Antigravity sign-in reader could not start")); });
    child.on("exit", code => {
      clearTimeout(timer);
      try { if (code !== 0) throw new Error(); resolve(JSON.parse(output)); }
      catch { reject(new Error("Antigravity sign-in unavailable; sign in with Antigravity or agy")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(script + "\n\n");
  });
}

function normalizeCredentials(value) {
  const token = value?.token || value;
  const accessToken = token?.access_token;
  if (typeof accessToken !== "string" || !accessToken.trim()) throw new Error("Antigravity saved access token is unavailable");
  return { accessToken, refreshToken: token.refresh_token || null, expiry: Date.parse(token.expiry), idToken: value.id_token || null };
}

function readProject() {
  try {
    const project = fs.readFileSync(path.join(os.homedir(), ".gemini", "antigravity-cli", "cache", "default_project_id.txt"), "utf8").trim();
    return project && project.length < 256 ? project : null;
  } catch { return null; }
}

async function discoverOAuthClients(credentials) {
  let audience;
  try { audience = JSON.parse(Buffer.from(credentials.idToken.split(".")[1], "base64url").toString("utf8")).aud; } catch {}
  if (typeof audience !== "string" || !/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(audience)) {
    throw new Error("Antigravity OAuth client identity is unavailable; sign in again");
  }
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const paths = [...(process.env.PATH || "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, "agy.exe")),
    path.join(local, "Programs", "Antigravity", "resources", "bin", "language_server.exe")];
  for (const file of [...new Set(paths)]) {
    if (!fs.existsSync(file)) continue;
    const secrets = new Set(); let matched = false, tail = "";
    // Bound memory while reading the official installed binary; never execute it.
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 65536 })) {
      const text = tail + chunk.toString("latin1");
      matched ||= text.includes(audience);
      for (const match of text.matchAll(/GOCSPX-[A-Za-z0-9_-]{28}/g)) secrets.add(match[0]);
      tail = text.slice(-256);
    }
    if (matched && secrets.size > 0 && secrets.size <= 4) return [...secrets].map(secret => ({ clientId: audience, clientSecret: secret }));
  }
  throw new Error("Antigravity OAuth refresh client was not found in the installed app or agy");
}

function requestGoogle(url, { token, form, body = {} } = {}) {
  if (![QUOTA_URL, TOKEN_URL].includes(url)) return Promise.reject(new Error("Unknown Antigravity OAuth endpoint"));
  const payload = form ? new URLSearchParams(form).toString() : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    let deadline;
    const request = https.request(url, {
      method: "POST", headers: {
        "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json",
        "Content-Length": Buffer.byteLength(payload), "User-Agent": "antigravity",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, response => {
      const chunks = []; let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) request.destroy(new Error("Antigravity OAuth response exceeded its limit"));
        else chunks.push(chunk);
      });
      response.on("error", () => reject(new Error("Antigravity OAuth response was interrupted")));
      response.on("end", () => {
        clearTimeout(deadline);
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { reject(new Error("Invalid Antigravity OAuth response")); return; }
        if (response.statusCode !== 200) {
          const error = new Error(`Antigravity OAuth request failed (${response.statusCode || "unknown"})`);
          error.statusCode = response.statusCode;
          error.oauthError = ["invalid_client", "invalid_grant"].includes(value.error) ? value.error : null;
          reject(error); return;
        }
        resolve(value);
      });
    });
    deadline = setTimeout(() => request.destroy(new Error("Antigravity OAuth request timed out")), 5000);
    request.on("close", () => clearTimeout(deadline));
    request.setTimeout(5000, () => request.destroy(new Error("Antigravity OAuth request timed out")));
    request.on("error", error => {
      clearTimeout(deadline);
      reject(new Error(error.code ? `Antigravity OAuth connection failed (${error.code})` : error.message));
    });
    request.end(payload);
  });
}

class AntigravityOAuthService {
  constructor({ readCredentials = readWindowsCredentials, request = requestGoogle, readClient = discoverOAuthClients, getProject = readProject, now = Date.now } = {}) {
    Object.assign(this, { readCredentials, request, readClient, getProject, now });
    this.refreshed = null;
    this.client = null;
  }
  async readQuota() {
    const credentials = normalizeCredentials(await this.readCredentials());
    if (this.originalAccessToken !== credentials.accessToken) {
      this.originalAccessToken = credentials.accessToken;
      this.refreshed = null;
      this.client = null;
    }
    let token = credentials.accessToken;
    if (this.refreshed?.original === token && this.refreshed.expiry > this.now() + 60000) token = this.refreshed.accessToken;
    else if (Number.isFinite(credentials.expiry) && credentials.expiry <= this.now() + 60000) token = await this.refresh(credentials);
    const project = this.getProject();
    const body = project ? { project } : {};
    try { return await this.request(QUOTA_URL, { token, body }); }
    catch (error) {
      if (error.statusCode !== 401) throw error;
      token = await this.refresh(credentials);
      return this.request(QUOTA_URL, { token, body });
    }
  }
  async refresh(credentials) {
    if (!credentials.refreshToken) throw new Error("Antigravity sign-in expired; sign in again");
    const candidates = this.client ? [this.client] : await this.readClient(credentials);
    for (const client of candidates) {
      let value;
      try {
        value = await this.request(TOKEN_URL, { form: {
          client_id: client.clientId, client_secret: client.clientSecret,
          refresh_token: credentials.refreshToken, grant_type: "refresh_token"
        } });
      } catch (error) {
        if (error.oauthError === "invalid_client") continue;
        throw new Error("Antigravity sign-in could not be renewed; sign in again");
      }
      if (typeof value.access_token !== "string" || !value.access_token || !Number.isFinite(Number(value.expires_in)) || Number(value.expires_in) <= 0) {
        throw new Error("Invalid Antigravity sign-in renewal response");
      }
      this.client = client;
      this.refreshed = { original: credentials.accessToken, accessToken: value.access_token, expiry: this.now() + Number(value.expires_in) * 1000 };
      return value.access_token;
    }
    throw new Error("Antigravity OAuth client could not renew this sign-in");
  }
}
module.exports = { AntigravityOAuthService, QUOTA_URL, TOKEN_URL, normalizeCredentials, discoverOAuthClients };
