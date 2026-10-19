const laPazDate = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/La_Paz",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>\"]/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character],
  );

const createBirthdayProcessor = ({ all, one, run }) => async () => {
  const today = laPazDate();
  const monthDay = today.slice(5);
  const year = today.slice(0, 4);
  const clients = await all(
    "SELECT id,nombre,telefono,correo FROM clientes WHERE activo=1 AND promociones_cumpleanos=1 AND strftime('%m-%d',fecha_nacimiento)=?",
    [monthDay],
  );
  const results = [];

  for (const client of clients) {
    const code = `FELIZ${client.id}${year}`;
    let coupon = await one(
      "SELECT * FROM cupones_cumpleanos WHERE cliente_id=? AND codigo=?",
      [client.id, code],
    );
    if (!coupon) {
      await run(
        "INSERT INTO cupones_cumpleanos(cliente_id,codigo,descuento) VALUES(?,?,15)",
        [client.id, code],
      );
      coupon = await one(
        "SELECT * FROM cupones_cumpleanos WHERE cliente_id=? AND codigo=?",
        [client.id, code],
      );
    }

    const delivery = {
      cliente: client.nombre,
      codigo: coupon.codigo,
      correo: "omitido",
      whatsapp: "omitido",
    };
    const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    const message = `¡Feliz cumpleaños, ${client.nombre}! Il Salone Lia Vincenzo te regala ${coupon.descuento}% de descuento. Usa el código ${coupon.codigo}.`;

    if (coupon.email_enviado_en) delivery.correo = "enviado anteriormente";
    else if (!client.correo) delivery.correo = "sin correo";
    else if (!process.env.RESEND_API_KEY || !process.env.BIRTHDAY_EMAIL_FROM)
      delivery.correo = "proveedor no configurado";
    else {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `birthday-email-${client.id}-${year}`,
          },
          body: JSON.stringify({
            from: process.env.BIRTHDAY_EMAIL_FROM,
            to: [client.correo],
            subject: "¡Feliz cumpleaños de Il Salone Lia Vincenzo!",
            text: message,
            html: `<p>¡Feliz cumpleaños, ${escapeHtml(client.nombre)}!</p><p>Il Salone Lia Vincenzo te regala <strong>${Number(coupon.descuento)}% de descuento</strong> en tu próxima visita.</p><p>Tu código es <strong>${escapeHtml(coupon.codigo)}</strong>.</p>`,
          }),
        });
        if (!response.ok)
          throw new Error(
            `Resend HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
          );
        await run(
          "UPDATE cupones_cumpleanos SET email_enviado_en=? WHERE id=? AND email_enviado_en IS NULL",
          [stamp, coupon.id],
        );
        delivery.correo = "enviado";
      } catch (sendError) {
        delivery.correo = "error";
        console.error(
          `Falló el correo de cumpleaños para cliente ${client.id}:`,
          sendError.message,
        );
      }
    }

    if (coupon.whatsapp_enviado_en)
      delivery.whatsapp = "enviado anteriormente";
    else if (!client.telefono) delivery.whatsapp = "sin celular";
    else if (
      !process.env.WHATSAPP_ACCESS_TOKEN ||
      !process.env.WHATSAPP_PHONE_NUMBER_ID ||
      !process.env.WHATSAPP_BIRTHDAY_TEMPLATE_NAME
    ) delivery.whatsapp = "proveedor no configurado";
    else {
      try {
        const digits = String(client.telefono).replace(/\D/g, "");
        const recipient = digits.length === 8 ? `591${digits}` : digits;
        if (recipient.length < 10 || recipient.length > 15)
          throw new Error("El celular debe tener formato internacional válido.");
        const version = process.env.WHATSAPP_GRAPH_API_VERSION || "v23.0";
        const response = await fetch(
          `https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to: recipient,
              type: "template",
              template: {
                name: process.env.WHATSAPP_BIRTHDAY_TEMPLATE_NAME,
                language: {
                  code: process.env.WHATSAPP_BIRTHDAY_TEMPLATE_LANGUAGE || "es",
                },
                components: [
                  {
                    type: "body",
                    parameters: [
                      { type: "text", text: String(client.nombre).slice(0, 200) },
                      { type: "text", text: String(coupon.descuento) },
                      { type: "text", text: String(coupon.codigo) },
                    ],
                  },
                ],
              },
            }),
          },
        );
        if (!response.ok)
          throw new Error(
            `WhatsApp HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
          );
        await run(
          "UPDATE cupones_cumpleanos SET whatsapp_enviado_en=? WHERE id=? AND whatsapp_enviado_en IS NULL",
          [stamp, coupon.id],
        );
        delivery.whatsapp = "enviado";
      } catch (sendError) {
        delivery.whatsapp = "error";
        console.error(
          `Falló WhatsApp de cumpleaños para cliente ${client.id}:`,
          sendError.message,
        );
      }
    }
    results.push(delivery);
  }

  return { fecha: today, procesados: results.length, resultados: results };
};

module.exports = createBirthdayProcessor;
