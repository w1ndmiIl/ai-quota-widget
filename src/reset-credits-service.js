"use strict";

const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

async function readResetCredits() {
  const token = readAccessToken();
  const payload = await requestJson(RESET_CREDITS_URL, token);
  return normalizeResetCredits(payload);
}

function readAccessToken() {
  const authPath = path.join(os.homedir(), ".codex", "auth.json");
  const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  const token = auth?.tokens?.access_token;
  if (!token) {
    throw new Error("tokens.access_token not found in Codex auth.json");
  }
  return token;
}

function requestJson(url, token, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`
        }
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode === 401) {
            reject(new Error("凭证失效或缺少 Authorization header"));
            return;
          }
          if (!response.statusCode || response.statusCode >= 400) {
            reject(new Error(`reset credits request failed: ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("reset credits response is not JSON"));
          }
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("reset credits request timed out"));
    });
    request.on("error", reject);
    request.end();
  });
}

function normalizeResetCredits(payload) {
  const credits = Array.isArray(payload?.credits) ? payload.credits : payload?.credits ? [payload.credits] : [];
  const normalizedCredits = credits.map((credit) => ({
    status: credit.status ?? null,
    title: credit.title ?? null,
    grantedAt: normalizeDateTime(credit.granted_at),
    expiresAt: normalizeDateTime(credit.expires_at)
  })).sort(compareExpiry);
  return {
    availableCount: readNonNegativeInteger(
      payload?.available_count,
      normalizedCredits.filter((credit) => credit.status === "available").length
    ),
    credits: normalizedCredits
  };
}

function compareExpiry(a, b) {
  const aTime = a.expiresAt ?? Number.POSITIVE_INFINITY;
  const bTime = b.expiresAt ?? Number.POSITIVE_INFINITY;
  return aTime - bTime;
}

function normalizeDateTime(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "number") {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readNumber(value, fallback) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function readNonNegativeInteger(value, fallback) {
  const number = readNumber(value, fallback);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

module.exports = {
  readResetCredits,
  normalizeResetCredits
};
