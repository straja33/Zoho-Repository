import net from "net";

if (process.env.TEST_SMTP === "true") {
  const socket = net.createConnection(587, "smtppro.zoho.eu");

  socket.setTimeout(5000);

  socket.on("connect", () => {
    console.log("SMTP CONNECTION SUCCESS");
    socket.end();
    process.exit(0);
  });

  socket.on("timeout", () => {
    console.log("SMTP CONNECTION TIMEOUT");
    process.exit(1);
  });

  socket.on("error", (err) => {
    console.log("SMTP CONNECTION ERROR:", err.message);
    process.exit(1);
  });
}
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

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

const ZOHO_SMTP_HOST = process.env.ZOHO_SMTP_HOST || "smtppro.zoho.eu";
const ZOHO_SMTP_PORT = Number(process.env.ZOHO_SMTP_PORT || 465);
const ZOHO_SMTP_USER = process.env.ZOHO_SMTP_USER;
const ZOHO_SMTP_PASS = process.env.ZOHO_SMTP_PASS;
const ZOHO_FROM_FALLBACK = process.env.ZOHO_FROM_FALLBACK || "";

const NL_FALLBACK_DOMAINS = [
  "ziggo.nl",
  "ziggo.com",
  "upcmail.nl",
  "chello.nl",
  "planet.nl"
];

if (!ZEPTOMAIL_TOKEN) throw new Error("Missing env var: ZEPTOMAIL_TOKEN");
if (!SMTP_USER || !SMTP_PASS) throw new Error("Missing env vars: SMTP_USER / SMTP_PASS");
if (!ZOHO_SMTP_USER || !ZOHO_SMTP_PASS) throw new Error("Missing env vars: ZOHO_SMTP_USER / ZOHO_SMTP_PASS");

const queue = [];
let activeSends = 0;
let jobIdCounter = 0;

const zohoTransport = nodemailer.createTransport({
  host: ZOHO_SMTP_HOST,
  port: 587,
  secure: false,
  auth: {
    user: ZOHO_SMTP_USER,
    pass: ZOHO_SMTP_PASS
  },
  requireTLS: true,
  connectionTimeout: SEND_TIMEOUT_MS,
  greetingTimeout: SEND_TIMEOUT_MS,
  socketTimeout: SEND_TIMEOUT_MS
});

function getDomain(email = "") {
  const parts = String(email).toLowerCase().trim().split("@");
  return parts.length === 2 ? parts[1] : "";
}

function isAllowedDomain(email = "") {
  if (ALLOWED_DOMAINS.length === 0) return true;
  return ALLOWED_DOMAINS.includes(getDomain(email));
}

function shouldUseZohoFallback(recipientEmail = "") {
  const domain = getDomain(recipientEmail);
  return NL_FALLBACK_DOMAINS.includes(domain);
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

async function sendViaZeptoMail({ from, to, subject, textBody, jobId }) {
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
          "Authorization": ZEPTOMAIL_TOKEN
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const raw = await res.text();

      console.log(`[ZEPTO][${jobId}] Attempt ${attempt}/${RETRY_COUNT} -> ${res.status} | ${from} -> ${to}`);

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

async function sendViaZohoMail({ from, to, subject, textBody, jobId }) {
  const safeText = textBody && textBody.trim() ? textBody : " ";
  const smtpFrom = ZOHO_FROM_FALLBACK || from;

  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    try {
      const info = await zohoTransport.sendMail({
        from: smtpFrom,
        to,
        subject: subject || "Support Reply",
        text: safeText,
        html: `<pre>${escapeHtml(safeText)}</pre>`
      });

      console.log(`[ZOHO][${jobId}] Attempt ${attempt}/${RETRY_COUNT} -> OK | ${smtpFrom} -> ${to} | ${info.messageId || "no-message-id"}`);
      return info;
    } catch (err) {
      const msg = err?.message || String(err);
      console.warn(`[ZOHO][${jobId}] Attempt ${attempt}/${RETRY_COUNT} failed: ${msg}`);

      if (attempt < RETRY_COUNT && shouldRetry(0, msg)) {
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }

      throw err;
    }
  }
}

async function sendEmail(job) {
  if (shouldUseZohoFallback(job.to)) {
    return sendViaZohoMail(job);
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
    queue.push({ id, data: { ...data, jobId: id }, resolve, reject });
    console.log(`[QUEUE][${id}] Enqueued | route=${shouldUseZohoFallback(data.to) ? "zoho" : "zepto"} | active=${activeSends} queued=${queue.length}`);
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
    htmlLength: typeof parsed.html === "string" ? parsed.html.length : 0
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

      if (!from) throw new Error("Missing FROM address");
      if (!to) throw new Error("Missing TO address");

      if (!isAllowedDomain(from)) {
        throw new Error(`Blocked sender domain: ${from}`);
      }

      const rawText = parsed.text || "";
      const cleanedText = cleanText(rawText);

      console.log("[CLEAN] text before/after:", rawText.length, "->", cleanedText.length);
      console.log("[ROUTE]", shouldUseZohoFallback(to) ? "ZOHO SMTP fallback" : "ZEPTOMAIL API", "| recipient =", to);

      await enqueueSend({
        from,
        to,
        subject,
        textBody: cleanedText
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
  console.log("[BOOT] ZOHO SMTP HOST =", ZOHO_SMTP_HOST);
  console.log("[BOOT] NL fallback domains =", NL_FALLBACK_DOMAINS.join(", "));
});
