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

if (!ZEPTOMAIL_TOKEN) throw new Error("Missing env var: ZEPTOMAIL_TOKEN");
if (!SMTP_USER || !SMTP_PASS) throw new Error("Missing env vars: SMTP_USER / SMTP_PASS");

const queue = [];
let activeSends = 0;
let jobIdCounter = 0;

function getDomain(email = "") {
  const parts = String(email).toLowerCase().trim().split("@");
  return parts.length === 2 ? parts[1] : "";
}

function isAllowedDomain(email = "") {
  if (ALLOWED_DOMAINS.length === 0) return true;
  return ALLOWED_DOMAINS.includes(getDomain(email));
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

  const quoteMarkers = [
    /^--$/,
    /^On .+ wrote:$/i,
    /^Am .+ schrieb .+:?$/i,
    /^[- ]*Original Message[- ]*$/i,
    /^From:\s.+$/i,
    /^Sent:\s.+$/i,
    /^To:\s.+$/i,
    /^Subject:\s.+$/i,
  ];

  const marketingMarkers = [
    /ctrk\.klclick\.com/i,
    /unsubscribe/i,
    /manage preferences/i,
    /view in browser/i,
    /newsletter/i,
  ];

  let cutIndex = lines.length;
  let marketingHits = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (quoteMarkers.some((rx) => rx.test(line))) {
      cutIndex = i;
      break;
    }

    if (marketingMarkers.some((rx) => rx.test(line))) {
      marketingHits++;
      if (marketingHits >= 2) {
        cutIndex = i;
        break;
      }
    }
  }

  return lines.slice(0, cutIndex).join("\n").trim();
}

function cleanHtml(html = "") {
  let out = String(html || "");

  const patterns = [
    /<div[^>]*>\s*On .*?wrote:.*$/is,
    /<div[^>]*>\s*Am .*?schrieb.*$/is,
    /-----Original Message-----.*$/is,
    /ctrk\.klclick\.com.*$/is,
    /unsubscribe.*$/is,
    /manage preferences.*$/is,
    /view in browser.*$/is,
  ];

  for (const pattern of patterns) {
    out = out.replace(pattern, "");
  }

  return out.trim();
}

async function sendToZeptoMail({ from, to, subject, textBody, htmlBody, jobId }) {
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
    textbody: textBody && textBody.trim() ? textBody : " ",
    htmlbody: htmlBody && htmlBody.trim()
      ? htmlBody
      : `<pre>${escapeHtml(textBody || " ")}</pre>`
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

      console.log(`[ZEPTO][${jobId}] Attempt ${attempt}/${RETRY_COUNT} -> ${res.status} | ${from} -> ${to} | ${subject}`);

      if (!res.ok) {
        const err = new Error(`ZeptoMail error ${res.status}: ${raw}`);
        err.status = res.status;
        err.raw = raw;

        if (attempt < RETRY_COUNT && shouldRetry(res.status, raw)) {
          console.warn(`[ZEPTO][${jobId}] Retrying after status ${res.status}`);
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }

        throw err;
      }

      return raw;
    } catch (err) {
      const msg = err?.message || String(err);
      const status = err?.status || 0;

      if (attempt < RETRY_COUNT && shouldRetry(status, msg)) {
        console.warn(`[ZEPTO][${jobId}] Retry ${attempt}/${RETRY_COUNT} after error: ${msg}`);
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }

      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function processQueue() {
  while (activeSends < MAX_CONCURRENT_SENDS && queue.length > 0) {
    const job = queue.shift();
    activeSends++;

    (async () => {
      try {
        await sendToZeptoMail(job.data);
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
    console.log(`[QUEUE][${id}] Enqueued | active=${activeSends} queued=${queue.length}`);
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

      const cleanedText = cleanText(parsed.text || "");
      const cleanedHtml = cleanHtml(typeof parsed.html === "string" ? parsed.html : "");

      await enqueueSend({
        from,
        to,
        subject,
        textBody: cleanedText,
        htmlBody: cleanedHtml
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
  console.log("[BOOT] SEND_TIMEOUT_MS =", SEND_TIMEOUT_MS);
  console.log("[BOOT] RETRY_COUNT =", RETRY_COUNT);
});
