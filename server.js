require("dotenv").config();
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const fsp = require("fs/promises");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const crypto = require("crypto");
const createBirthdayProcessor = require("./birthday-notifications");

const app = express();
const port = Number(process.env.PORT || 3000);
const secret = process.env.JWT_SECRET;
let db = new sqlite3.Database(
  process.env.SQLITE_PATH || path.join(__dirname, "database.db"),
);

if (!secret || !process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD) {
  throw new Error(
    "Falta .env. Copia .env.example como .env y completa ADMIN_USER, ADMIN_PASSWORD y JWT_SECRET.",
  );
}

app.use(express.json({ limit: "8mb" }));
app.use((req, res, next) => {
  const requestedFile = path.basename(decodeURIComponent(req.path)).toLowerCase();
  if (/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/.test(requestedFile))
    return res.status(404).json({ error: "Recurso no encontrado." });
  next();
});
app.use(express.static(__dirname));

const run = (sql, values = []) =>
  new Promise((resolve, reject) =>
        db.run(sql, values, function (error) {
          error
            ? reject(error)
            : resolve({ id: this.lastID, changes: this.changes });
        }),
      );
const all = (sql, values = []) =>
  new Promise((resolve, reject) =>
        db.all(sql, values, (error, rows) =>
          error ? reject(error) : resolve(rows),
        ),
      );
const one = (sql, values = []) =>
  new Promise((resolve, reject) =>
        db.get(sql, values, (error, row) =>
          error ? reject(error) : resolve(row),
        ),
      );
const codeForReservation = (id) => `RES-${String(id).padStart(4, "0")}`;
const paymentLocalDateExpression = "CASE WHEN length(p.fecha)=10 THEN date(p.fecha) ELSE date(p.fecha,'-4 hours') END";
const processBirthdayPromotions = createBirthdayProcessor({
  all,
  one,
  run,
});
let reservationWriteQueue = Promise.resolve();
const withReservationLock = (work) => {
  const result = reservationWriteQueue.then(work);
  reservationWriteQueue = result.catch(() => {});
  return result;
};
const withSqliteTransaction = async (work) => {
  await run("BEGIN IMMEDIATE");
  try {
    const result = await work();
    await run("COMMIT");
    return result;
  } catch (transactionError) {
    await run("ROLLBACK").catch(() => {});
    throw transactionError;
  }
};
const decodeHtmlAttribute = (value) => String(value || "")
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'");
async function syncLegacyDressGallery() {
  const catalogPath = path.join(__dirname, "catalogo.html");
  if (!fs.existsSync(catalogPath)) return 0;
  const html = fs.readFileSync(catalogPath, "utf8");
  const firstScript = html.search(/<script\b/i);
  const markup = firstScript >= 0 ? html.slice(0, firstScript) : html;
  const scripts = html.slice(html.indexOf("const noviaNames ="));
  const readNames = (name) => {
    const match = scripts.match(new RegExp(`const ${name} = (\\[[^;]+\\]);`));
    return match ? JSON.parse(match[1]) : [];
  };
  const noviaNames = readNames("noviaNames");
  const pasarelaNames = readNames("pasarelaNames");
  const attribute = (source, name) => {
    const match = source.match(new RegExp(`${name}="([^"]*)"`));
    return match ? decodeHtmlAttribute(match[1]) : "";
  };
  const cardPattern = /<div class="col-md-6 col-lg-4 dress"([^>]*)>([\s\S]*?<\/article>)/g;
  let noviaIndex = 0;
  let pasarelaIndex = 0;
  let inserted = 0;
  await withSqliteTransaction(async () => {
    for (const match of markup.matchAll(cardPattern)) {
      const attrs = match[1];
      const body = match[2];
      const category = attribute(attrs, "data-category").toLowerCase();
      let name = attribute(attrs, "data-name");
      if (category === "novia") name = noviaNames[noviaIndex++] || name;
      else if (category === "pasarela") name = pasarelaNames[pasarelaIndex++] || name;
      const main = body.match(/class="product-image-wrap"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"/);
      const alternate = body.match(/<button[^>]*class="[^"]*quick-view[^"]*"[^>]*data-image="([^"]+)"/);
      const mainPath = decodeHtmlAttribute(main?.[1]);
      const alternatePath = decodeHtmlAttribute(alternate?.[1]);
      if (!name || !mainPath || !alternatePath || mainPath === alternatePath) continue;
      const safePath = alternatePath.replace(/\\/g, "/");
      const parts = safePath.split("/");
      if (!safePath.startsWith("imagenes/") || parts.some((part) => !part || part === "." || part === "..")) continue;
      const filePath = path.resolve(__dirname, ...parts);
      if (!filePath.startsWith(path.resolve(__dirname, "imagenes") + path.sep) || !fs.existsSync(filePath)) continue;
      const dress = await one("SELECT id FROM vestidos WHERE nombre=? AND imagen=? ORDER BY id LIMIT 1", [name, mainPath]);
      if (!dress) continue;
      const saved = await run("INSERT OR IGNORE INTO vestido_imagenes(vestido_id,ruta) VALUES(?,?)", [dress.id, safePath]);
      inserted += saved.changes;
    }
  });
  return inserted;
}
const isActiveReservation = (status) =>
  !["cancelada", "cancelado", "anulada", "anulado", "rechazada", "rechazado"].includes(
    String(status || "").toLocaleLowerCase("es"),
  );
const minutesOfDay = (time) => {
  const match = String(time || "").match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};
const oruroNow = () => {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/La_Paz",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return {
    fecha: `${values.year}-${values.month}-${values.day}`,
    hora: `${values.hour}:${values.minute}`,
  };
};
const configuredServiceBranches = new Set([
  "Casa Central · Oruro",
  "Sucursal Acera Oeste · Oruro",
]);
const isCalendarDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
};
const serviceScheduleAvailability = (fecha, hora, duration = 60) => {
  if (!isCalendarDate(fecha) || !/^\d{2}:\d{2}$/.test(String(hora || "")) || minutesOfDay(hora) === null)
    return { disponible: false, mensaje: "Selecciona una fecha y hora válidas." };
  const today = oruroNow();
  if (fecha < today.fecha || (fecha === today.fecha && hora <= today.hora))
    return { disponible: false, mensaje: "La hora seleccionada ya pasó. Elige otro horario." };
  const [year, month, day] = fecha.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const closing = weekday === 0 ? 17 * 60 : 21 * 60;
  const start = minutesOfDay(hora);
  const serviceDuration = Math.max(1, Number(duration) || 60);
  if (start < 9 * 60 || start % 60 !== 0 || start + serviceDuration > closing)
    return { disponible: false, mensaje: "El servicio debe realizarse dentro del horario de atención y terminar antes del cierre." };
  return { disponible: true, mensaje: "Horario disponible." };
};
const dressTrialScheduleAvailability = (fecha, hora) => {
  if (!isCalendarDate(fecha) || !/^\d{2}:\d{2}$/.test(String(hora || "")))
    return { disponible: false, mensaje: "Selecciona una fecha y hora de prueba válidas." };
  const start = minutesOfDay(hora);
  const today = oruroNow();
  if (start === null || start < 9 * 60 || start % 30 !== 0)
    return { disponible: false, mensaje: "La prueba debe iniciar en un intervalo de 30 minutos, desde las 09:00." };
  if (fecha < today.fecha || (fecha === today.fecha && hora <= today.hora))
    return { disponible: false, mensaje: "La hora seleccionada ya pasó. Elige otro horario." };
  const [year, month, day] = fecha.split("-").map(Number);
  const closing = new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 0 ? 17 * 60 : 21 * 60;
  if (start + 30 > closing)
    return { disponible: false, mensaje: "La prueba debe terminar antes del horario de cierre." };
  return { disponible: true, mensaje: "Horario de prueba disponible." };
};
async function reservationAvailability(booking, excludeId = null) {
  const { tipo, fecha, hora, servicio_id, vestido_id, fecha_evento, sucursal } = booking;
  if (!fecha || !["servicio", "vestido"].includes(tipo))
    return { disponible: false, mensaje: "Selecciona el tipo y la fecha de la reserva." };
  if (tipo === "servicio") {
    if (!hora || !servicio_id)
      return { disponible: false, mensaje: "Selecciona el servicio y la hora." };
    const branch = String(sucursal || "").trim();
    const legacyBranch = branch && await one("SELECT 1 FROM reservas WHERE sucursal=? LIMIT 1", [branch]);
    if (!configuredServiceBranches.has(branch) && !legacyBranch)
      return { disponible: false, mensaje: "Selecciona una sucursal válida." };
    const service = await one(
      "SELECT id,activo,duracion_minutos FROM servicios WHERE id=?",
      [servicio_id],
    );
    if (!service || !service.activo)
      return { disponible: false, mensaje: "El servicio seleccionado no está disponible." };
    const start = minutesOfDay(hora);
    if (start === null)
      return { disponible: false, mensaje: "Selecciona una hora válida." };
    const duration = Math.max(1, Number(service.duracion_minutos) || 60);
    const schedule = serviceScheduleAvailability(fecha, hora, duration);
    if (!schedule.disponible) return schedule;
    const existing = await all(
      "SELECT r.id,r.hora,r.estado,r.sucursal,s.duracion_minutos FROM reservas r LEFT JOIN servicios s ON s.id=r.servicio_id WHERE r.tipo='servicio' AND r.fecha=?",
      [fecha],
    );
    const conflict = existing.some((item) => {
      if (String(item.id) === String(excludeId) || !isActiveReservation(item.estado)) return false;
      if (sucursal && item.sucursal && String(item.sucursal).trim() !== String(sucursal).trim()) return false;
      const existingStart = minutesOfDay(item.hora);
      const existingDuration = Math.max(1, Number(item.duracion_minutos) || 60);
      return existingStart !== null && start < existingStart + existingDuration && existingStart < start + duration;
    });
    return conflict
      ? { disponible: false, mensaje: "Horario no disponible" }
      : schedule;
  }
  if (!vestido_id)
    return { disponible: false, mensaje: "Selecciona un vestido." };
  const dress = await one("SELECT id FROM vestidos WHERE id=? AND activo=1 AND disponible=1", [vestido_id]);
  if (!dress)
    return { disponible: false, mensaje: "Selecciona un vestido existente." };
  const trialSchedule = dressTrialScheduleAvailability(fecha, hora);
  if (!trialSchedule.disponible) return trialSchedule;
  const branch = String(sucursal || "Boutique Lía Vincenzo").trim();
  const trialReservations = await all(
    "SELECT r.id,r.tipo,r.hora,r.estado,r.sucursal,s.duracion_minutos FROM reservas r LEFT JOIN servicios s ON s.id=r.servicio_id WHERE r.fecha=? AND r.hora IS NOT NULL",
    [fecha],
  );
  const trialStart = minutesOfDay(hora);
  const trialConflict = trialReservations.some((item) => {
    if (String(item.id) === String(excludeId) || !isActiveReservation(item.estado)) return false;
    if (String(item.sucursal || "").trim() !== branch) return false;
    const existingStart = minutesOfDay(item.hora);
    const existingDuration = item.tipo === "vestido" ? 30 : Math.max(1, Number(item.duracion_minutos) || 60);
    return existingStart !== null && trialStart < existingStart + existingDuration && existingStart < trialStart + 30;
  });
  if (trialConflict) return { disponible: false, mensaje: "Ese horario de prueba ya está ocupado." };
  const useDate = fecha_evento || fecha;
  const existing = await all(
    "SELECT id,fecha,fecha_evento,estado,sucursal FROM reservas WHERE tipo='vestido' AND vestido_id=?",
    [vestido_id],
  );
  const conflict = existing.some((item) =>
    String(item.id) !== String(excludeId) &&
    isActiveReservation(item.estado) &&
    (!sucursal || !item.sucursal || String(item.sucursal).trim() === String(sucursal).trim()) &&
    (item.fecha_evento || item.fecha) === useDate,
  );
    return conflict
      ? { disponible: false, mensaje: "Este vestido ya fue reservado para esta fecha." }
    : { disponible: true, mensaje: "Vestido disponible para esa fecha." };
}

