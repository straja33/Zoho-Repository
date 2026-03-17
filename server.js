// server.js

import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { Queue, Worker, QueueEvents } from "bullmq";
import IORedis from "ioredis";
import http from "http";

const PORT = Number(process.env.PORT || 2525);
const MONITOR_PORT = Number(process.env.MONITOR_PORT || 8080);

const REDIS_URL = process.env.REDIS_URL;

const ZEPTO_QUEUE_NAME = process.env.ZEPTO_QUEUE_NAME || "smtp-relay-zepto";
const ZOHO_QUEUE_NAME = process.env.ZOHO_QUEUE_NAME || "smtp-relay-zoho";

const ZEPTO_API_URL =
  process.env.ZEPTO_API_URL || "https://api.zeptomail.com/v1.1/email";
const ZEPTO_FILES_API_URL =
  process.env.ZEPTO_FILES_API_URL || "https://api.zeptomail.com/v1.1/files";
const ZEPTOMAIL_TOKEN = process.env.ZEPTOMAIL_TOKEN;

const FROM_FALLBACK = process.env.FROM_FALLBACK || "";
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

const ZEPTO_CONCURRENCY = Number(process.env.ZEPTO_CONCURRENCY || 15);
const ZOHO_CONCURRENCY = Number(process.env.ZOHO_CONCURRENCY || 5);

const SEND_TIMEOUT_MS = Number(process.env.SEND_TIMEOUT_MS || 20000);

const JOB_ATTEMPTS = Number(process.env.JOB_ATTEMPTS || 6);
const JOB_BACKOFF_MS = Number(process.env.JOB_BACKOFF_MS || 15000);

const PROVIDER_RETRY_COUNT = Number(process.env.PROVIDER_RETRY_COUNT || 2);
const PROVIDER_RETRY_DELAY_MS = Number(
  process.env.PROVIDER_RETRY_DELAY_MS || 2000
);

const BREAKER_FAILURE_THRESHOLD = Number(
  process.env.BREAKER_FAILURE_THRESHOLD || 5
);
const BREAKER_WINDOW_MS = Number(process.env.BREAKER_WINDOW_MS || 60000);
const BREAKER_OPEN_MS = Number(process.env.BREAKER_OPEN_MS || 120000);

const RECENT_EMAILS_KEY = process.env.RECENT_EMAILS_KEY || "smtp-relay:recent";
const RECENT_EMAILS_LIMIT = Number(process.env.RECENT_EMAILS_LIMIT || 50);

const MAX_ATTACHMENT_BYTES = Number(
  process.env.MAX_ATTACHMENT_BYTES || 10 * 1024 * 1024
);
const MAX_TOTAL_ATTACHMENTS_BYTES = Number(
  process.env.MAX_TOTAL_ATTACHMENTS_BYTES || 20 * 1024 * 1024
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

const zeptoQueue = new Queue(ZEPTO_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: JOB_ATTEMPTS,
    backoff: {
      type: "exponential",
      delay: JOB_BACKOFF_MS,
    },
    removeOnComplete: 1000,
    removeOnFail: 2000,
  },
});

const zohoQueue = new Queue(ZOHO_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: JOB_ATTEMPTS,
    backoff: {
      type: "exponential",
      delay: JOB_BACKOFF_MS,
    },
    removeOnComplete: 1000,
    removeOnFail: 2000,
  },
});

const zeptoQueueEvents = new QueueEvents(ZEPTO_QUEUE_NAME, {
  connection: redisConnection.duplicate(),
});

const zohoQueueEvents = new QueueEvents(ZOHO_QUEUE_NAME, {
  connection: redisConnection.duplicate(),
});

const metrics = {
  accepted: 0,
  rejected: 0,
  enqueued: {
    zepto: 0,
    zoho: 0,
  },
  completed: {
    zepto: 0,
    zoho: 0,
  },
  failed: {
    zepto: 0,
    zoho: 0,
  },
  providerRetries: {
    zepto: 0,
    zoho: 0,
  },
  smtpErrors: 0,
  attachmentJobs: 0,
  attachmentFilesSent: 0,
  attachmentBytesSent: 0,
  lastAcceptedAt: null,
  lastSentAt: {
    zepto: null,
    zoho: null,
  },
  lastFailureAt: {
    zepto: null,
    zoho: null,
  },
};

