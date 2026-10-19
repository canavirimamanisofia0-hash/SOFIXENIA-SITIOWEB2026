const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const root = path.join(__dirname, "..");
const databasePath = process.env.SQLITE_PATH || path.join(root, "database.db");
const html = fs.readFileSync(path.join(root, "catalogo.html"), "utf8");
const firstScript = html.search(/<script\b/i);
const catalogMarkup = firstScript >= 0 ? html.slice(0, firstScript) : html;
const catalogScript = html.slice(html.indexOf("const noviaNames ="));
const getNameList = (name) => {
  const match = catalogScript.match(new RegExp(`const ${name} = (\\[[^;]+\\]);`));
  return match ? JSON.parse(match[1]) : [];
};
const noviaNames = getNameList("noviaNames");
const pasarelaNames = getNameList("pasarelaNames");
const attribute = (source, name) => {
  const match = source.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1].replaceAll("&amp;", "&").replaceAll("&#39;", "'") : "";
};
const decode = (value) => value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const products = [];
let noviaIndex = 0;
let pasarelaIndex = 0;
const cardPattern = /<div class="col-md-6 col-lg-4 dress"([^>]*)>([\s\S]*?<\/article>)/g;
for (const match of catalogMarkup.matchAll(cardPattern)) {
  const attrs = match[1];
  const body = match[2];
  const category = decode(attribute(attrs, "data-category"));
  let name = decode(attribute(attrs, "data-name"));
  if (category.toLowerCase() === "pasarela") name = pasarelaNames[pasarelaIndex++] || name;
  else if (category.toLowerCase() === "novia") name = noviaNames[noviaIndex++] || name;
  const imageMatch = body.match(/class="product-image-wrap"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"/);
  const image = imageMatch ? decode(imageMatch[1]) : "";
  if (!name || !image) continue;
  products.push({
    nombre: name,
    categoria: category || "Vestido",
    color: decode(attribute(attrs, "data-color")),
    talla: decode(attribute(attrs, "data-size")),
    precio: Number(attribute(attrs, "data-price")) || 0,
    imagen: image,
    disponible: 1,
    activo: 1,
  });
}

const db = new sqlite3.Database(databasePath);
db.configure("busyTimeout", 5000);
const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) { error ? reject(error) : resolve({ id: this.lastID, changes: this.changes }); }));
const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));

(async () => {
  await run("PRAGMA foreign_keys=ON");
  await run("BEGIN IMMEDIATE");
  let added = 0;
  let linked = 0;
  try {
    for (const product of products) {
      const byImage = await all("SELECT id FROM vestidos WHERE imagen=? ORDER BY id LIMIT 1", [product.imagen]);
      if (byImage.length) continue;
      const sameName = await all("SELECT id,imagen FROM vestidos WHERE nombre=? ORDER BY id", [product.nombre]);
      const legacy = sameName.find((item) => !item.imagen);
      if (legacy) {
        await run("UPDATE vestidos SET categoria=?,color=?,talla=?,precio=?,imagen=? WHERE id=?", [product.categoria,product.color,product.talla,product.precio,product.imagen,legacy.id]);
        linked++;
        continue;
      }
      await run("INSERT INTO vestidos(nombre,categoria,color,talla,precio,imagen,disponible,activo) VALUES(?,?,?,?,?,?,?,?)", [product.nombre,product.categoria,product.color,product.talla,product.precio,product.imagen,product.disponible,product.activo]);
      added++;
    }
    await run("COMMIT");
    console.log(JSON.stringify({ sourceCards: products.length, added, linked, skippedDuplicateImages: products.length - added - linked }, null, 2));
  } catch (error) {
    await run("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    db.close();
  }
})().catch((error) => {
  console.error("No se pudo importar el catálogo existente:", error.message);
  process.exitCode = 1;
});