const normalizeRole = (role) => {
  const value = String(role || "").trim().toLocaleLowerCase("es");
  if (["admin", "administrador", "administrator"].includes(value)) return "administrador";
  if (["empleado", "employee", "staff"].includes(value)) return "empleado";
  if (["cliente", "usuario", "user", "customer", "usuario/cliente", "user/cliente"].includes(value)) return "cliente";
  return "desconocido";
};
function requireAuth(request, response, next) {
  const token = request.headers.authorization?.replace("Bearer ", "");
  try {
    request.authToken = jwt.verify(token, secret);
  } catch {
    return response.status(401).json({ error: "Sesión no válida o vencida." });
  }
  one("SELECT id,rol FROM usuarios_admin WHERE id=?", [request.authToken.id])
    .then((user) => {
      if (!user) return response.status(401).json({ error: "La cuenta ya no tiene acceso al panel." });
      request.user = { id: user.id, rol: normalizeRole(user.rol) };
      next();
    })
    .catch(next);
}
function requireRole(...roles) {
  const allowed = new Set(roles.map(normalizeRole));
  return (request, response, next) => {
    if (!request.user || !allowed.has(request.user.rol))
      return response.status(403).json({ error: "No tienes permisos para realizar esta acción." });
    next();
  };
}
function error(response, value) {
  console.error(value);
  if (
    value?.code?.startsWith("SQLITE_CONSTRAINT")
  ) {
    return response.status(400).json({
      error:
        "No se pudo guardar o eliminar el registro porque ya existe información relacionada o duplicada.",
    });
  }
  response.status(500).json({ error: "No se pudo completar la operación." });
}