const circuitBreakers = {
  zepto: {
    state: "CLOSED",
    openedUntil: 0,
    halfOpenInFlight: false,
    failures: [],
  },
  zoho: {
    state: "CLOSED",
    openedUntil: 0,
    halfOpenInFlight: false,
    failures: [],
  },
};

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

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function shouldRetry(status, message = "") {
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  return /timeout|network|fetch failed|socket hang up|temporar|circuit open/i.test(
    String(message).toLowerCase()
  );
}

function isBreakerFailure(status, message = "") {
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  return /timeout|network|fetch failed|socket hang up|temporar/i.test(
    String(message).toLowerCase()
  );
}

function getBreaker(provider) {
  return circuitBreakers[provider];
}

function normalizeBreaker(provider) {
  const breaker = getBreaker(provider);
  const now = Date.now();

  breaker.failures = breaker.failures.filter(
    (ts) => now - ts <= BREAKER_WINDOW_MS
  );

  if (breaker.state === "OPEN" && now >= breaker.openedUntil) {
    breaker.state = "HALF_OPEN";
    breaker.halfOpenInFlight = false;
  }

  return breaker;
}

function beforeProviderSend(provider) {
  const breaker = normalizeBreaker(provider);

  if (breaker.state === "OPEN") {
    const remainingMs = Math.max(0, breaker.openedUntil - Date.now());
    const err = new Error(
      `Circuit open for provider=${provider}. Retry after ${remainingMs}ms`
    );
    err.status = 503;
    err.retryable = true;
    throw err;
  }

  if (breaker.state === "HALF_OPEN") {
    if (breaker.halfOpenInFlight) {
      const err = new Error(
        `Circuit half-open for provider=${provider}. Test request already in flight`
      );
      err.status = 503;
      err.retryable = true;
      throw err;
    }

    breaker.halfOpenInFlight = true;
  }
}

function onProviderSuccess(provider) {
  const breaker = normalizeBreaker(provider);

  if (breaker.state === "HALF_OPEN") {
    console.log(`[BREAKER][${provider}] HALF_OPEN -> CLOSED`);
  }

  breaker.state = "CLOSED";
  breaker.failures = [];
  breaker.openedUntil = 0;
  breaker.halfOpenInFlight = false;
}

function onProviderFailure(provider, status, message = "") {
  const breaker = normalizeBreaker(provider);
  const now = Date.now();

  if (breaker.state === "HALF_OPEN") {
    breaker.state = "OPEN";
    breaker.openedUntil = now + BREAKER_OPEN_MS;
    breaker.halfOpenInFlight = false;
    breaker.failures = [now];
    console.log(
      `[BREAKER][${provider}] HALF_OPEN -> OPEN for ${BREAKER_OPEN_MS}ms`
    );
    return;
  }

  if (!isBreakerFailure(status, message)) {
    return;
  }

  breaker.failures.push(now);
  breaker.failures = breaker.failures.filter(
    (ts) => now - ts <= BREAKER_WINDOW_MS
  );

  if (
    breaker.state === "CLOSED" &&
    breaker.failures.length >= BREAKER_FAILURE_THRESHOLD
  ) {
    breaker.state = "OPEN";
    breaker.openedUntil = now + BREAKER_OPEN_MS;
    breaker.halfOpenInFlight = false;

    console.log(
      `[BREAKER][${provider}] CLOSED -> OPEN | failures=${breaker.failures.length} | openMs=${BREAKER_OPEN_MS}`
    );
  }
}

