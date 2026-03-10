import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";

const PORT = Number(process.env.PORT || 2525);
const ZEPTO_API_URL = process.env.ZEPTO_API_URL || "https://api.zeptomail.eu/v1.1/email";
const ZEPTOMAIL_TOKEN = process.env.ZEPTOMAIL_TOKEN;
const FROM_FALLBACK = process.env.FROM_FALLBACK || "";
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

const MAX_CONCURRENT_SENDS = Number(process.env.MAX_CONCURRENT_SENDS || 10);
const SEND_TIMEOUT_MS = Number(process.env.SEND_TIMEOUT_MS || 20000);
const RETRY_COUNT = Number(process.env.RETRY_COUNT || 3);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 1500);

const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || "")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

const SIGNATURE_DOMAINS = [
  "www.berg-fit.de",
  "www.bella-balu.de",
  "www.gartenort.de",
  "www.bergaktiv.de",
  "www.hike-care.com",
  "www.hikecarewinkel.nl",
  "www.gardenhomie.com",
  "www.hikecare.co.uk"
];

const ROUTE_RULES = (() => {
  try {
    const parsed = JSON.parse(process.env.ROUTE_RULES_JSON || "[]");

    if (!Array.isArray(parsed)) {
      throw new Error("ROUTE_RULES_JSON must be an array");
    }

    return parsed.map((rule) => ({
      name: String(rule.name || "unnamed-route").trim(),
      provider: String(rule.provider || "zepto").trim().toLowerCase(),
      fromAddress: String(rule.fromAddress || "").trim(),
      domains: Array.isArray(rule.domains)
        ? rule.domains.map((d) => String(d).trim().toLowerCase()).filter(Boolean)
        : []
    }));
  } catch (err) {
    throw new Error(`Invalid ROUTE_RULES_JSON: ${err.message}`);
  }
})();

const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_ACCOUNT_ID = process.env.ZOHO_ACCOUNT_ID;

if (!ZEPTOMAIL_TOKEN) throw new Error("Missing env var: ZEPTOMAIL_TOKEN");
if (!SMTP_USER || !SMTP_PASS) throw new Error("Missing env vars: SMTP_USER / SMTP_PASS");
if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN || !ZOHO_ACCOUNT_ID) {
  throw new Error("Missing Zoho Mail API env vars");
}

const queue = [];
let activeSends = 0;
let jobIdCounter = 0;

let zohoAccessToken = null;
let zohoTokenExpiry = 0;

function getDomain(email = "") {
  const parts = String(email).toLowerCase().trim().split("@");
  return parts.length === 2 ? parts[1] : "";
}

function isAllowedDomain(email = "") {
  if (ALLOWED_DOMAINS.length === 0) return true;
  return ALLOWED_DOMAINS.includes(getDomain(email));
}

function getRoute(recipientEmail = "") {
  const domain = getDomain(recipientEmail);

  for (const rule of ROUTE_RULES) {
    if (rule.domains.includes(domain)) {
      return rule;
    }
  }

  return {
    name: "zepto-default",
    provider: "zepto",
    fromAddress: ""
  };
}

function shouldUseZohoFallback(recipientEmail = "") {
  return getRoute(recipientEmail).provider === "zoho";
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(status, message = "") {
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  return /timeout|network|fetch failed|socket hang up|temporar/i.test(String(message).toLowerCase());
}

function cleanText(text = "") {
  const lines = String(text || "").split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();

    if (SIGNATURE_DOMAINS.some((domain) => line.includes(domain))) {
      return lines.slice(0, i + 1).join("\n").trim();
    }
  }

  return String(text || "").trim();
}