async function setup() {
  await run("PRAGMA busy_timeout = 5000");
  await run("PRAGMA foreign_keys = ON");
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS usuarios_admin (id INTEGER PRIMARY KEY AUTOINCREMENT,nombre TEXT NOT NULL,usuario TEXT UNIQUE NOT NULL,contrasena_hash TEXT NOT NULL,rol TEXT DEFAULT 'administrador')`,
    `CREATE TABLE IF NOT EXISTS clientes (id INTEGER PRIMARY KEY AUTOINCREMENT,nombre TEXT NOT NULL,telefono TEXT NOT NULL,correo TEXT UNIQUE,fecha_nacimiento TEXT,promociones_cumpleanos INTEGER NOT NULL DEFAULT 0,activo INTEGER NOT NULL DEFAULT 1,creado_en TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS servicios (id INTEGER PRIMARY KEY AUTOINCREMENT,nombre TEXT NOT NULL,descripcion TEXT,precio REAL NOT NULL DEFAULT 0,duracion_minutos INTEGER,activo INTEGER DEFAULT 1,imagen TEXT)`,
    `CREATE TABLE IF NOT EXISTS vestidos (id INTEGER PRIMARY KEY AUTOINCREMENT,nombre TEXT NOT NULL,categoria TEXT,color TEXT,talla TEXT,precio REAL NOT NULL DEFAULT 0,imagen TEXT,disponible INTEGER DEFAULT 1,activo INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS vestido_imagenes (id INTEGER PRIMARY KEY AUTOINCREMENT,vestido_id INTEGER NOT NULL,ruta TEXT NOT NULL,creado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(vestido_id) REFERENCES vestidos(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS reservas (id INTEGER PRIMARY KEY AUTOINCREMENT,cliente_id INTEGER NOT NULL,tipo TEXT NOT NULL,servicio_id INTEGER,vestido_id INTEGER,sucursal TEXT,fecha TEXT NOT NULL,fecha_evento TEXT,hora TEXT,estado TEXT DEFAULT 'pendiente',notas TEXT,creado_en TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(cliente_id) REFERENCES clientes(id),FOREIGN KEY(servicio_id) REFERENCES servicios(id),FOREIGN KEY(vestido_id) REFERENCES vestidos(id))`,
    `CREATE TABLE IF NOT EXISTS pagos (id INTEGER PRIMARY KEY AUTOINCREMENT,reserva_id INTEGER NOT NULL,monto REAL NOT NULL,tipo TEXT NOT NULL,metodo TEXT,estado TEXT NOT NULL DEFAULT 'Pendiente' CHECK (estado IN ('Pendiente','Terminado')),fecha TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(reserva_id) REFERENCES reservas(id))`,
    `CREATE TABLE IF NOT EXISTS cupones_cumpleanos (id INTEGER PRIMARY KEY AUTOINCREMENT,cliente_id INTEGER NOT NULL,codigo TEXT UNIQUE NOT NULL,descuento INTEGER NOT NULL DEFAULT 15,fecha_generacion TEXT DEFAULT CURRENT_TIMESTAMP,usado INTEGER DEFAULT 0,email_enviado_en TEXT,whatsapp_enviado_en TEXT,FOREIGN KEY(cliente_id) REFERENCES clientes(id))`,
    `CREATE TABLE IF NOT EXISTS consultas_contacto (id INTEGER PRIMARY KEY AUTOINCREMENT,nombre TEXT NOT NULL,correo TEXT NOT NULL,celular TEXT,mensaje TEXT NOT NULL,fecha_consulta TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  ])
    await run(sql);
  const clientColumns = await all("PRAGMA table_info(clientes)");
  if (!clientColumns.some((column) => column.name === "activo"))
    await run("ALTER TABLE clientes ADD COLUMN activo INTEGER NOT NULL DEFAULT 1");
  if (!clientColumns.some((column) => column.name === "promociones_cumpleanos"))
    await run("ALTER TABLE clientes ADD COLUMN promociones_cumpleanos INTEGER NOT NULL DEFAULT 0");
  const reservationColumns = await all("PRAGMA table_info(reservas)");
  if (!reservationColumns.some((column) => column.name === "fecha_evento"))
    await run("ALTER TABLE reservas ADD COLUMN fecha_evento TEXT");
  const paymentColumns = await all("PRAGMA table_info(pagos)");
  if (!paymentColumns.some((column) => column.name === "estado"))
    await run("ALTER TABLE pagos ADD COLUMN estado TEXT NOT NULL DEFAULT 'Pendiente' CHECK (estado IN ('Pendiente','Terminado'))");
  if (!paymentColumns.some((column) => column.name === "fecha_recepcion"))
    await run("ALTER TABLE pagos ADD COLUMN fecha_recepcion TEXT");
  const serviceColumns = await all("PRAGMA table_info(servicios)");
  if (!serviceColumns.some((column) => column.name === "imagen"))
    await run("ALTER TABLE servicios ADD COLUMN imagen TEXT");
  const dressColumns = await all("PRAGMA table_info(vestidos)");
  if (!dressColumns.some((column) => column.name === "activo"))
    await run("ALTER TABLE vestidos ADD COLUMN activo INTEGER NOT NULL DEFAULT 1");
  for (const [column, declaration] of [["descripcion", "TEXT"], ["detalles", "TEXT"], ["evento_recomendado", "TEXT"]]) {
    if (!dressColumns.some((item) => item.name === column))
      await run(`ALTER TABLE vestidos ADD COLUMN ${column} ${declaration}`);
  }
  await run("CREATE UNIQUE INDEX IF NOT EXISTS idx_vestido_imagenes_unique ON vestido_imagenes(vestido_id,ruta)");
  const restoredGalleryPhotos = await syncLegacyDressGallery();
  if (restoredGalleryPhotos) console.log(`Fotografías adicionales del catálogo recuperadas: ${restoredGalleryPhotos}`);
  const contactColumns = await all("PRAGMA table_info(consultas_contacto)");
  if (!contactColumns.some((column) => column.name === "celular"))
    await run("ALTER TABLE consultas_contacto ADD COLUMN celular TEXT");
  const birthdayColumns = await all("PRAGMA table_info(cupones_cumpleanos)");
  if (!birthdayColumns.some((column) => column.name === "email_enviado_en"))
    await run("ALTER TABLE cupones_cumpleanos ADD COLUMN email_enviado_en TEXT");
  if (!birthdayColumns.some((column) => column.name === "whatsapp_enviado_en"))
    await run("ALTER TABLE cupones_cumpleanos ADD COLUMN whatsapp_enviado_en TEXT");
  if (
    !(await one("SELECT id FROM usuarios_admin WHERE usuario=?", [
      process.env.ADMIN_USER,
    ]))
  ) {
    await run(
      "INSERT INTO usuarios_admin(nombre,usuario,contrasena_hash) VALUES (?,?,?)",
      [
        "Administración Il Salone",
        process.env.ADMIN_USER,
        await bcrypt.hash(process.env.ADMIN_PASSWORD, 12),
      ],
    );
  }
  console.log("Base de datos activa: SQLite");
}

app.post("/api/contacto", async (req, res) => {
  try {
    const nombre = String(req.body.nombre || "").trim();
    const correo = String(req.body.correo || "").trim();
    const celular = String(req.body.celular || "").trim();
    const mensaje = String(req.body.mensaje || "").trim();
    const phoneDigits = celular.replace(/\D/g, "");
    if (!nombre || !correo || !celular || !mensaje)
      return res.status(400).json({ error: "Completa nombre, correo, celular y mensaje." });
    if (nombre.length > 150 || correo.length > 150 || celular.length > 30 || mensaje.length > 10000 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo))
      return res.status(400).json({ error: "Revisa el nombre, el correo o la longitud de los datos." });
    if (!/^\+?[0-9\s().-]+$/.test(celular) || phoneDigits.length < 7 || phoneDigits.length > 15)
      return res.status(400).json({ error: "Introduce un número de celular válido (entre 7 y 15 dígitos)." });
    const saved = await run(
      "INSERT INTO consultas_contacto(nombre,correo,celular,mensaje) VALUES(?,?,?,?)",
      [nombre, correo, celular, mensaje],
    );
    res.status(201).json({ id: saved.id, mensaje: "Consulta enviada correctamente." });
  } catch (value) {
    error(res, value);
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const user = await one("SELECT * FROM usuarios_admin WHERE usuario=?", [
      req.body.usuario,
    ]);
    if (
      !user ||
      !(await bcrypt.compare(req.body.contrasena || "", user.contrasena_hash))
    )
      return res
        .status(401)
        .json({ error: "Usuario o contraseña incorrectos." });
    const rol = normalizeRole(user.rol);
    if (!["administrador", "empleado"].includes(rol))
      return res.status(403).json({ error: "Esta cuenta no tiene acceso al Panel Administrativo." });
    res.json({
      token: jwt.sign({ id: user.id, rol }, secret, {
        expiresIn: "8h",
      }),
      nombre: user.nombre,
      rol,
    });
  } catch (value) {
    error(res, value);
  }
});

async function findOrCreateBookingClient(booking, acceptsPromotions) {
  const email = String(booking.correo || "").trim().toLocaleLowerCase("es") || null;
  const phone = String(booking.telefono || "").trim();
  let client = email
    ? await one("SELECT * FROM clientes WHERE lower(trim(correo))=? LIMIT 1", [email])
    : null;
  if (!client) {
    client = email
      ? await one("SELECT * FROM clientes WHERE telefono=? AND (correo IS NULL OR trim(correo)='' OR lower(trim(correo))=?) ORDER BY id LIMIT 1", [phone,email])
      : await one("SELECT * FROM clientes WHERE telefono=? ORDER BY id LIMIT 1", [phone]);
  }
  if (!client) {
    const created = await run(
      "INSERT INTO clientes(nombre,telefono,correo,fecha_nacimiento,promociones_cumpleanos) VALUES(?,?,?,?,?)",
      [String(booking.nombre).trim(),phone,email,booking.fecha_nacimiento || null,acceptsPromotions ? 1 : 0],
    );
    return { id: created.id };
  }
  const hasBirthdayFields = Object.prototype.hasOwnProperty.call(booking, "fecha_nacimiento") || Object.prototype.hasOwnProperty.call(booking, "acepta_promociones");
  await run(
    `UPDATE clientes SET nombre=?,telefono=?,correo=COALESCE(?,correo),fecha_nacimiento=COALESCE(?,fecha_nacimiento),promociones_cumpleanos=?,activo=1 WHERE id=?`,
    [String(booking.nombre).trim(),phone,email,booking.fecha_nacimiento || null,hasBirthdayFields ? (acceptsPromotions ? 1 : 0) : Number(client.promociones_cumpleanos || 0),client.id],
  );
  return { id: client.id };
}

app.post("/api/solicitudes/servicio", async (req, res) => {
  try {
    const b = req.body;
    const aceptaPromociones = ["true", "1", "on"].includes(String(b.acepta_promociones).toLowerCase());
    if (!b.nombre || !b.telefono || !b.fecha || !b.hora || !(b.servicio_id || b.servicio) || !b.sucursal)
      return res
        .status(400)
        .json({ error: "Completa los campos obligatorios." });
    const result = await withReservationLock(() => withSqliteTransaction(async () => {
      const service = await one(
        "SELECT id FROM servicios WHERE activo=1 AND (id=? OR nombre=?) ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1",
        [Number(b.servicio_id || b.servicio) || -1, b.servicio || "", Number(b.servicio_id || b.servicio) || -1],
      );
      if (!service) return { invalidService: true };
      const availability = await reservationAvailability({
        tipo: "servicio",
        servicio_id: service.id,
        fecha: b.fecha,
        hora: b.hora,
        sucursal: b.sucursal,
      });
      if (!availability.disponible) return { availability };
      const client = await findOrCreateBookingClient(b, aceptaPromociones);
      const saved = await run(
        "INSERT INTO reservas(cliente_id,tipo,servicio_id,sucursal,fecha,hora,estado,notas) VALUES(?,?,?,?,?,?,?,?)",
        [client.id,"servicio",service.id,b.sucursal || null,b.fecha,b.hora,"pendiente",b.notas || null],
      );
      return { saved };
    }));
    if (result.invalidService)
      return res.status(400).json({ error: "El servicio seleccionado no existe o no está activo. Actualiza la página y vuelve a seleccionarlo." });
    if (result.availability)
      return res.status(409).json({ error: result.availability.mensaje || "Horario no disponible" });
    res.status(201).json({
      id: result.saved.id,
      codigo: codeForReservation(result.saved.id),
    });
  } catch (value) {
    error(res, value);
  }
});

app.get("/api/servicios-publicos", async (_, res) => {
  try {
    res.json(await all("SELECT id,nombre,descripcion,precio,duracion_minutos,imagen FROM servicios WHERE activo=1 ORDER BY id"));
  } catch (value) {
    error(res, value);
  }
});

app.get("/api/vestidos-publicos", async (req, res) => {
  try {
    const date = String(req.query.fecha || "");
    if (date && !isCalendarDate(date))
      return res.status(400).json({ error: "Selecciona una fecha válida para consultar disponibilidad." });
    const rows = await all(
      `SELECT v.id,v.nombre,v.categoria,v.color,v.talla,v.precio,v.imagen,v.descripcion,v.detalles,v.evento_recomendado,
        CASE WHEN ?='' THEN 1 WHEN EXISTS (
          SELECT 1 FROM reservas r WHERE r.tipo='vestido' AND r.vestido_id=v.id
            AND COALESCE(r.fecha_evento,r.fecha)=?
            AND LOWER(TRIM(COALESCE(r.estado,''))) NOT IN ('cancelada','cancelado','anulada','anulado','rechazada','rechazado')
        ) THEN 0 ELSE 1 END disponible
       FROM vestidos v WHERE v.activo=1 AND v.disponible=1 ORDER BY v.id`,
      [date, date],
    );
    const gallery = rows.length
      ? await all(`SELECT vestido_id,ruta FROM vestido_imagenes WHERE vestido_id IN (${rows.map(() => "?").join(",")}) ORDER BY id`, rows.map((row) => row.id))
      : [];
    const galleryByDress = new Map();
    for (const image of gallery) {
      const images = galleryByDress.get(image.vestido_id) || [];
      images.push(image.ruta);
      galleryByDress.set(image.vestido_id, images);
    }
    res.json(rows.map((row) => ({ ...row, imagenes: galleryByDress.get(row.id) || [], disponible: Boolean(row.disponible) })));
  } catch (value) {
    error(res, value);
  }
});

app.get("/api/disponibilidad", async (req, res) => {
  try {
    const tipo = req.query.tipo;
    if (tipo === "servicio") {
      const service = await one(
        "SELECT id FROM servicios WHERE activo=1 AND (id=? OR nombre=?) ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1",
        [Number(req.query.servicio_id || req.query.servicio) || -1, req.query.servicio || "", Number(req.query.servicio_id || req.query.servicio) || -1],
      );
      if (!service) return res.status(400).json({ error: "El servicio seleccionado no existe o no está activo." });
      return res.json(await reservationAvailability({
        tipo,
        servicio_id: service.id,
        fecha: req.query.fecha,
        hora: req.query.hora,
        sucursal: req.query.sucursal,
      }));
    }
    if (tipo === "vestido") {
      const dress = await one(
        "SELECT id FROM vestidos WHERE activo=1 AND disponible=1 AND ((? > 0 AND id=?) OR (? <= 0 AND nombre=?)) ORDER BY CASE WHEN COALESCE(imagen,'')=COALESCE(?, '') THEN 0 ELSE 1 END,id LIMIT 1",
        [Number(req.query.vestido_id) || 0, Number(req.query.vestido_id) || 0, Number(req.query.vestido_id) || 0, req.query.vestido, req.query.imagen || ""],
      );
      if (!dress) return res.status(404).json({ error: "El vestido ya no está disponible en el catálogo." });
    return res.json(await reservationAvailability({
        tipo,
        vestido_id: dress.id,
        fecha: req.query.fecha_prueba || req.query.fecha || req.query.fecha_evento,
        fecha_evento: req.query.fecha_evento,
        hora: req.query.hora,
        sucursal: req.query.sucursal,
      }));
    }
    return res.status(400).json({ error: "Selecciona un servicio o vestido válido." });
  } catch (value) {
    error(res, value);
  }
});

app.get("/api/vestidos/disponibilidad", async (req, res) => {
  try {
    const fecha = req.query.fecha;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || "")))
      return res.status(400).json({ error: "Selecciona una fecha válida para consultar el catálogo." });
    const dresses = await all(
      "SELECT v.id,v.nombre,CASE WHEN EXISTS (SELECT 1 FROM reservas r WHERE r.tipo='vestido' AND r.vestido_id=v.id AND COALESCE(r.fecha_evento,r.fecha)=? AND LOWER(COALESCE(r.estado,'')) NOT IN ('cancelada','cancelado','anulada','anulado','rechazada','rechazado')) THEN 0 ELSE 1 END disponible FROM vestidos v WHERE v.activo=1 AND v.disponible=1 ORDER BY v.id",
      [fecha],
    );
    res.json({ fecha, vestidos: dresses.map((dress) => ({ ...dress, disponible: Boolean(Number(dress.disponible)) })) });
  } catch (value) {
    error(res, value);
  }
});