function maskEmail(email = "") {
  const [local = "", domain = ""] = String(email).split("@");
  if (!domain) return email;

  if (local.length <= 2) return `${local[0] || "*"}***@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

function trimSubject(subject = "", max = 160) {
  const s = String(subject || "");
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function safeString(value = "", max = 300) {
  const s = String(value || "");
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function sanitizeFilename(name = "") {
  return String(name || "attachment")
    .replace(/[^\w.\-() ]+/g, "_")
    .slice(0, 180);
}

function normalizeAttachmentContentType(type = "") {
  const t = String(type || "").trim();
  return t || "application/octet-stream";
}

function estimateBase64Bytes(base64 = "") {
  return Math.floor((String(base64 || "").length * 3) / 4);
}

function serializeAttachments(parsedAttachments = []) {
  return parsedAttachments.map((att, index) => {
    const filename = sanitizeFilename(att.filename || `attachment-${index + 1}`);
    const contentBase64 = Buffer.isBuffer(att.content)
      ? att.content.toString("base64")
      : Buffer.from(att.content || "").toString("base64");

    return {
      filename,
      contentType: normalizeAttachmentContentType(att.contentType),
      contentDisposition: att.contentDisposition || "attachment",
      contentId: att.contentId || "",
      size: Number(att.size || estimateBase64Bytes(contentBase64)),
      contentBase64,
    };
  });
}

function validateAttachments(attachments = []) {
  let total = 0;

  for (const att of attachments) {
    const size = Number(att.size || estimateBase64Bytes(att.contentBase64));
    total += size;

    if (size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachment too large: ${att.filename} (${size} bytes > ${MAX_ATTACHMENT_BYTES})`
      );
    }
  }

  if (total > MAX_TOTAL_ATTACHMENTS_BYTES) {
    throw new Error(
      `Total attachment size too large: ${total} bytes > ${MAX_TOTAL_ATTACHMENTS_BYTES}`
    );
  }

  return total;
}

function summarizeAttachments(attachments = []) {
  return attachments.map((att) => ({
    filename: att.filename,
    contentType: att.contentType,
    size: att.size,
    inline: att.contentDisposition === "inline",
  }));
}

async function addRecentEvent(event) {
  const payload = JSON.stringify({
    ...event,
    timestamp: event.timestamp || new Date().toISOString(),
  });

  await redisConnection
    .multi()
    .lpush(RECENT_EMAILS_KEY, payload)
    .ltrim(RECENT_EMAILS_KEY, 0, RECENT_EMAILS_LIMIT - 1)
    .exec();
}

async function getRecentEvents(limit = RECENT_EMAILS_LIMIT) {
  const rows = await redisConnection.lrange(
    RECENT_EMAILS_KEY,
    0,
    Math.max(0, limit - 1)
  );

  return rows.map((row) => {
    try {
      return JSON.parse(row);
    } catch {
      return { raw: row };
    }
  });
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

async function uploadZohoAttachment(accessToken, attachment) {
  const fileName = encodeURIComponent(attachment.filename || "attachment");
  const url = `https://mail.zoho.eu/api/accounts/${ZOHO_ACCOUNT_ID}/messages/attachments?fileName=${fileName}&isInline=${
    attachment.contentDisposition === "inline" ? "true" : "false"
  }`;

  const binary = Buffer.from(attachment.contentBase64, "base64");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": attachment.contentType || "application/octet-stream",
      Accept: "application/json",
    },
    body: binary,
  });

  const raw = await res.text();

  if (!res.ok) {
    throw new Error(
      `Zoho attachment upload error ${res.status} (${attachment.filename}): ${raw}`
    );
  }

  const data = JSON.parse(raw);
  const item = Array.isArray(data.data) ? data.data[0] : null;

  if (!item?.attachmentName || !item?.attachmentPath || !item?.storeName) {
    throw new Error(
      `Zoho attachment upload missing fields (${attachment.filename}): ${raw}`
    );
  }

  return {
    attachmentName: item.attachmentName,
    attachmentPath: item.attachmentPath,
    storeName: item.storeName,
  };
}

