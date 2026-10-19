const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const databasePath = process.env.SQLITE_PATH || path.join(__dirname, "..", "database.db");
const db = new sqlite3.Database(databasePath);
db.configure("busyTimeout", 5000);
const all = (sql, values = []) => new Promise((resolve, reject) => db.all(sql, values, (error, rows) => error ? reject(error) : resolve(rows)));
const run = (sql, values = []) => new Promise((resolve, reject) => db.run(sql, values, function (error) { error ? reject(error) : resolve({ id: this.lastID, changes: this.changes }); }));

const offerings = [
  { nombre: "Peinado", precio: 90, duracion_minutos: 90, descripcion: "Diseños que armonizan con tu rostro, estilo y rutina.", imagen: "imagenes/galeriasyotros/Screenshot_20260818-230305~2.jpg corte de cabello.jpeg" },
  { nombre: "Maquillaje social", precio: 150, duracion_minutos: 60, descripcion: "Preparación de piel y maquillaje de larga duración adaptado a tu evento, vestuario y personalidad.", imagen: "imagenes/galeriasyotros/494008297_1439295197397169_95293583963074765_n.jpg" },
  { nombre: "Maquillaje folklorico", precio: 150, duracion_minutos: 60, descripcion: "Un look que potencia tus rasgos para eventos especiales.", imagen: "imagenes/galeriasyotros/copi.jpg" },
  { nombre: "Facial", precio: 120, duracion_minutos: 75, descripcion: "Diagnóstico de piel, limpieza profunda e hidratación según las necesidades de tu rostro.", imagen: "imagenes/galeriasyotros/facial.jpeg" },
  { nombre: "Color & Balayage", precio: 250, duracion_minutos: 240, descripcion: "Incluye diagnóstico de color, aplicación técnica, lavado y peinado final. El precio varía según largo y base del cabello.", imagen: "imagenes/galeriasyotros/Screenshot_20260818-224437.jpg.jpeg" },
  { nombre: "Corte & Peinado", precio: 90, duracion_minutos: 90, descripcion: "Asesoría de imagen, corte personalizado, lavado y peinado profesional para llevar tu estilo con confianza.", imagen: "imagenes/galeriasyotros/Screenshot_20260818-225904.png" },
  { nombre: "Manicure & Pedicure", precio: 70, duracion_minutos: 90, descripcion: "Limpieza, hidratación, esmaltado y diseño opcional para manos y pies perfectamente cuidados.", imagen: "imagenes/galeriasyotros/756612835_1588133952855711_4353477909330351086_n.webp" },
];

(async () => {
  await run("PRAGMA busy_timeout=5000");
  await run("BEGIN IMMEDIATE");
  let inserted = 0;
  let updated = 0;
  try {
    for (const service of offerings) {
      const existing = await all("SELECT id FROM servicios WHERE lower(trim(nombre))=lower(trim(?)) ORDER BY id LIMIT 1", [service.nombre]);
      if (existing.length) {
        await run("UPDATE servicios SET descripcion=CASE WHEN descripcion IS NULL OR trim(descripcion)='' THEN ? ELSE descripcion END,precio=CASE WHEN precio IS NULL OR precio=0 THEN ? ELSE precio END,duracion_minutos=CASE WHEN duracion_minutos IS NULL OR duracion_minutos=0 THEN ? ELSE duracion_minutos END,imagen=COALESCE(NULLIF(imagen,''),?) WHERE id=?", [service.descripcion,service.precio,service.duracion_minutos,service.imagen,existing[0].id]);
        updated++;
      } else {
        await run("INSERT INTO servicios(nombre,descripcion,precio,duracion_minutos,activo,imagen) VALUES(?,?,?,?,1,?)", [service.nombre,service.descripcion,service.precio,service.duracion_minutos,service.imagen]);
        inserted++;
      }
    }
    await run("UPDATE servicios SET activo=0 WHERE nombre GLOB 'Servicio [0-9a-fA-F]*' AND precio=0 AND duracion_minutos IS NULL");
    await run("COMMIT");
    const active = await all("SELECT id,nombre,precio,duracion_minutos,activo,imagen FROM servicios WHERE activo=1 ORDER BY id");
    console.log(JSON.stringify({ inserted, completedExisting: updated, activeServices: active.length, services: active }, null, 2));
  } catch (error) {
    await run("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    db.close();
  }
})().catch((error) => {
  console.error("No se pudo sincronizar la oferta pública de servicios:", error.message);
  process.exitCode = 1;
});
