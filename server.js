import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { SendMailClient } from "zeptomail";

const PORT = Number(process.env.PORT || 2525);
const ZEPTO_API_URL = process.env.ZEPTO_API_URL || "https://api.zeptomail.eu/v1.1/email";
const ZEPTOMAIL_TOKEN = process.env.ZEPTOMAIL_TOKEN;
const FROM_FALLBACK = process.env.FROM_FALLBACK || "";
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || "")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

if (!ZEPTOMAIL_TOKEN) throw new Error("Missing env var: ZEPTOMAIL_TOKEN");
if (!SMTP_USER || !SMTP_PASS) throw new Error("Missing env vars: SMTP_USER / SMTP_PASS");

const zepto = new SendMailClient({
  url: ZEPTO_API_URL,
  token: ZEPTOMAIL_TOKEN
});

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

function cleanText(text = "") {
  const lines = String(text || "").split(/\r?\n/);

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

async function sendToZeptoMail({ from, to, subject, textBody, htmlBody }) {
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

  console.log("[ZEPTO] URL:", ZEPTO_API_URL);
  console.log("[ZEPTO] Payload:", JSON.stringify(payload, null, 2));

  try {
    const resp = await zepto.sendMail(payload);
    console.log("[ZEPTO] Success:", JSON.stringify(resp, null, 2));
    return resp;
  } catch (error) {
    console.error("[ZEPTO] Error object:", error);
    if (error?.response) {
      console.error("[ZEPTO] Error response:", JSON.stringify(error.response, null, 2));
    }
    throw error;
  }
}

const server = new SMTPServer({
  secure: false,
  authOptional: false,
  disabledCommands: ["STARTTLS"],

  onAuth(auth, session, callback) {
    console.log("[SMTP] Auth attempt:", auth.username, session.remoteAddress);

    if (auth.username === SMTP_USER && auth.password === SMTP_PASS) {
      console.log("[SMTP] Auth success");
      return callback(null, { user: auth.username });
    }

    console.error("[SMTP] Auth failed");
    return callback(new Error("Invalid SMTP login"));
  },

  async onData(stream, session, callback) {
    try {
      const parsed = await simpleParser(stream);

      console.log("[MAIL] Parsed:", JSON.stringify(summarize(parsed), null, 2));

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

      console.log("[MAIL] Sending:", {
        from,
        to,
        subject,
        fromDomain: getDomain(from),
        cleanedTextLength: cleanedText.length,
        cleanedHtmlLength: cleanedHtml.length
      });

      await sendToZeptoMail({
        from,
        to,
        subject,
        textBody: cleanedText,
        htmlBody: cleanedHtml
      });

      console.log("[MAIL] Sent successfully");
      callback();
    } catch (err) {
      console.error("[MAIL] SMTP relay error:", err);
      callback(err);
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("[BOOT] SMTP relay listening on port", PORT);
});