async function sendViaZeptoMail({
  from,
  to,
  subject,
  textBody,
  htmlBody,
  attachments = [],
  jobId,
  provider = "zepto",
}) {
  const safeText = textBody && textBody.trim() ? textBody : " ";
  const safeHtml =
    htmlBody && htmlBody.trim() ? htmlBody : `<pre>${escapeHtml(safeText)}</pre>`;

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
    htmlbody: safeHtml,
  };

  if (attachments.length > 0) {
    payload.attachments = attachments.map((att) => ({
      name: att.filename,
      mime_type: att.contentType,
      content: att.contentBase64,
    }));
  }

  for (let attempt = 1; attempt <= PROVIDER_RETRY_COUNT; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

    try {
      beforeProviderSend(provider);

      const res = await fetch(ZEPTO_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: ZEPTOMAIL_TOKEN,
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const raw = await res.text();

      console.log(
        `[ZEPTO][${jobId}] Attempt ${attempt}/${PROVIDER_RETRY_COUNT} -> ${res.status} | attachments=${attachments.length} | ${from} -> ${to} | ${subject}`
      );

      if (!res.ok) {
        onProviderFailure(provider, res.status, raw);

        const err = new Error(`ZeptoMail error ${res.status}: ${raw}`);
        err.status = res.status;
        err.raw = raw;
        err.retryable = shouldRetry(res.status, raw);

        if (attempt < PROVIDER_RETRY_COUNT && err.retryable) {
          metrics.providerRetries.zepto++;
          await sleep(PROVIDER_RETRY_DELAY_MS * attempt);
          continue;
        }

        throw err;
      }

      onProviderSuccess(provider);
      return raw;
    } catch (err) {
      const status = err?.status || 503;
      const message = err?.message || String(err);

      if (!/ZeptoMail error/.test(message)) {
        onProviderFailure(provider, status, message);
      }

      const retryable =
        err?.retryable === true || shouldRetry(status, message);

      if (attempt < PROVIDER_RETRY_COUNT && retryable) {
        metrics.providerRetries.zepto++;
        await sleep(PROVIDER_RETRY_DELAY_MS * attempt);
        continue;
      }

      throw err;
    } finally {
      clearTimeout(timeout);
      const breaker = getBreaker(provider);
      if (breaker.state !== "HALF_OPEN") {
        breaker.halfOpenInFlight = false;
      }
    }
  }
}

async function sendViaZohoMailApi({
  from,
  to,
  subject,
  textBody,
  htmlBody,
  attachments = [],
  jobId,
  inReplyTo,
  references,
  provider = "zoho",
}) {
  const safeText = textBody && textBody.trim() ? textBody : " ";
  const route = getRoute(to);
  const actualFrom = route.fromAddress || from;

  for (let attempt = 1; attempt <= PROVIDER_RETRY_COUNT; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

    try {
      beforeProviderSend(provider);

      const accessToken = await getZohoAccessToken();
      let uploadedAttachments = [];

      if (attachments.length > 0) {
        for (const attachment of attachments) {
          uploadedAttachments.push(
            await uploadZohoAttachment(accessToken, attachment)
          );
        }
      }

      const payload = {
        fromAddress: actualFrom,
        toAddress: to,
        subject: subject || "Support Reply",
        content:
          htmlBody && htmlBody.trim() ? htmlBody : safeText,
        mailFormat:
          htmlBody && htmlBody.trim() ? "html" : "plaintext",
      };

      if (inReplyTo) payload.inReplyTo = inReplyTo;
      if (references) {
        payload.refHeader = Array.isArray(references)
          ? references.join(" ")
          : references;
      }
      if (uploadedAttachments.length > 0) {
        payload.attachments = uploadedAttachments;
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
        `[ZOHO-API][${jobId}] Attempt ${attempt}/${PROVIDER_RETRY_COUNT} -> ${res.status} | route=${route.name} | attachments=${attachments.length} | ${actualFrom} -> ${to} | ${subject}`
      );

      if (!res.ok) {
        if (res.status === 401 || res.status === 400) {
          zohoAccessToken = null;
          zohoTokenExpiry = 0;
        }

        onProviderFailure(provider, res.status, raw);

        const err = new Error(`Zoho Mail API error ${res.status}: ${raw}`);
        err.status = res.status;
        err.raw = raw;
        err.retryable = shouldRetry(res.status, raw);

        if (attempt < PROVIDER_RETRY_COUNT && err.retryable) {
          metrics.providerRetries.zoho++;
          await sleep(PROVIDER_RETRY_DELAY_MS * attempt);
          continue;
        }

        throw err;
      }

      onProviderSuccess(provider);
      return raw;
    } catch (err) {
      const status = err?.status || 503;
      const message = err?.message || String(err);

      if (!/Zoho Mail API error/.test(message)) {
        onProviderFailure(provider, status, message);
      }

      const retryable =
        err?.retryable === true || shouldRetry(status, message);

      if (attempt < PROVIDER_RETRY_COUNT && retryable) {
        metrics.providerRetries.zoho++;
        await sleep(PROVIDER_RETRY_DELAY_MS * attempt);
        continue;
      }

      throw err;
    } finally {
      clearTimeout(timeout);
      const breaker = getBreaker(provider);
      if (breaker.state !== "HALF_OPEN") {
        breaker.halfOpenInFlight = false;
      }
    }
  }
}

