require("dotenv").config();

const host = process.env.BIRTHDAY_SITE_HOST;
const localUrl = process.env.BIRTHDAY_SITE_URL;
const secret = process.env.BIRTHDAY_CRON_SECRET;
const baseUrl = localUrl || (host ? `https://${host}` : "");

if (!baseUrl || !secret) {
  console.error("Configura BIRTHDAY_SITE_HOST o BIRTHDAY_SITE_URL y BIRTHDAY_CRON_SECRET.");
  process.exit(1);
}

async function run() {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/internal/cumpleanos/procesar`, {
    method: "POST",
    headers: { "x-cron-secret": secret },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(body.error || `El sitio respondió HTTP ${response.status}.`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(body, null, 2));
}

run().catch((error) => {
  console.error("No se pudo ejecutar el envío diario de cumpleaños:", error.message);
  process.exitCode = 1;
});