async function getZohoAccessToken() {
  const now = Date.now();

  if (zohoAccessToken && now < zohoTokenExpiry) {
    return zohoAccessToken;
  }

  const params = new URLSearchParams({
    refresh_token: ZOHO_REFRESH_TOKEN,
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token"
  });

  const res = await fetch("https://accounts.zoho.eu/oauth/v2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  const raw = await res.text();

  if (!res.ok) {
    throw new Error(`Zoho token error ${res.status}: ${raw}`);
  }

  const data = JSON.parse(raw);

  if (!data.access_token) {
    throw new Error(`Zoho token missing access_token: ${raw}`);
  }

  zohoAccessToken = data.access_token;
  zohoTokenExpiry = Date.now() + ((data.expires_in || 3600) - 300) * 1000;

  console.log("[ZOHO TOKEN] New access token cached");

  return zohoAccessToken;
}

async function sendViaZohoMailApi({
  from,
  to,
  subject,
  textBody,
  jobId,
  inReplyTo,
  references
}) {
  const safeText = textBody && textBody.trim() ? textBody : " ";
  const route = getRoute(to);
  const actualFrom = route.fromAddress || from;

  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

    try {
      const accessToken = await getZohoAccessToken();

      const payload = {
        fromAddress: actualFrom,
        toAddress: to,
        subject: subject || "Support Reply",
        content: safeText,
        mailFormat: "plaintext"
      };

      if (inReplyTo) payload.inReplyTo = inReplyTo;
      if (references) payload.references = Array.isArray(references) ? references.join(" ") : references;

      const res = await fetch(`https://mail.zoho.eu/api/accounts/${ZOHO_ACCOUNT_ID}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const raw = await res.text();

      console.log(
        `[ZOHO-API][${jobId}] Attempt ${attempt}/${RETRY_COUNT} -> ${res.status} | route=${route.name} | ${actualFrom} -> ${to} | ${subject}`
      );

      if (!res.ok) {
        if (res.status === 401 || res.status === 400) {
          zohoAccessToken = null;
          zohoTokenExpiry = 0;
        }

        const err = new Error(`Zoho Mail API error ${res.status}: ${raw}`);
        err.status = res.status;
        err.raw = raw;

        if (attempt < RETRY_COUNT && shouldRetry(res.status, raw)) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }

        throw err;
      }

      return raw;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function sendViaZeptoMail({
  from,
  to,
  subject,
  textBody,
  jobId
}) {
  const safeText = textBody && textBody.trim() ? textBody : " ";

  const payload = {
    from: {
      address: from
    },
    to: [
      {
        email_address: {
          address: to
        }
      }
    ],
    subject: subject || "Support Reply",
    textbody: safeText,
    htmlbody: `<pre>${escapeHtml(safeText)}</pre>`
  };

  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

    try {
      const res = await fetch(ZEPTO_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: ZEPTOMAIL_TOKEN
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const raw = await res.text();

      console.log(
        `[ZEPTO][${jobId}] Attempt ${attempt}/${RETRY_COUNT} -> ${res.status} | ${from} -> ${to} | ${subject}`
      );

      if (!res.ok) {
        const err = new Error(`ZeptoMail error ${res.status}: ${raw}`);
        err.status = res.status;
        err.raw = raw;

        if (attempt < RETRY_COUNT && shouldRetry(res.status, raw)) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }

        throw err;
      }

      return raw;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function sendEmail(job) {
  if (shouldUseZohoFallback(job.to)) {
    return sendViaZohoMailApi(job);
  }

  return sendViaZeptoMail(job);
}

function processQueue() {
  while (activeSends < MAX_CONCURRENT_SENDS && queue.length > 0) {
    const job = queue.shift();
    activeSends++;

    (async () => {
      try {
        await sendEmail(job.data);
        console.log(`[QUEUE][${job.id}] Sent | active=${activeSends - 1} queued=${queue.length}`);
        job.resolve();
      } catch (err) {
        console.error(`[QUEUE][${job.id}] Failed:`, err?.message || err);
        job.reject(err);
      } finally {
        activeSends--;
        processQueue();
      }
    })();
  }
}

function enqueueSend(data) {
  return new Promise((resolve, reject) => {
    const id = ++jobIdCounter;
    const route = getRoute(data.to);

    queue.push({
      id,
      data: { ...data, jobId: id },
      resolve,
      reject
    });

    console.log(
      `[QUEUE][${id}] Enqueued | route=${route.name} | provider=${route.provider} | active=${activeSends} queued=${queue.length}`
    );

    processQueue();
  });
}

function summarize(parsed) {
  return {
    subject: parsed.subject || "",
    from: parsed.from?.value?.map((x) => x.address) || [],
    to: parsed.to?.value?.map((x) => x.address) || [],
    hasText: !!parsed.text,
    hasHtml: !!parsed.html,
    textLength: parsed.text?.length || 0,
    htmlLength: typeof parsed.html === "string" ? parsed.html.length : 0,
    messageId: parsed.messageId || "",
    inReplyTo: parsed.inReplyTo || "",
    references: parsed.references || []
  };
}

const server = new SMTPServer({
  secure: false,
  authOptional: false,
  disabledCommands: ["STARTTLS"],

  onAuth(auth, session, callback) {
    if (auth.username === SMTP_USER && auth.password === SMTP_PASS) {
      return callback(null, { user: auth.username });
    }

    return callback(new Error("Invalid SMTP login"));
  },

  async onData(stream, session, callback) {
    try {
      const parsed = await simpleParser(stream);

      console.log("[MAIL] Parsed:", JSON.stringify(summarize(parsed)));

      const parsedFrom = parsed.from?.value?.[0]?.address || "";
      const parsedTo = parsed.to?.value?.[0]?.address || "";

      const from = parsedFrom || FROM_FALLBACK;
      const to = parsedTo;
      const subject = parsed.subject || "Support Reply";

      const inReplyTo = parsed.inReplyTo || "";
      const references = parsed.references || [];
      const messageId = parsed.messageId || "";

      if (!from) throw new Error("Missing FROM address");
      if (!to) throw new Error("Missing TO address");

      if (!isAllowedDomain(from)) {
        throw new Error(`Blocked sender domain: ${from}`);
      }

      const rawText = parsed.text || "";
      const cleanedText = cleanText(rawText);
      const route = getRoute(to);

      console.log("[CLEAN] text before/after:", rawText.length, "->", cleanedText.length);
      console.log("[ROUTE]", route.name.toUpperCase(), "| provider =", route.provider, "| recipient =", to);
      console.log("[THREAD]", {
        messageId,
        inReplyTo,
        references: Array.isArray(references) ? references.join(" ") : references
      });

      await enqueueSend({
        from,
        to,
        subject,
        textBody: cleanedText,
        inReplyTo,
        references,
        messageId
      });

      callback();
    } catch (err) {
      console.error("[MAIL] SMTP relay error:", err?.message || err);
      callback(err);
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("[BOOT] SMTP relay listening on port", PORT);
  console.log("[BOOT] MAX_CONCURRENT_SENDS =", MAX_CONCURRENT_SENDS);
  console.log("[BOOT] ROUTE_RULES =", JSON.stringify(ROUTE_RULES));
});