async function enqueueSend(data) {
  const route = getRoute(data.to);
  const provider = route.provider === "zoho" ? "zoho" : "zepto";
  const queue = provider === "zoho" ? zohoQueue : zeptoQueue;
  const attachmentCount = Array.isArray(data.attachments)
    ? data.attachments.length
    : 0;

  const job = await queue.add("send-email", {
    ...data,
    routeName: route.name,
    provider,
  });

  metrics.enqueued[provider]++;

  await addRecentEvent({
    stage: "queued",
    provider,
    routeName: route.name,
    jobId: String(job.id),
    from: maskEmail(data.from),
    to: maskEmail(data.to),
    subject: trimSubject(data.subject),
    status: "queued",
    attachmentCount,
  });

  console.log(
    `[QUEUE][${provider.toUpperCase()}][${job.id}] Enqueued | route=${route.name} | attachments=${attachmentCount} | ${data.from} -> ${data.to}`
  );

  return { job, provider, routeName: route.name };
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
    attachmentCount: Array.isArray(parsed.attachments)
      ? parsed.attachments.length
      : 0,
  };
}

async function getOldestWaitingAgeMs(queue) {
  const jobs = await queue.getJobs(["waiting", "delayed"], 0, 0, true);

  if (!jobs || jobs.length === 0) return 0;

  const oldest = jobs[0];
  const timestamp = oldest?.timestamp || Date.now();
  return Math.max(0, Date.now() - timestamp);
}

async function getQueueSnapshot() {
  const [
    zeptoCounts,
    zohoCounts,
    zeptoOldestAgeMs,
    zohoOldestAgeMs,
  ] = await Promise.all([
    zeptoQueue.getJobCounts(
      "waiting",
      "active",
      "completed",
      "failed",
      "delayed",
      "paused"
    ),
    zohoQueue.getJobCounts(
      "waiting",
      "active",
      "completed",
      "failed",
      "delayed",
      "paused"
    ),
    getOldestWaitingAgeMs(zeptoQueue),
    getOldestWaitingAgeMs(zohoQueue),
  ]);

  return {
    zepto: {
      ...zeptoCounts,
      oldestWaitingAgeMs: zeptoOldestAgeMs,
      concurrency: ZEPTO_CONCURRENCY,
      breaker: {
        ...normalizeBreaker("zepto"),
      },
    },
    zoho: {
      ...zohoCounts,
      oldestWaitingAgeMs: zohoOldestAgeMs,
      concurrency: ZOHO_CONCURRENCY,
      breaker: {
        ...normalizeBreaker("zoho"),
      },
    },
  };
}

const zeptoWorker = new Worker(
  ZEPTO_QUEUE_NAME,
  async (job) => {
    const payload = {
      ...job.data,
      jobId: job.id,
      provider: "zepto",
    };

    console.log(
      `[WORKER][ZEPTO][${job.id}] Processing | attempt=${job.attemptsMade + 1}/${JOB_ATTEMPTS}`
    );

    await sendViaZeptoMail(payload);

    metrics.completed.zepto++;
    metrics.lastSentAt.zepto = new Date().toISOString();

    if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
      metrics.attachmentJobs++;
      metrics.attachmentFilesSent += payload.attachments.length;
      metrics.attachmentBytesSent += payload.attachments.reduce(
        (sum, att) => sum + Number(att.size || 0),
        0
      );
    }

    await addRecentEvent({
      stage: "sent",
      provider: "zepto",
      routeName: payload.routeName || "zepto-default",
      jobId: String(job.id),
      from: maskEmail(payload.from),
      to: maskEmail(payload.to),
      subject: trimSubject(payload.subject),
      status: "sent",
      attachmentCount: Array.isArray(payload.attachments)
        ? payload.attachments.length
        : 0,
    });

    console.log(`[WORKER][ZEPTO][${job.id}] Sent`);
  },
  {
    connection: redisConnection.duplicate(),
    concurrency: ZEPTO_CONCURRENCY,
  }
);

