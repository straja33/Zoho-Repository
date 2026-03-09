import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";

const PORT = process.env.PORT || 2525;
const ZEPTOMAIL_TOKEN = process.env.ZEPTOMAIL_TOKEN;
const FROM_FALLBACK = process.env.FROM_FALLBACK || "";

function cleanText(text = "") {
  const lines = text.split(/\r?\n/);
  const cutMarkers = [
    /^Am .+ schrieb .+:?$/i,
    /^On .+ wrote:?$/i,
    /^[- ]*Original Message[- ]*$/i,
    /^From:.+$/i
  ];

  const hardContentMarkers = [
    /ctrk\.klclick\.com/i,
    /unsubscribe/i,
    /rabatt/i,
    /discount/i,
    /newsletter/i
  ];

  let hardMarkerCount = 0;
  let cutIndex = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (cutMarkers.some((rx) => rx.test(line))) {
      cutIndex = i;
      break;
    }

    if (hardContentMarkers.some((rx) => rx.test(line))) {
      hardMarkerCount++;
      if (hardMarkerCount >= 2) {
        cutIndex = i;
        break;
      }
    }
  }

  return lines.slice(0, cutIndex).join("\n").trim();
}

function cleanHtml(html = "") {
  let cleaned = html;

  const patterns = [
    /<div[^>]*>\s*On .*?wrote:.*$/is,
    /<div[^>]*>\s*Am .*?schrieb.*$/is,
    /-----Original Message-----.*$/is,
    /ctrk\.klclick\.com.*$/is,
    /unsubscribe.*$/is
  ];

  for (const pattern of patterns) {
    cleaned = cleaned.replace(pattern, "");
  }

  return cleaned.trim();
}

async function sendToZeptoMail({ from, to, subject, textBody, htmlBody, replyTo }) {
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
    subject,
    textbody: textBody,
    htmlbody: htmlBody || `<pre>${escapeHtml(textBody)}</pre>`
  };

  if (replyTo) {
    payload.reply_to = [{ address: replyTo }];
  }

  const res = await fetch("https://api.zeptomail.eu/v1.1/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Zoho-enczapikey ${ZEPTOMAIL_TOKEN}`
    },
    body: JSON.stringify(payload)
  });

  const body = await res.text();

  if (!res.ok) {
    throw new Error(`ZeptoMail API error ${res.status}: ${body}`);
  }

  return body;
}

function escapeHtml(str = "") {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const server = new SMTPServer({
  secure: false,
  authOptional: true,
  disabledCommands: ["STARTTLS"],
  onAuth(auth, session, callback) {
    return callback(null, { user: auth.username || "reamaze" });
  },
  async onData(stream, session, callback) {
    try {
      const parsed = await simpleParser(stream);

      const from =
        parsed.from?.value?.[0]?.address ||
        FROM_FALLBACK;

      const to =
        parsed.to?.value?.[0]?.address;

      const subject = parsed.subject || "Support Reply";
      const replyTo = parsed.replyTo?.value?.[0]?.address || from;

      if (!from || !to) {
        throw new Error("Missing from or to address");
      }

      const textBodyRaw = parsed.text || "";
      const htmlBodyRaw = parsed.html || "";

      const cleanedText = cleanText(textBodyRaw);
      const cleanedHtml = typeof htmlBodyRaw === "string" ? cleanHtml(htmlBodyRaw) : "";

      await sendToZeptoMail({
        from,
        to,
        subject,
        textBody: cleanedText,
        htmlBody: cleanedHtml,
        replyTo
      });

      console.log(`Sent cleaned email: ${from} -> ${to} | ${subject}`);
      callback();
    } catch (err) {
      console.error("SMTP relay error:", err);
      callback(err);
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`SMTP relay listening on port ${PORT}`);
});
