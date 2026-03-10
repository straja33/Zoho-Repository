// server.js

import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { Queue, Worker, QueueEvents } from "bullmq";
import IORedis from "ioredis";

const PORT = Number(process.env.PORT || 2525);

const REDIS_URL = process.env.REDIS_URL;
const QUEUE_NAME = process.env.QUEUE_NAME || "smtp-relay-jobs";

const ZEPTO_API_URL =
  process.env.ZEPTO_API_URL || "https://api.zeptomail.eu/v1.1/email";
const ZEPTOMAIL_TOKEN = process.env.ZEPTOMAIL_TOKEN;

const FROM_FALLBACK = process.env.FROM_FALLBACK || "";
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

const WORKER_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 10);
const SEND_TIMEOUT_MS = Number(process.env.SEND_TIMEOUT_MS || 20000);

const JOB_ATTEMPTS = Number(process.env.JOB_ATTEMPTS || 4);
const JOB_BACKOFF_MS = Number(process.env.JOB_BACKOFF_MS || 3000);

const PROVIDER_RETRY_COUNT = Number(process.env.PROVIDER_RETRY_COUNT || 2);
const PROVIDER_RETRY_DELAY_MS = Number(
  process.env.PROVIDER_RETRY_DELAY_MS || 1500
);

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
  "www.hikecare.co.uk",
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
        ? rule.domains
            .map((d) => String(d).trim().toLowerCase())
            .filter(Boolean)
        : [],
    }));
  } catch (err) {
    throw new Error(`Invalid ROUTE_RULES_JSON: ${err.message}`);
  }
})();

const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_ACCOUNT_ID = process.env.ZOHO_ACCOUNT_ID;

if (!REDIS_URL) throw new Error("Missing env var: REDIS_URL");
if (!ZEPTOMAIL_TOKEN) throw new Error("Missing env var: ZEPTOMAIL_TOKEN");
if (!SMTP_USER || !SMTP_PASS) {
  throw new Error("Missing env vars: SMTP_USER / SMTP_PASS");
}
if (
  !ZOHO_CLIENT_ID ||
  !ZOHO_CLIENT_SECRET ||
  !ZOHO_REFRESH_TOKEN ||
  !ZOHO_ACCOUNT_ID
) {
  throw new Error("Missing Zoho Mail API env vars");
}

const redisConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const queue = new Queue(QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: JOB_ATTEMPTS,
    backoff: {
      type: "exponential",
      delay: JOB_BACKOFF_MS,
    },
    removeOnComplete: 500,
    removeOnFail: 1000,
  },
});