const zohoWorker = new Worker(
  ZOHO_QUEUE_NAME,
  async (job) => {
    const payload = {
      ...job.data,
      jobId: job.id,
      provider: "zoho",
    };

    console.log(
      `[WORKER][ZOHO][${job.id}] Processing | attempt=${job.attemptsMade + 1}/${JOB_ATTEMPTS}`
    );

    await sendViaZohoMailApi(payload);

    metrics.completed.zoho++;
    metrics.lastSentAt.zoho = new Date().toISOString();

    if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
      metrics.attachmentJobs++;
      metrics.attachmentFilesSent += payload.attachments.length;
      metrics.attachmentBytesSent += payload.attachments.reduce(
        (sum, att) => sum + Number(att.size || 0),
        0
      );
    }

    await addRecentEvent({
      stage: "sent",
      provider: "zoho",
      routeName: payload.routeName || "zoho",
      jobId: String(job.id),
      from: maskEmail(payload.from),
      to: maskEmail(payload.to),
      subject: trimSubject(payload.subject),
      status: "sent",
      attachmentCount: Array.isArray(payload.attachments)
        ? payload.attachments.length
        : 0,
    });

    console.log(`[WORKER][ZOHO][${job.id}] Sent`);
  },
  {
    connection: redisConnection.duplicate(),
    concurrency: ZOHO_CONCURRENCY,
  }
);

zeptoWorker.on("failed", async (job, err) => {
  metrics.failed.zepto++;
  metrics.lastFailureAt.zepto = new Date().toISOString();

  await addRecentEvent({
    stage: "failed",
    provider: "zepto",
    routeName: job?.data?.routeName || "zepto-default",
    jobId: String(job?.id || ""),
    from: maskEmail(job?.data?.from || ""),
    to: maskEmail(job?.data?.to || ""),
    subject: trimSubject(job?.data?.subject || ""),
    status: "failed",
    error: safeString(err?.message || String(err)),
    attemptsMade: job?.attemptsMade ?? null,
    attachmentCount: Array.isArray(job?.data?.attachments)
      ? job.data.attachments.length
      : 0,
  });

  console.error(
    `[WORKER][ZEPTO][${job?.id}] Failed | attemptsMade=${job?.attemptsMade} | ${err?.message || err}`
  );
});

zohoWorker.on("failed", async (job, err) => {
  metrics.failed.zoho++;
  metrics.lastFailureAt.zoho = new Date().toISOString();

  await addRecentEvent({
    stage: "failed",
    provider: "zoho",
    routeName: job?.data?.routeName || "zoho",
    jobId: String(job?.id || ""),
    from: maskEmail(job?.data?.from || ""),
    to: maskEmail(job?.data?.to || ""),
    subject: trimSubject(job?.data?.subject || ""),
    status: "failed",
    error: safeString(err?.message || String(err)),
    attemptsMade: job?.attemptsMade ?? null,
    attachmentCount: Array.isArray(job?.data?.attachments)
      ? job.data.attachments.length
      : 0,
  });

  console.error(
    `[WORKER][ZOHO][${job?.id}] Failed | attemptsMade=${job?.attemptsMade} | ${err?.message || err}`
  );
});

zeptoQueueEvents.on("failed", ({ jobId, failedReason }) => {
  console.error(`[QUEUE][ZEPTO][${jobId}] Final failure | ${failedReason}`);
});