app.post("/api/solicitudes/vestido", async (req, res) => {
  try {
    const b = req.body;
    const aceptaPromociones = ["true", "1", "on"].includes(String(b.acepta_promociones).toLowerCase());
    if (
      !b.nombre ||
      !b.telefono ||
      !b.vestido ||
      !b.fecha_prueba ||
      !b.fecha_evento ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(b.hora || ""))
    )
      return res.status(400).json({
        error: "Completa los datos obligatorios para reservar el vestido.",
      });
    if (!isCalendarDate(b.fecha_prueba) || !isCalendarDate(b.fecha_evento))
      return res.status(400).json({ error: "Selecciona fechas válidas para la prueba y el evento." });
    if (b.fecha_prueba < oruroNow().fecha || b.fecha_evento < oruroNow().fecha)
      return res.status(400).json({ error: "La prueba y el evento no pueden estar en el pasado." });
    if (b.fecha_prueba >= b.fecha_evento)
      return res
        .status(400)
        .json({ error: "La prueba debe ser anterior a la fecha del evento." });
    const dressName = b.vestido.nombre || b.vestido.name;
    if (!dressName)
      return res.status(400).json({ error: "Selecciona un vestido válido." });
    const result = await withReservationLock(() => withSqliteTransaction(async () => {
      const dress = await one(
        "SELECT id,disponible,activo FROM vestidos WHERE activo=1 AND disponible=1 AND ((? > 0 AND id=?) OR (? <= 0 AND nombre=?)) ORDER BY CASE WHEN COALESCE(imagen,'')=COALESCE(?, '') THEN 0 ELSE 1 END,id LIMIT 1",
        [Number(b.vestido_id || b.vestido.id) || 0, Number(b.vestido_id || b.vestido.id) || 0, Number(b.vestido_id || b.vestido.id) || 0, dressName, b.vestido.imagen || ""],
      );
      if (!dress) return { invalidDress: true };
      const availability = await reservationAvailability({
        tipo: "vestido",
        vestido_id: dress.id,
        fecha: b.fecha_prueba,
        fecha_evento: b.fecha_evento,
        hora: b.hora,
        sucursal: "Boutique Lía Vincenzo",
      });
      if (!availability.disponible) return { availability };
      const client = await findOrCreateBookingClient(b, aceptaPromociones);
      const notes = b.comentario?.trim() || null;
      const saved = await run(
        "INSERT INTO reservas(cliente_id,tipo,vestido_id,sucursal,fecha,fecha_evento,hora,estado,notas) VALUES(?,?,?,?,?,?,?,?,?)",
        [client.id,"vestido",dress.id,"Boutique Lía Vincenzo",b.fecha_prueba,b.fecha_evento,b.hora,"pendiente",notes],
      );
      return { saved };
    }));
    if (result.invalidDress)
      return res.status(404).json({ error: "El vestido seleccionado ya no está activo en el catálogo." });
    if (result.availability)
      return res.status(409).json({ error: "Este vestido ya fue reservado para esta fecha." });
    res.status(201).json({
      id: result.saved.id,
      codigo: codeForReservation(result.saved.id),
    });
  } catch (value) {
    error(res, value);
  }
});

app.get("/api/consultas", requireAuth, requireRole("administrador", "empleado"), async (_, res) => {
  try {
    res.json(await all("SELECT id,nombre,correo,celular,mensaje,fecha_consulta FROM consultas_contacto ORDER BY fecha_consulta DESC,id DESC"));
  } catch (value) {
    error(res, value);
  }
});

app.get("/api/dashboard", requireAuth, requireRole("administrador", "empleado"), async (_, res) => {
  try {
    const queries = [
      "SELECT COUNT(*) total FROM clientes WHERE activo=1",
      "SELECT COUNT(*) total FROM reservas",
      "SELECT COUNT(*) total FROM reservas WHERE date(COALESCE(fecha_evento,fecha))=? AND LOWER(TRIM(COALESCE(estado,''))) NOT IN ('cancelada','cancelado','anulada','anulado','rechazada','rechazado')",
      "SELECT COUNT(DISTINCT r.vestido_id) total FROM reservas r WHERE r.tipo='vestido' AND r.vestido_id IS NOT NULL AND date(COALESCE(r.fecha_evento,r.fecha))>=? AND LOWER(TRIM(COALESCE(r.estado,''))) IN ('pendiente','confirmada','confirmado')",
      "SELECT COUNT(*) total FROM servicios WHERE activo=1",
    ];
    const today = oruroNow().fecha;
    const result = await Promise.all(queries.map((query, index) =>
      one(query, index === 2 || index === 3 ? [today] : []),
    ));
    res.json({
      clientes: result[0].total,
      reservas: result[1].total,
      reservasHoy: result[2].total,
      vestidos: result[3].total,
      servicios: result[4].total,
    });
  } catch (value) {
    error(res, value);
  }
});

