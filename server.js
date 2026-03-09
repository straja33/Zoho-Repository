import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";

const PORT = Number(process.env.PORT || 2525);
const ZEPTOMAIL_TOKEN = process.env.ZEPTOMAIL_TOKEN;
const FROM_FALLBACK = process.env.FROM_FALLBACK || "";
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const ZEPTO_API_URL = process.env.ZEPTO_API_URL || "https://api.zeptomail.eu/v1.1/email";

const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || "")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

if (!ZEPTOMAIL_TOKEN) {
  throw new Error("Missing env var: ZEPTOMAIL_TOKEN");
}

if (!SMTP_USER || !SMTP_PASS) {
  throw new Error("Missing env vars: SMTP_USER / SMTP_PASS");
}

if (!FROM_FALLBACK) {
  console.warn("[BOOT] FROM_FALLBACK is empty. This is allowed, but not recommended.");
}

if (ALLOWED_DOMAINS.length === 0) {
  console.warn("[BOOT] ALLOWED_DOMAINS is empty. Domain protection is disabled.");
}

function maskToken(token = "") {
  if (!token) return "";
  if (token.length <= 10) return "***";
  return `${token.slice(0, 6)}***${token.slice(-4)}`;
}

function getDomain(email = "") {
  const parts = String(email).toLowerCase().trim().split("@");
  return parts.length === 2 ? parts[1] : "";
}

function isAllowedDomain(email = "") {
  if (ALLOWED_DOMAINS.length === 0) return true;
  const domain = getDomain(email);
  return ALLOWED_DOMAINS.includes(domain);
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function cleanText(text = "") {
  if (!text) return "";

  const lines = String(text).split(/\r?\n/);

  const quoteMarkers = [
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
      marketingHits += 1;
      if (marketingHits >= 2) {
        cutIndex = i;
        break;
      }
    }
  }

  return lines.slice(0, cutIndex).join("\n").trim();
}

function cleanHtml(html = "") {
  if (!html) return "";

  let out = String(html);

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

function summarizeMail(parsed) {
  return {
    subject: parsed.subject || "",
    from: parsed.from?.value?.map((x) => x.address) || [],
    to: parsed.to?.value?.map((x) => x.address) || [],
    cc: parsed.cc?.value?.map((x) => x.address) || [],
    replyTo: parsed.replyTo?.value?.map((x) => x.address) || [],
    hasText: !!parsed.text,
    hasHtml: !!parsed.html,
    textLength: parsed.text ? parsed.text.length : 0,
    htmlLength: typeof parsed.html === "string" ? parsed.html.length : 0,
    attachments: parsed.attachments?.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
    })) || [],
  };
}

async function sendToZeptoMail({ from, to, subject, textBody, htmlBody }) {
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
    textbody: textBody && textBody.trim() ? textBody : " ",
    htmlbody: htmlBody && htmlBody.trim()
      ? htmlBody
      : `<pre>${escapeHtml(textBody && textBody.trim() ? textBody : " ")}</pre>`,
  };

  console.log("[ZEPTO] URL:", ZEPTO_API_URL);
  console.log("[ZEPTO] Payload:", JSON.stringify(payload, null, 2));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(ZEPTO_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Zoho-enczapikey ${ZEPTOMAIL_TOKEN}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const body = await res.text();

    console.log("[ZEPTO] Status:", res.status);
    console.log("[ZEPTO] Response:", body);

    if (!res.ok) {
      throw new Error(`ZeptoMail error ${res.status}: ${body}`);
    }

    return body;
  } finally {
    clearTimeout(timeout);
  }
}

const server = new SMTPServer({
  secure: false,
  authOptional: false,
  disabledCommands: ["STARTTLS"],

  onConnect(session, callback) {
    console.log("[SMTP] Connect:", {
      remoteAddress: session.remoteAddress,
      clientHostname: session.clientHostname,
      hostNameAppearsAs: session.hostNameAppearsAs,
    });
    callback();
  },

  onAuth(auth, session, callback) {
    console.log("[SMTP] Auth attempt:", {
      username: auth.username,
      remoteAddress: session.remoteAddress,
    });

    if (auth.username === SMTP_USER && auth.password === SMTP_PASS) {
      console.log("[SMTP] Auth success:", auth.username);
      return callback(null, { user: auth.username });
    }

    console.error("[SMTP] Auth failed:", {
      username: auth.username,
      remoteAddress: session.remoteAddress,
    });

    return callback(new Error("Invalid SMTP login"));
  },

  async onData(stream, session, callback) {
    try {
      const parsed = await simpleParser(stream);

      console.log("[MAIL] Parsed summary:", JSON.stringify(summarizeMail(parsed), null, 2));

      const parsedFrom = parsed.from?.value?.[0]?.address || "";
      const parsedTo = parsed.to?.value?.[0]?.address || "";

      const from = parsedFrom || FROM_FALLBACK;
      const to = parsedTo;
      const subject = parsed.subject || "Support Reply";

      if (!from) {
        throw new Error("Missing FROM address and FROM_FALLBACK is empty");
      }

      if (!to) {
        throw new Error("Missing TO address");
      }

      if (!isAllowedDomain(from)) {
        throw new Error(`Blocked sender domain: ${from}`);
      }

      const rawText = parsed.text || "";
      const rawHtml = typeof parsed.html === "string" ? parsed.html : "";

      const cleanedText = cleanText(rawText);
      const cleanedHtml = cleanHtml(rawHtml);

      console.log("[MAIL] Delivery info:", {
        from,
        to,
        subject,
        fromDomain: getDomain(from),
        toDomain: getDomain(to),
        cleanedTextLength: cleanedText.length,
        cleanedHtmlLength: cleanedHtml.length,
      });

      const zeptoResponse = await sendToZeptoMail({
        from,
        to,
        subject,
        textBody: cleanedText,
        htmlBody: cleanedHtml,
      });

      console.log("[MAIL] Sent successfully:", {
        from,
        to,
        subject,
        zeptoResponse,
      });

      callback();
    } catch (err) {
      console.error("[MAIL] SMTP relay error:", err);
      callback(err);
    }
  },

  onClose(session) {
    console.log("[SMTP] Connection closed:", {
      remoteAddress: session?.remoteAddress,
    });
  },

  logger: false,
});

server.on("error", (err) => {
  console.error("[SERVER] Fatal server error:", err);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("[BOOT] SMTP relay listening");
  console.log("[BOOT] Port:", PORT);
  console.log("[BOOT] From fallback:", FROM_FALLBACK || "(empty)");
  console.log("[BOOT] Allowed domains:", ALLOWED_DOMAINS);
  console.log("[BOOT] Zepto URL:", ZEPTO_API_URL);
  console.log("[BOOT] Zepto token:", maskToken(ZEPTOMAIL_TOKEN));
});