zohoQueueEvents.on("failed", ({ jobId, failedReason }) => {
  console.error(`[QUEUE][ZOHO][${jobId}] Final failure | ${failedReason}`);
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

      const rawHtml =
        typeof parsed.html === "string"
          ? parsed.html
          : cleanedText
          ? `<pre>${escapeHtml(cleanedText)}</pre>`
          : "";

      const attachments = serializeAttachments(parsed.attachments || []);
      const totalAttachmentBytes = validateAttachments(attachments);
      const route = getRoute(to);

      console.log(
        "[CLEAN] text before/after:",
        rawText.length,
        "->",
        cleanedText.length
      );
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
      console.log("[ATTACHMENTS]", {
        count: attachments.length,
        totalBytes: totalAttachmentBytes,
        items: summarizeAttachments(attachments),
      });

      const { job, provider } = await enqueueSend({
        from,
        to,
        subject,
        textBody: cleanedText,
        htmlBody: rawHtml,
        inReplyTo,
        references,
        messageId,
        attachments,
      });

      metrics.accepted++;
      metrics.lastAcceptedAt = new Date().toISOString();

      console.log(
        `[MAIL] Accepted and queued as ${provider.toUpperCase()} job ${job.id}`
      );

      callback();
    } catch (err) {
      metrics.rejected++;
      metrics.smtpErrors++;

      console.error("[MAIL] SMTP relay error:", err?.message || err);
      callback(err);
    }
  },
});

const monitorServer = http.createServer(async (req, res) => {
  try {
    const url = req.url || "/";

    if (url === "/health") {
      const snapshot = await getQueueSnapshot();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          {
            ok: true,
            uptimeSec: Math.round(process.uptime()),
            queues: snapshot,
            lastAcceptedAt: metrics.lastAcceptedAt,
            lastSentAt: metrics.lastSentAt,
          },
          null,
          2
        )
      );
      return;
    }

    if (url === "/queue") {
      const snapshot = await getQueueSnapshot();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(snapshot, null, 2));
      return;
    }

    if (url === "/metrics") {
      const snapshot = await getQueueSnapshot();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          {
            uptimeSec: Math.round(process.uptime()),
            metrics,
            queues: snapshot,
            routeRules: ROUTE_RULES,
          },
          null,
          2
        )
      );
      return;
    }

    if (url === "/recent") {
      const recent = await getRecentEvents();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          {
            count: recent.length,
            limit: RECENT_EMAILS_LIMIT,
            items: recent,
          },
          null,
          2
        )
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: err?.message || String(err),
      })
    );
  }
});

async function shutdown(signal) {
  console.log(`[SHUTDOWN] ${signal} received`);

  try {
    server.close();
  } catch {}

  try {
    monitorServer.close();
  } catch {}

  try {
    await zeptoWorker.close();
  } catch {}

  try {
    await zohoWorker.close();
  } catch {}

  try {
    await zeptoQueueEvents.close();
  } catch {}

  try {
    await zohoQueueEvents.close();
  } catch {}

  try {
    await zeptoQueue.close();
  } catch {}

  try {
    await zohoQueue.close();
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
  console.log("[BOOT] MONITOR_PORT =", MONITOR_PORT);
  console.log("[BOOT] ZEPTO_QUEUE_NAME =", ZEPTO_QUEUE_NAME);
  console.log("[BOOT] ZOHO_QUEUE_NAME =", ZOHO_QUEUE_NAME);
  console.log("[BOOT] ZEPTO_CONCURRENCY =", ZEPTO_CONCURRENCY);
  console.log("[BOOT] ZOHO_CONCURRENCY =", ZOHO_CONCURRENCY);
  console.log("[BOOT] BREAKER_FAILURE_THRESHOLD =", BREAKER_FAILURE_THRESHOLD);
  console.log("[BOOT] BREAKER_WINDOW_MS =", BREAKER_WINDOW_MS);
  console.log("[BOOT] BREAKER_OPEN_MS =", BREAKER_OPEN_MS);
  console.log("[BOOT] RECENT_EMAILS_LIMIT =", RECENT_EMAILS_LIMIT);
  console.log("[BOOT] MAX_ATTACHMENT_BYTES =", MAX_ATTACHMENT_BYTES);
  console.log(
    "[BOOT] MAX_TOTAL_ATTACHMENTS_BYTES =",
    MAX_TOTAL_ATTACHMENTS_BYTES
  );
  console.log("[BOOT] ROUTE_RULES =", JSON.stringify(ROUTE_RULES));
});

monitorServer.listen(MONITOR_PORT, "0.0.0.0", () => {
  console.log("[BOOT] Monitor server listening on port", MONITOR_PORT);
  console.log("[BOOT] Health endpoints: /health /queue /metrics /recent");
});