const invalidImagePath = (message) => Object.assign(new Error(message), { status: 400 });
const resolvePublicImage = async (value) => {
  const relative = String(value || "").replace(/\\/g, "/");
  const parts = relative.split("/");
  if (!relative.startsWith("imagenes/") || /[%?#:\u0000-\u001f]/.test(relative) || parts.some((part) => !part || part === "." || part === "..") || !/\.(?:jpe?g|png|webp|gif)$/i.test(relative))
    throw invalidImagePath("Usa una ruta relativa de imagen dentro de la carpeta imagenes/.");
  const absolute = path.resolve(__dirname, ...parts);
  if (!absolute.startsWith(path.resolve(__dirname, "imagenes") + path.sep))
    throw invalidImagePath("La ruta de la imagen está fuera de la carpeta pública permitida.");
  try {
    const stat = await fsp.stat(absolute);
    if (!stat.isFile()) throw new Error();
  } catch {
    throw invalidImagePath("No se encontró esa imagen dentro de la carpeta pública del proyecto.");
  }
  return relative;
};

const saveUploadedImage = async (dataUrl, folder, id) => {
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl || ""));
  if (!match) throw new Error("Selecciona una imagen JPG, PNG o WebP válida.");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) throw new Error("La imagen debe pesar como máximo 5 MB.");
  const validSignature = match[1] === "jpeg"
    ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    : match[1] === "png"
      ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP";
  if (!validSignature) throw new Error("El contenido del archivo no coincide con el formato de imagen.");
  const extension = match[1] === "jpeg" ? ".jpg" : `.${match[1]}`;
  const relative = path.posix.join("imagenes", folder, String(id), `${crypto.randomUUID()}${extension}`);
  const absolute = path.join(__dirname, ...relative.split("/"));
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  await fsp.writeFile(absolute, buffer, { flag: "wx" });
  return relative;
};

app.post("/api/servicios/:id/imagen", requireAuth, requireRole("administrador"), async (req, res) => {
  try {
    const service = await one("SELECT id FROM servicios WHERE id=?", [req.params.id]);
    if (!service) return res.status(404).json({ error: "El servicio no existe." });
    const ruta = await saveUploadedImage(req.body.imagenBase64, "servicios-admin", service.id);
    await run("UPDATE servicios SET imagen=? WHERE id=?", [ruta, service.id]);
    res.status(201).json({ ruta });
  } catch (value) {
    res.status(400).json({ error: value.message || "No se pudo guardar la imagen." });
  }
});

app.post("/api/vestidos/:id/imagenes", requireAuth, requireRole("administrador"), async (req, res) => {
  try {
    const dress = await one("SELECT id FROM vestidos WHERE id=?", [req.params.id]);
    if (!dress) return res.status(404).json({ error: "El vestido no existe." });
    const ruta = await saveUploadedImage(req.body.imagenBase64, "vestidos-admin", dress.id);
    if (req.body.principal === true) {
      await run("UPDATE vestidos SET imagen=? WHERE id=?", [ruta, dress.id]);
      return res.status(201).json({ ruta, principal: true });
    }
    const saved = await run("INSERT INTO vestido_imagenes(vestido_id,ruta) VALUES(?,?)", [dress.id, ruta]);
    res.status(201).json({ id: saved.id, ruta, principal: false });
  } catch (value) {
    res.status(400).json({ error: value.message || "No se pudo guardar la imagen." });
  }
});

app.get("/api/vestidos/:id/imagenes", requireAuth, requireRole("administrador", "empleado"), async (req, res) => {
  try {
    res.json(await all("SELECT id,ruta FROM vestido_imagenes WHERE vestido_id=? ORDER BY id", [req.params.id]));
  } catch (value) {
    error(res, value);
  }
});

app.delete("/api/vestidos/:id/imagenes/:imageId", requireAuth, requireRole("administrador"), async (req, res) => {
  try {
    const image = await one("SELECT id,ruta FROM vestido_imagenes WHERE id=? AND vestido_id=?", [req.params.imageId, req.params.id]);
    if (!image) return res.status(404).json({ error: "La imagen adicional ya no existe." });
    await run("DELETE FROM vestido_imagenes WHERE id=? AND vestido_id=?", [image.id, req.params.id]);
    const absolute = path.resolve(__dirname, ...image.ruta.split(/[\\/]/));
    if (absolute.startsWith(path.resolve(__dirname, "imagenes", "vestidos-admin") + path.sep)) await fsp.rm(absolute, { force: true });
    res.json({ mensaje: "Imagen adicional eliminada." });
  } catch (value) {
    error(res, value);
  }
});