const queueEvents = new QueueEvents(QUEUE_NAME, {
  connection: redisConnection.duplicate(),
});

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
    fromAddress: "",
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
  return /timeout|network|fetch failed|socket hang up|temporar/i.test(
    String(message).toLowerCase()
  );
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
    grant_type: "refresh_token",
  });

  const res = await fetch("https://accounts.zoho.eu/oauth/v2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
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
  references,
}) {
  const safeText = textBody && textBody.trim() ? textBody : " ";
  const route = getRoute(to);
  const actualFrom = route.fromAddress || from;

  for (let attempt = 1; attempt <= PROVIDER_RETRY_COUNT; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

    try {
      const accessToken = await getZohoAccessToken();

      const payload = {
        fromAddress: actualFrom,
        toAddress: to,
        subject: subject || "Support Reply",
        content: safeText,
        mailFormat: "plaintext",
      };

      if (inReplyTo) payload.inReplyTo = inReplyTo;
      if (references) {
        payload.references = Array.isArray(references)
          ? references.join(" ")
          : references;
      }

      const res = await fetch(
        `https://mail.zoho.eu/api/accounts/${ZOHO_ACCOUNT_ID}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        }
      );

      const raw = await res.text();

      console.log(
        `[ZOHO-API][${jobId}] Attempt ${attempt}/${PROVIDER_RETRY_COUNT} -> ${res.status} | route=${route.name} | ${actualFrom} -> ${to} | ${subject}`
      );

      if (!res.ok) {
        if (res.status === 401 || res.status === 400) {
          zohoAccessToken = null;
          zohoTokenExpiry = 0;
        }

        const err = new Error(`Zoho Mail API error ${res.status}: ${raw}`);
        err.status = res.status;
        err.raw = raw;

        if (attempt < PROVIDER_RETRY_COUNT && shouldRetry(res.status, raw)) {
          await sleep(PROVIDER_RETRY_DELAY_MS * attempt);
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

async function sendViaZeptoMail({ from, to, subject, textBody, jobId }) {
  const safeText = textBody && textBody.trim() ? textBody : " ";

  const payload = {
    from: {
      address: from,
    },
    to: [
      {
        email_address: {
          address: to,
        },
      },
    ],
    subject: subject || "Support Reply",
    textbody: safeText,
    htmlbody: `<pre>${escapeHtml(safeText)}</pre>`,
  };

  for (let attempt = 1; attempt <= PROVIDER_RETRY_COUNT; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

    try {
      const res = await fetch(ZEPTO_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: ZEPTOMAIL_TOKEN,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const raw = await res.text();

      console.log(
        `[ZEPTO][${jobId}] Attempt ${attempt}/${PROVIDER_RETRY_COUNT} -> ${res.status} | ${from} -> ${to} | ${subject}`
      );

      if (!res.ok) {
        const err = new Error(`ZeptoMail error ${res.status}: ${raw}`);
        err.status = res.status;
        err.raw = raw;

        if (attempt < PROVIDER_RETRY_COUNT && shouldRetry(res.status, raw)) {
          await sleep(PROVIDER_RETRY_DELAY_MS * attempt);
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

async function enqueueSend(data) {
  const route = getRoute(data.to);

  const job = await queue.add(
    "send-email",
    {
      ...data,
      routeName: route.name,
      provider: route.provider,
    },
    {
      attempts: JOB_ATTEMPTS,
      backoff: {
        type: "exponential",
        delay: JOB_BACKOFF_MS,
      },
      removeOnComplete: 500,
      removeOnFail: 1000,
    }
  );

  console.log(
    `[QUEUE][${job.id}] Enqueued | route=${route.name} | provider=${route.provider}`
  );

  return job;
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
    references: parsed.references || [],
  };
}

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const payload = {
      ...job.data,
      jobId: job.id,
    };

    console.log(
      `[WORKER][${job.id}] Processing | route=${payload.routeName} | provider=${payload.provider} | attempt=${job.attemptsMade + 1}/${JOB_ATTEMPTS}`
    );

    await sendEmail(payload);

    console.log(`[WORKER][${job.id}] Sent`);
  },
  {
    connection: redisConnection.duplicate(),
    concurrency: WORKER_CONCURRENCY,
  }
);

worker.on("failed", (job, err) => {
  console.error(
    `[WORKER][${job?.id}] Failed | attemptsMade=${job?.attemptsMade} | ${err?.message || err}`
  );
});

worker.on("completed", (job) => {
  console.log(`[WORKER][${job.id}] Completed`);
});

queueEvents.on("failed", ({ jobId, failedReason }) => {
  console.error(`[QUEUE][${jobId}] Final failure | ${failedReason}`);
});

queueEvents.on("completed", ({ jobId }) => {
  console.log(`[QUEUE][${jobId}] Completed`);
});

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
      console.log(
        "[ROUTE]",
        route.name.toUpperCase(),
        "| provider =",
        route.provider,
        "| recipient =",
        to
      );
      console.log("[THREAD]", {
        messageId,
        inReplyTo,
        references: Array.isArray(references) ? references.join(" ") : references,
      });

      const job = await enqueueSend({
        from,
        to,
        subject,
        textBody: cleanedText,
        inReplyTo,
        references,
        messageId,
      });

      console.log(`[MAIL] Accepted and queued as job ${job.id}`);
      callback();
    } catch (err) {
      console.error("[MAIL] SMTP relay error:", err?.message || err);
      callback(err);
    }
  },
});

async function shutdown(signal) {
  console.log(`[SHUTDOWN] ${signal} received`);

  try {
    await server.close();
  } catch {}

  try {
    await worker.close();
  } catch {}

  try {
    await queueEvents.close();
  } catch {}

  try {
    await queue.close();
  } catch {}

  try {
    await redisConnection.quit();
  } catch {}

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(PORT, "0.0.0.0", () => {
  console.log("[BOOT] SMTP relay listening on port", PORT);
  console.log("[BOOT] WORKER_CONCURRENCY =", WORKER_CONCURRENCY);
  console.log("[BOOT] QUEUE_NAME =", QUEUE_NAME);
  console.log("[BOOT] ROUTE_RULES =", JSON.stringify(ROUTE_RULES));
});