const entities = {
  clientes: ["nombre", "telefono", "correo", "fecha_nacimiento"],
  servicios: ["nombre", "descripcion", "precio", "duracion_minutos", "activo", "imagen"],
  vestidos: [
    "nombre",
    "categoria",
    "color",
    "talla",
    "precio",
    "imagen",
    "descripcion",
    "detalles",
    "evento_recomendado",
    "disponible",
    "activo",
  ],
};
for (const [entity, fields] of Object.entries(entities)) {
  app.get(`/api/${entity}`, requireAuth, requireRole("administrador", "empleado"), async (req, res) => {
    try {
      const search = req.query.buscar;
      const rows =
        entity === "clientes" && search
          ? await all(
              "SELECT * FROM clientes WHERE activo=1 AND (nombre LIKE ? OR telefono LIKE ? OR correo LIKE ?) ORDER BY id DESC",
              [`%${search}%`, `%${search}%`, `%${search}%`],
            )
          : entity === "clientes"
            ? await all("SELECT * FROM clientes WHERE activo=1 ORDER BY id DESC")
          : (entity === "servicios" || entity === "vestidos") && req.query.activos === "1"
            ? await all(`SELECT * FROM ${entity} WHERE activo=1 ORDER BY id DESC`)
            : await all(`SELECT * FROM ${entity} ORDER BY id DESC`);
      if (entity !== "vestidos") return res.json(rows);
      const gallery = rows.length
        ? await all(`SELECT id,vestido_id,ruta FROM vestido_imagenes WHERE vestido_id IN (${rows.map(() => "?").join(",")}) ORDER BY id`, rows.map((row) => row.id))
        : [];
      const byDress = new Map();
      for (const image of gallery) {
        const list = byDress.get(image.vestido_id) || [];
        list.push(image);
        byDress.set(image.vestido_id, list);
      }
      res.json(rows.map((row) => ({ ...row, imagenes: byDress.get(row.id) || [] })));
    } catch (value) {
      error(res, value);
    }
  });
  app.post(`/api/${entity}`, requireAuth, requireRole("administrador"), async (req, res) => {
    try {
      if (req.body.imagen) await resolvePublicImage(req.body.imagen);
      const values = fields.map((field) => req.body[field] ?? null);
      const saved = await run(
        `INSERT INTO ${entity} (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
        values,
      );
      res.status(201).json({ id: saved.id });
    } catch (value) {
      if (value.status === 400) return res.status(400).json({ error: value.message });
      error(res, value);
    }
  });
  app.put(`/api/${entity}/:id`, requireAuth, requireRole("administrador"), async (req, res) => {
    try {
      if (req.body.imagen) await resolvePublicImage(req.body.imagen);
      const values = fields.map((field) => req.body[field] ?? null);
      await run(
        `UPDATE ${entity} SET ${fields.map((field) => `${field}=?`).join(",")} WHERE id=?`,
        [...values, req.params.id],
      );
      res.json({ mensaje: "Actualizado" });
    } catch (value) {
      if (value.status === 400) return res.status(400).json({ error: value.message });
      error(res, value);
    }
  });
  app.delete(`/api/${entity}/:id`, requireAuth, requireRole("administrador"), async (req, res) => {
    try {
      if (entity === "servicios" || entity === "vestidos") {
        const related = await one(
          `SELECT COUNT(*) total FROM reservas WHERE ${entity === "servicios" ? "servicio_id" : "vestido_id"}=?`,
          [req.params.id],
        );
        if (Number(related.total)) {
          await run(`UPDATE ${entity} SET activo=0 WHERE id=?`, [req.params.id]);
          return res.json({ mensaje: "Registro desactivado. Se conservó para mantener el historial de reservas." });
        }
      }
      if (entity === "clientes") {
        const client = await one("SELECT id FROM clientes WHERE id=?", [req.params.id]);
        if (!client) return res.status(404).json({ error: "El cliente ya no existe." });
        const related = await one(
          "SELECT (SELECT COUNT(*) FROM reservas WHERE cliente_id=?) reservas,(SELECT COUNT(*) FROM pagos p JOIN reservas r ON r.id=p.reserva_id WHERE r.cliente_id=?) pagos,(SELECT COUNT(*) FROM cupones_cumpleanos WHERE cliente_id=?) cupones",
          [req.params.id, req.params.id, req.params.id],
        );
        if (Number(related.reservas) || Number(related.pagos) || Number(related.cupones)) {
          await run("UPDATE clientes SET activo=0 WHERE id=?", [req.params.id]);
          return res.json({ mensaje: "Cliente desactivado. Se conservó su historial de reservas y registros relacionados." });
        }
      }
      await run(`DELETE FROM ${entity} WHERE id=?`, [req.params.id]);
      res.json({ mensaje: entity === "clientes" ? "Cliente eliminado." : "Eliminado" });
    } catch (value) {
      error(res, value);
    }
  });
}

app.get("/api/usuarios", requireAuth, requireRole("administrador"), async (_, res) => {
  try {
    res.json(
      await all(
        "SELECT id,nombre,usuario,rol FROM usuarios_admin ORDER BY id DESC",
      ),
    );
  } catch (value) {
    error(res, value);
  }
});
app.post("/api/usuarios", requireAuth, requireRole("administrador"), async (req, res) => {
  try {
    const b = req.body;
    if (!b.nombre || !b.usuario || !b.contrasena)
      return res.status(400).json({ error: "Nombre, usuario y contraseña son obligatorios." });
    const rol = normalizeRole(b.rol || "empleado");
    if (!["administrador", "empleado", "cliente"].includes(rol))
      return res.status(400).json({ error: "Selecciona un rol válido." });
    const saved = await run(
      "INSERT INTO usuarios_admin(nombre,usuario,contrasena_hash,rol) VALUES(?,?,?,?)",
      [b.nombre, b.usuario, await bcrypt.hash(b.contrasena, 12), rol],
    );
    res.status(201).json({ id: saved.id });
  } catch (value) {
    error(res, value);
  }
});
app.put("/api/usuarios/:id", requireAuth, requireRole("administrador"), async (req, res) => {
  try {
    const b = req.body;
    if (!b.nombre || !b.usuario)
      return res.status(400).json({ error: "Nombre y usuario son obligatorios." });
    const rol = normalizeRole(b.rol);
    if (!["administrador", "empleado", "cliente"].includes(rol))
      return res.status(400).json({ error: "Selecciona un rol válido." });
    const values = [b.nombre, b.usuario, rol];
    let sql = "UPDATE usuarios_admin SET nombre=?,usuario=?,rol=?";
    if (b.contrasena) {
      sql += ",contrasena_hash=?";
      values.push(await bcrypt.hash(b.contrasena, 12));
    }
    values.push(req.params.id);
    await run(`${sql} WHERE id=?`, values);
    res.json({ mensaje: "Usuario actualizado" });
  } catch (value) {
    error(res, value);
  }
});
app.delete("/api/usuarios/:id", requireAuth, requireRole("administrador"), async (req, res) => {
  try {
    if (Number(req.params.id) === Number(req.user.id))
      return res.status(400).json({ error: "No puedes eliminar tu propia cuenta." });
    await run("DELETE FROM usuarios_admin WHERE id=?", [req.params.id]);
    res.json({ mensaje: "Usuario eliminado" });
  } catch (value) {
    error(res, value);
  }
});

app.get("/api/opciones/sucursales", requireAuth, requireRole("administrador", "empleado"), async (_, res) => {
  try {
    const existing = await all(
      "SELECT DISTINCT sucursal FROM reservas WHERE sucursal IS NOT NULL AND TRIM(sucursal)<>'' ORDER BY sucursal",
    );
    res.json([...new Set([...configuredServiceBranches, ...existing.map((row) => row.sucursal)])]);
  } catch (value) {
    error(res, value);
  }
});
app.get("/api/reservas/disponibilidad", requireAuth, requireRole("administrador", "empleado"), async (req, res) => {
  try {
    res.json(
      await reservationAvailability({
        tipo: req.query.tipo,
        fecha: req.query.fecha,
        hora: req.query.hora,
        sucursal: req.query.sucursal,
        fecha_evento: req.query.fecha_evento,
        servicio_id: req.query.servicio_id,
        vestido_id: req.query.vestido_id,
      }, req.query.excluir),
    );
  } catch (value) {
    error(res, value);
  }
});
app.get("/api/reservas", requireAuth, requireRole("administrador", "empleado"), async (_, res) => {
  try {
    const rows = await all(
      `SELECT r.*,c.nombre cliente,c.telefono cliente_telefono,c.correo cliente_correo,s.nombre servicio,s.precio servicio_precio,s.duracion_minutos,v.nombre vestido,v.talla vestido_talla,v.color vestido_color,v.precio vestido_precio,(SELECT COALESCE(SUM(p.monto),0) FROM pagos p WHERE p.reserva_id=r.id) pago_total,(SELECT p.estado FROM pagos p WHERE p.reserva_id=r.id ORDER BY p.fecha DESC LIMIT 1) pago_estado FROM reservas r JOIN clientes c ON c.id=r.cliente_id LEFT JOIN servicios s ON s.id=r.servicio_id LEFT JOIN vestidos v ON v.id=r.vestido_id ORDER BY r.fecha DESC,r.hora DESC`,
    );
    res.json(rows.map((row) => ({
      ...row,
      sucursal: row.tipo === "vestido" ? "Boutique Lía Vincenzo" : row.sucursal,
      codigo: codeForReservation(row.id),
      precio_reserva: row.tipo === "vestido" ? row.vestido_precio : row.servicio_precio,
    })));
  } catch (value) {
    error(res, value);
  }
});
app.get("/api/reportes/reservas", requireAuth, requireRole("administrador"), async (req, res) => {
  try {
    const from = String(req.query.desde || "");
    const to = String(req.query.hasta || "");
    const isDate = (value) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
    if (!isDate(from) || !isDate(to) || (from && to && from > to))
      return res.status(400).json({ error: "Selecciona un periodo válido." });
    const clauses = [];
    const params = [];
    const eventDateExpression = "COALESCE(r.fecha_evento,r.fecha)";
    if (from) { clauses.push(eventDateExpression + ">=?"); params.push(from); }
    if (to) { clauses.push(eventDateExpression + "<=?"); params.push(to); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await all(
      `SELECT r.id code_id,c.nombre cliente,r.tipo,s.nombre servicio,v.nombre vestido,COALESCE(r.fecha_evento,r.fecha) fecha_evento,r.hora,CASE WHEN r.tipo='vestido' THEN 'Boutique Lía Vincenzo' ELSE r.sucursal END sucursal,r.estado,CASE WHEN r.tipo='vestido' THEN v.precio ELSE s.precio END total,COALESCE((SELECT p2.estado FROM pagos p2 WHERE p2.reserva_id=r.id ORDER BY p2.fecha DESC LIMIT 1),'Sin pagos') estado_pago,(SELECT p2.fecha_recepcion FROM pagos p2 WHERE p2.reserva_id=r.id ORDER BY p2.fecha DESC LIMIT 1) fecha_pago,(SELECT COALESCE(SUM(p2.monto),0) FROM pagos p2 WHERE p2.reserva_id=r.id) monto_pago FROM reservas r JOIN clientes c ON c.id=r.cliente_id LEFT JOIN servicios s ON s.id=r.servicio_id LEFT JOIN vestidos v ON v.id=r.vestido_id ${where} ORDER BY COALESCE(r.fecha_evento,r.fecha),r.hora,r.id`,
      params,
    );
    const reservations = new Map(rows.map((row) => [String(row.code_id), row]));
    const summary = {
      reservas: reservations.size,
      servicios: [...reservations.values()].filter((row) => row.tipo === "servicio").length,
      vestidos: [...reservations.values()].filter((row) => row.tipo === "vestido").length,
      pendientes: [...reservations.values()].filter((row) => ["pendiente", "pendientes"].includes(String(row.estado || "").toLocaleLowerCase("es"))).length,
      confirmadas: [...reservations.values()].filter((row) => ["confirmada", "completada", "completado"].includes(String(row.estado || "").toLocaleLowerCase("es"))).length,
    };
    res.json({ desde: from || null, hasta: to || null, summary, rows: rows.map(({ code_id, ...row }) => ({ ...row, codigo: codeForReservation(code_id) })) });
  } catch (value) {
    error(res, value);
  }
});
app.get("/api/reportes/pagos", requireAuth, requireRole("administrador"), async (req, res) => {
  try {
    const from = String(req.query.desde || "");
    const to = String(req.query.hasta || "");
    if ((from && !isCalendarDate(from)) || (to && !isCalendarDate(to)) || (from && to && from > to))
      return res.status(400).json({ error: "Selecciona un periodo válido para el informe de pagos." });
    const clauses = [];
    const params = [];
    if (from) { clauses.push(`${paymentLocalDateExpression}>=?`); params.push(from); }
    if (to) { clauses.push(`${paymentLocalDateExpression}<=?`); params.push(to); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await all(
      `SELECT p.id,p.reserva_id,p.monto,p.tipo,p.metodo,p.estado,p.fecha,p.fecha_recepcion,
        c.nombre cliente,r.tipo reserva_tipo,COALESCE(r.fecha_evento,r.fecha) fecha_evento,
        r.hora,s.nombre servicio,v.nombre vestido,
        CASE WHEN r.tipo='vestido' THEN v.precio ELSE s.precio END total_reserva
       FROM pagos p JOIN reservas r ON r.id=p.reserva_id JOIN clientes c ON c.id=r.cliente_id
       LEFT JOIN servicios s ON s.id=r.servicio_id LEFT JOIN vestidos v ON v.id=r.vestido_id
       ${where} ORDER BY ${paymentLocalDateExpression},p.fecha,p.id`,
      params,
    );
    const legacy = await one("SELECT COUNT(*) total FROM pagos WHERE fecha_recepcion IS NULL");
    const summary = {
      pagos: rows.length,
      recibidos: rows.filter((row) => ["terminado", "terminada", "completado", "completada"].includes(String(row.estado).toLocaleLowerCase("es"))).length,
      pendientes: rows.filter((row) => String(row.estado).toLocaleLowerCase("es") === "pendiente").length,
      ingresos: rows.reduce((sum, row) => sum + (["terminado", "terminada", "completado", "completada"].includes(String(row.estado).toLocaleLowerCase("es")) ? Number(row.monto) || 0 : 0), 0),
      monto_total: rows.reduce((sum, row) => sum + (Number(row.monto) || 0), 0),
      historicos_sin_fecha: Number(legacy.total || 0),
    };
    res.json({ desde: from || null, hasta: to || null, summary, rows: rows.map((row) => ({ ...row, codigo_reserva: codeForReservation(row.reserva_id) })) });
  } catch (value) {
    error(res, value);
  }
});

app.get("/api/calendario", requireAuth, requireRole("administrador", "empleado"), async (req, res) => {
  try {
    const from = String(req.query.desde || "");
    const to = String(req.query.hasta || "");
    if (!isCalendarDate(from) || !isCalendarDate(to) || from > to)
      return res.status(400).json({ error: "El calendario requiere un rango de fechas válido." });
    const rows = await all(
      `SELECT r.id,r.tipo,r.fecha,r.fecha_evento,r.hora,r.estado,r.sucursal,r.notas,
        c.nombre cliente,c.telefono cliente_telefono,c.correo cliente_correo,
        s.nombre servicio,s.duracion_minutos,v.nombre vestido
       FROM reservas r JOIN clientes c ON c.id=r.cliente_id
       LEFT JOIN servicios s ON s.id=r.servicio_id LEFT JOIN vestidos v ON v.id=r.vestido_id
       WHERE COALESCE(r.fecha_evento,r.fecha)>=? AND COALESCE(r.fecha_evento,r.fecha)<=?
       ORDER BY COALESCE(r.fecha_evento,r.fecha),r.hora,r.id`,
      [from, to],
    );
    res.json(rows.map((row) => ({ ...row, fecha_calendario: row.tipo === "vestido" ? row.fecha_evento || row.fecha : row.fecha, sucursal: row.tipo === "vestido" ? "Boutique Lía Vincenzo" : row.sucursal, codigo: codeForReservation(row.id) })));
  } catch (value) {
    error(res, value);
  }
});

app.post("/api/reservas", requireAuth, requireRole("administrador", "empleado"), async (req, res) => {
  try {
    const b = req.body;
    if (!b.cliente_id || !b.fecha || !["servicio", "vestido"].includes(b.tipo))
      return res.status(400).json({ error: "Selecciona cliente, tipo y fecha para la reserva." });
    if (b.tipo === "servicio" && (!b.servicio_id || !b.hora))
      return res.status(400).json({ error: "Selecciona el servicio y el horario." });
    if (b.tipo === "vestido" && !b.vestido_id)
      return res.status(400).json({ error: "Selecciona el vestido." });
    if (b.tipo === "vestido" && b.fecha_evento && b.fecha_evento < b.fecha)
      return res.status(400).json({ error: "La fecha de uso debe ser igual o posterior a la fecha de reserva." });
    const status = b.estado || "pendiente";
    if (!["pendiente", "confirmada", "cancelada"].includes(status))
      return res.status(400).json({ error: "Selecciona un estado de reserva válido." });
    const result = await withReservationLock(() => withSqliteTransaction(async () => {
      const availability = status === "cancelada"
        ? { disponible: true }
        : await reservationAvailability({
        ...b,
        servicio_id: b.tipo === "servicio" ? b.servicio_id : null,
        vestido_id: b.tipo === "vestido" ? b.vestido_id : null,
        sucursal: b.tipo === "vestido" ? "Boutique Lía Vincenzo" : b.sucursal,
      });
      if (!availability.disponible) return { availability };
      const saved = await run(
        "INSERT INTO reservas(cliente_id,tipo,servicio_id,vestido_id,sucursal,fecha,fecha_evento,hora,estado,notas) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [b.cliente_id,b.tipo,b.tipo === "servicio" ? b.servicio_id : null,b.tipo === "vestido" ? b.vestido_id : null,b.tipo === "vestido" ? "Boutique Lía Vincenzo" : (b.sucursal || null),b.fecha,b.fecha_evento || null,b.hora || null,status,b.notas || null],
      );
      return { saved };
    }));
    if (result.availability)
      return res.status(409).json({ error: b.tipo === "vestido" ? "Este vestido ya fue reservado para esta fecha." : "Este espacio acaba de ser reservado. Actualiza la disponibilidad y selecciona otra opción." });
    res.status(201).json({ id: result.saved.id, codigo: codeForReservation(result.saved.id) });
  } catch (value) {
    error(res, value);
  }
});
app.put("/api/reservas/:id", requireAuth, requireRole("administrador", "empleado"), async (req, res) => {
  try {
    const b = req.body;
    if (!b.cliente_id || !b.fecha || !["servicio", "vestido"].includes(b.tipo))
      return res.status(400).json({ error: "Selecciona cliente, tipo y fecha para la reserva." });
    if (b.tipo === "servicio" && (!b.servicio_id || !b.hora))
      return res.status(400).json({ error: "Selecciona el servicio y el horario." });
    if (b.tipo === "vestido" && !b.vestido_id)
      return res.status(400).json({ error: "Selecciona el vestido." });
    if (b.tipo === "vestido" && b.fecha_evento && b.fecha_evento < b.fecha)
      return res.status(400).json({ error: "La fecha de uso debe ser igual o posterior a la fecha de reserva." });
    if (!["pendiente", "confirmada", "cancelada"].includes(b.estado))
      return res.status(400).json({ error: "Selecciona un estado de reserva válido." });
    const result = await withReservationLock(() => withSqliteTransaction(async () => {
      const availability = b.estado === "cancelada"
        ? { disponible: true }
        : await reservationAvailability({
        ...b,
        servicio_id: b.tipo === "servicio" ? b.servicio_id : null,
        vestido_id: b.tipo === "vestido" ? b.vestido_id : null,
        sucursal: b.tipo === "vestido" ? "Boutique Lía Vincenzo" : b.sucursal,
      }, req.params.id);
      if (!availability.disponible) return { availability };
      const updated = await run(
        "UPDATE reservas SET cliente_id=?,tipo=?,servicio_id=?,vestido_id=?,sucursal=?,fecha=?,fecha_evento=?,hora=?,estado=?,notas=? WHERE id=?",
        [b.cliente_id,b.tipo,b.tipo === "servicio" ? b.servicio_id : null,b.tipo === "vestido" ? b.vestido_id : null,b.tipo === "vestido" ? "Boutique Lía Vincenzo" : (b.sucursal || null),b.fecha,b.fecha_evento || null,b.hora || null,b.estado,b.notas || null,req.params.id],
      );
      if (!updated.changes) return { missing: true };
      return { updated: true };
    }));
    if (result.availability)
      return res.status(409).json({ error: b.tipo === "vestido" ? "Este vestido ya fue reservado para esta fecha." : "Este espacio acaba de ser reservado. Actualiza la disponibilidad y selecciona otra opción." });
    if (result.missing) return res.status(404).json({ error: "No se encontró la reserva que intentas actualizar." });
    res.json({ mensaje: "Reserva actualizada correctamente." });
  } catch (value) {
    error(res, value);
  }
});
app.delete("/api/reservas/:id", requireAuth, requireRole("administrador"), async (req, res) => {
  try {
    await run("DELETE FROM reservas WHERE id=?", [req.params.id]);
    res.json({ mensaje: "Eliminada" });
  } catch (value) {
    error(res, value);
  }
});

app.get("/api/pagos", requireAuth, requireRole("administrador"), async (req, res) => {
  try {
    const from = String(req.query.desde || "");
    const to = String(req.query.hasta || "");
    if ((from && !isCalendarDate(from)) || (to && !isCalendarDate(to)) || (from && to && from > to))
      return res.status(400).json({ error: "Selecciona un periodo válido para filtrar pagos." });
    const clauses = [];
    const params = [];
    if (from) { clauses.push(`${paymentLocalDateExpression}>=?`); params.push(from); }
    if (to) { clauses.push(`${paymentLocalDateExpression}<=?`); params.push(to); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await all(
      `SELECT p.*,c.nombre cliente,r.id reserva_id,r.tipo reserva_tipo,s.nombre servicio,v.nombre vestido,CASE WHEN r.tipo='vestido' THEN v.precio ELSE s.precio END precio_reserva,(SELECT COALESCE(SUM(p2.monto),0) FROM pagos p2 WHERE p2.reserva_id=r.id) pago_total FROM pagos p JOIN reservas r ON r.id=p.reserva_id JOIN clientes c ON c.id=r.cliente_id LEFT JOIN servicios s ON s.id=r.servicio_id LEFT JOIN vestidos v ON v.id=r.vestido_id ${where} ORDER BY ${paymentLocalDateExpression} DESC,p.fecha DESC`,
      params,
    );
    res.json(rows.map((row) => ({ ...row, fecha_pago: row.fecha_recepcion, fecha_registro: row.fecha, codigo_reserva: codeForReservation(row.reserva_id) })));
  } catch (value) {
    error(res, value);
  }
});
async function validatePayment(payment, excludePaymentId = null) {
  if (!["Efectivo", "QR"].includes(payment.metodo))
    return "Selecciona un método de pago válido.";
  if (!["Anticipo", "Pago final"].includes(payment.tipo))
    return "El tipo de pago debe ser Anticipo o Pago final.";
  if (!["Pendiente", "Terminado"].includes(payment.estado || "Pendiente"))
    return "El estado del pago debe ser Pendiente o Terminado.";
  if ((payment.estado || "Pendiente") === "Terminado" && !isCalendarDate(payment.fecha_recepcion))
    return "Indica la fecha real en que se recibió el pago terminado.";
  if (payment.fecha_recepcion && !isCalendarDate(payment.fecha_recepcion))
    return "La fecha de recepción no es válida.";
  const amountText = String(payment.monto ?? "").trim();
  const amount = /^\d+(?:[.,]\d{1,2})?$/.test(amountText)
    ? Number(amountText.replace(",", "."))
    : NaN;
  if (!Number.isFinite(amount) || amount <= 0)
    return "El monto debe ser mayor que cero.";
  const booking = await one(
    "SELECT r.id,CASE WHEN r.tipo='vestido' THEN v.precio ELSE s.precio END precio FROM reservas r LEFT JOIN servicios s ON s.id=r.servicio_id LEFT JOIN vestidos v ON v.id=r.vestido_id WHERE r.id=?",
    [payment.reserva_id],
  );
  if (!booking) return "Selecciona una reserva existente.";
  const totalQuery = excludePaymentId
    ? "SELECT COALESCE(SUM(monto),0) total FROM pagos WHERE reserva_id=? AND id<>?"
    : "SELECT COALESCE(SUM(monto),0) total FROM pagos WHERE reserva_id=?";
  const paid = await one(
    totalQuery,
    excludePaymentId ? [payment.reserva_id, excludePaymentId] : [payment.reserva_id],
  );
  const catalogPrice = Number(booking.precio) || 0;
  const balance = Math.max(0, catalogPrice - Number(paid.total || 0));
  if (catalogPrice > 0 && amount > balance + 0.01)
    return `El monto supera el saldo del precio de catálogo (Bs ${balance.toFixed(2)}).`;
  if (catalogPrice > 0 && payment.tipo === "Pago final" && Math.abs(amount - balance) > 0.01)
    return `El pago final debe cubrir el saldo del catálogo (Bs ${balance.toFixed(2)}).`;
  return null;
}
app.post("/api/pagos", requireAuth, requireRole("administrador"), async (req, res) => {
  try {
    const b = req.body;
    const validation = await validatePayment(b);
    if (validation) return res.status(400).json({ error: validation });
    const saved = await run(
      "INSERT INTO pagos(reserva_id,monto,tipo,metodo,estado,fecha_recepcion) VALUES(?,?,?,?,?,?)",
      [b.reserva_id, Number(String(b.monto).trim().replace(",", ".")), b.tipo, b.metodo, b.estado || "Pendiente", (b.estado || "Pendiente") === "Terminado" ? b.fecha_recepcion : null],
    );
    res.status(201).json({ id: saved.id });
  } catch (value) {
    error(res, value);
  }
});
app.put("/api/pagos/:id", requireAuth, requireRole("administrador"), async (req, res) => {
  try {
    const b = req.body;
    const existing = await one("SELECT id,estado FROM pagos WHERE id=?", [req.params.id]);
    if (!existing) return res.status(404).json({ error: "No se encontró el pago." });
    if (String(existing.estado || "").trim().toLocaleLowerCase("es") !== "pendiente")
      return res.status(409).json({ error: "Los pagos terminados están protegidos y no se pueden editar." });
    const validation = await validatePayment(b, req.params.id);
    if (validation) return res.status(400).json({ error: validation });
    const updated = await run(
      "UPDATE pagos SET reserva_id=?,monto=?,tipo=?,metodo=?,estado=?,fecha_recepcion=? WHERE id=? AND LOWER(TRIM(estado))='pendiente'",
      [b.reserva_id, Number(String(b.monto).trim().replace(",", ".")), b.tipo, b.metodo || null, b.estado, b.estado === "Terminado" ? b.fecha_recepcion : null, req.params.id],
    );
    if (!updated.changes) {
      const current = await one("SELECT estado FROM pagos WHERE id=?", [req.params.id]);
      if (!current) return res.status(404).json({ error: "No se encontró el pago." });
      if (String(current.estado || "").trim().toLocaleLowerCase("es") !== "pendiente")
        return res.status(409).json({ error: "El pago cambió de estado y ya no se puede editar." });
    }
    res.json({ mensaje: "Pago actualizado" });
  } catch (value) {
    error(res, value);
  }
});
app.delete("/api/pagos/:id", requireAuth, requireRole("administrador"), async (req, res) => {
  try {
    const removed = await run(
      "DELETE FROM pagos WHERE id=? AND LOWER(TRIM(estado))='pendiente'",
      [req.params.id],
    );
    if (!removed.changes) {
      const existing = await one("SELECT id FROM pagos WHERE id=?", [req.params.id]);
      return existing
        ? res.status(409).json({ error: "Los pagos terminados están protegidos y no se pueden eliminar." })
        : res.status(404).json({ error: "No se encontró el pago." });
    }
    res.json({ mensaje: "Pago eliminado" });
  } catch (value) {
    error(res, value);
  }
});

app.get("/api/cumpleanos/hoy", requireAuth, requireRole("administrador"), async (_, res) => {
  try {
    const clients = await all(
      "SELECT * FROM clientes WHERE activo=1 AND strftime('%m-%d',fecha_nacimiento)=strftime('%m-%d','now','localtime')",
    );
    const coupons = [];
    for (const client of clients) {
      let coupon = await one(
        "SELECT * FROM cupones_cumpleanos WHERE cliente_id=? AND date(fecha_generacion)=date('now','localtime')",
        [client.id],
      );
      if (!coupon) {
        const code = `FELIZ${client.id}${new Date().getFullYear()}`;
        const saved = await run(
          "INSERT INTO cupones_cumpleanos(cliente_id,codigo,descuento) VALUES(?,?,?)",
          [client.id, code, 15],
        );
        coupon = { id: saved.id, codigo: code, descuento: 15 };
      }
      coupons.push({
        cliente: client.nombre,
        telefono: client.telefono,
        correo: client.correo,
        codigo: coupon.codigo,
        descuento: coupon.descuento,
        mensaje: `¡Feliz cumpleaños, ${client.nombre}! Il Salone Lia Vincenzo te regala ${coupon.descuento}% de descuento. Usa el código ${coupon.codigo}.`,
      });
    }
    res.json(coupons);
  } catch (value) {
    error(res, value);
  }
});

app.post("/api/internal/cumpleanos/procesar", async (req, res) => {
  const expected = process.env.BIRTHDAY_CRON_SECRET || "";
  const received = req.get("x-cron-secret") || "";
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  if (!expected || expectedBuffer.length !== receivedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, receivedBuffer))
    return res.status(403).json({ error: "No autorizado." });
  try {
    res.json(await processBirthdayPromotions());
  } catch (value) {
    error(res, value);
  }
});

app.use("/api", (value, req, res, next) => {
  if (res.headersSent) return next(value);
  const status = Number(value.status) >= 400 ? Number(value.status) : 500;
  res.status(status).json({
    error: status < 500 ? value.message : "No se pudo procesar la solicitud de la API.",
  });
});
app.use("/api", (req, res) => {
  res.status(404).json({ error: `Ruta API no encontrada: ${req.method} ${req.path}` });
});

setup()
  .then(() =>
    app.listen(port, "0.0.0.0", () =>
      console.log(`Il Salone activo en http://localhost:${port}`),
    ),
  )
  .catch(console.error);
