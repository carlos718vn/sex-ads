// Sex ads — servidor público independiente.
// Directorio de modelos: el cliente ve las chicas y les escribe directo por
// WhatsApp; la chica se registra (crea una invitación pendiente) y el admin
// la aprueba; el admin también agrega modelos directo.
// Node.js, sin framework: solo el módulo `http` incorporado y `@libsql/client`.
// API: POST /actions  {action, args} -> {ok:true,...} | {ok:false, error:"..."}
// Fotos: GET /foto/:id sirve el blob guardado en la base de datos.
// Estáticos: sirve ../client/ en /.
// Zona horaria de negocio: America/Santo_Domingo (UTC-4).
//
// Base de datos (una sola vía de acceso, variable de entorno):
//   - Si TURSO_DATABASE_URL está definido -> Turso (libSQL remoto, persistente).
//     Requiere TURSO_AUTH_TOKEN. Es la base de producción en Render.
//   - Si no -> archivo SQLite local con el mismo cliente libSQL
//     (DB_PATH o sexads.db junto a este archivo). Es lo que usan las pruebas
//     (DB_PATH=sexads.test.db) y el desarrollo local.
// El dialecto SQL es SQLite en los dos modos, así que el esquema y las
// consultas son idénticas. Todas las operaciones de base de datos son
// asíncronas (el cliente libSQL no tiene API síncrona).

import http from 'node:http';
import { createClient } from '@libsql/client';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sexads.db');
const TURSO_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
const PORT = parseInt(process.env.PORT || '8080', 10);
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const SEED_DIR = path.join(__dirname, 'seed');
const TZ = 'America/Santo_Domingo';
const MAX_BODY = 20 * 1024 * 1024; // 20 MB (fotos base64 tras comprimir en el cliente)
const MAX_FOTOS_POR_CHICA = 30;
const MAX_FOTO_BYTES = 5 * 1024 * 1024; // 5 MB por foto ya decodificada

// ---------------------------------------------------------------------------
// Tiempo (Santo Domingo)
// ---------------------------------------------------------------------------
function sdNow(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  const fecha = `${parts.year}-${parts.month}-${parts.day}`;
  const hora = `${parts.hour}:${parts.minute}:${parts.second}`;
  return { fecha, hora, stamp: `${fecha} ${hora}` };
}

// ---------------------------------------------------------------------------
// Base de datos (adaptador libSQL)
// ---------------------------------------------------------------------------
const client = TURSO_URL
  ? createClient({ url: TURSO_URL, authToken: TURSO_TOKEN || undefined })
  : createClient({ url: 'file:' + path.resolve(DB_PATH) });

// libSQL devuelve lastInsertRowid como bigint y las filas como objetos.
const db = {
  async exec(sql) { await client.executeMultiple(sql); },
  prepare(sql) {
    return {
      async run(...args) {
        const r = await client.execute({ sql, args });
        return {
          lastInsertRowid: r.lastInsertRowid === undefined || r.lastInsertRowid === null
            ? undefined : Number(r.lastInsertRowid),
          changes: r.rowsAffected,
        };
      },
      async get(...args) { const r = await client.execute({ sql, args }); return r.rows[0] || null; },
      async all(...args) { const r = await client.execute({ sql, args }); return r.rows; },
    };
  },
};

function err(msg) { const e = new Error(msg); e.isApp = true; return e; }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  usuario TEXT UNIQUE NOT NULL,
  contrasena TEXT NOT NULL,
  rol TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chicas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  descripcion TEXT NOT NULL DEFAULT '',
  telefono TEXT NOT NULL DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'pendiente',
  origen TEXT NOT NULL DEFAULT 'registro',
  creado_en TEXT NOT NULL,
  edad INTEGER,
  genero TEXT NOT NULL DEFAULT '',
  tipo_cuerpo TEXT NOT NULL DEFAULT '',
  altura TEXT NOT NULL DEFAULT '',
  etnicidad TEXT NOT NULL DEFAULT '',
  talla_copa TEXT NOT NULL DEFAULT '',
  color_cabello TEXT NOT NULL DEFAULT '',
  color_ojos TEXT NOT NULL DEFAULT '',
  talla_calzado TEXT NOT NULL DEFAULT '',
  idiomas TEXT NOT NULL DEFAULT '',
  ubicacion TEXT NOT NULL DEFAULT '',
  se_adapta_a TEXT NOT NULL DEFAULT '',
  disponibilidad TEXT NOT NULL DEFAULT '{"lunes":"todo","martes":"todo","miercoles":"todo","jueves":"todo","viernes":"todo","sabado":"todo","domingo":"todo"}',
  servicios TEXT NOT NULL DEFAULT '[]',
  movil TEXT NOT NULL DEFAULT '',
  redes TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS fotos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chica_id INTEGER NOT NULL,
  datos BLOB NOT NULL,
  mime TEXT NOT NULL DEFAULT 'image/jpeg',
  es_principal INTEGER NOT NULL DEFAULT 0,
  creado_en TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL,
  creado_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fotos_chica ON fotos(chica_id);
CREATE INDEX IF NOT EXISTS idx_chicas_estado ON chicas(estado);
`;

// Normaliza un número a solo dígitos para wa.me. RD (10 dígitos) -> prefijo 1.
function normTelefono(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10) return '1' + d;
  return d;
}
function waLink(telefono) {
  const d = normTelefono(telefono);
  return d ? `https://wa.me/${d}` : null;
}
function validarTelefono(raw, obligatorio) {
  const d = normTelefono(raw);
  if (!d) {
    if (obligatorio) throw err('Falta el número de WhatsApp.');
    return '';
  }
  if (d.length < 10 || d.length > 15) throw err('El número de WhatsApp no es válido.');
  return d;
}
function validarFotos(fotos, obligatorio) {
  const lista = Array.isArray(fotos) ? fotos : [];
  if (obligatorio && lista.length === 0) throw err('Sube al menos una foto.');
  if (lista.length > MAX_FOTOS_POR_CHICA) throw err(`Máximo ${MAX_FOTOS_POR_CHICA} fotos por perfil.`);
  return lista.map((f) => {
    const mime = String(f.mime || 'image/jpeg');
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) throw err('Solo se aceptan fotos JPG, PNG o WebP.');
    const buf = Buffer.from(String(f.b64 || ''), 'base64');
    if (buf.length === 0) throw err('Una foto llegó vacía.');
    if (buf.length > MAX_FOTO_BYTES) throw err('Una foto es muy pesada (máximo 5 MB).');
    return { buf, mime };
  });
}
async function insertFotos(chicaId, fotos, ahora) {
  for (let i = 0; i < fotos.length; i++) {
    const esPrincipal = i === 0 ? 1 : 0;
    await db.prepare(
      'INSERT INTO fotos (chica_id, datos, mime, es_principal, creado_en) VALUES (?, ?, ?, ?, ?)'
    ).run(chicaId, fotos[i].buf, fotos[i].mime, esPrincipal, ahora);
  }
}
async function fotoCover(chicaId) {
  const row = await db.prepare(
    "SELECT id FROM fotos WHERE chica_id = ? ORDER BY es_principal DESC, id ASC LIMIT 1"
  ).get(chicaId);
  return row ? `/foto/${row.id}` : null;
}
async function fotoCount(chicaId) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM fotos WHERE chica_id = ?').get(chicaId);
  return Number(row?.n || 0);
}
// ---------------------------------------------------------------------------
// Datos del perfil estilo Tryst (todos opcionales) + disponibilidad +
// servicios con tarifas + contacto/redes.
// ---------------------------------------------------------------------------
const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const DISP_TODO = Object.fromEntries(DIAS.map((d) => [d, 'todo']));
function parseJSON(str, fb) {
  try { const v = JSON.parse(str || ''); return v ?? fb; } catch { return fb; }
}
function normDisponibilidad(input, base) {
  const out = { ...(base || DISP_TODO) };
  const src = input && typeof input === 'object' ? input : {};
  for (const d of DIAS) {
    if (src[d] === 'todo' || src[d] === 'no') out[d] = src[d];
  }
  return out;
}
function normServicios(input) {
  const lista = Array.isArray(input) ? input : [];
  return lista.slice(0, 10).map((s) => ({
    nombre: String(s?.nombre || '').trim().slice(0, 80),
    precio: String(s?.precio || '').trim().slice(0, 40),
    nota: String(s?.nota || '').trim().slice(0, 200),
  })).filter((s) => s.nombre);
}
function normRedes(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const key = String(k).trim().slice(0, 30);
    const val = String(v || '').trim().slice(0, 200);
    if (key && val) out[key] = val;
  }
  return out;
}
// Columnas del perfil (en orden) para INSERT/UPDATE.
const PERFIL_COLS = ['edad', 'genero', 'tipo_cuerpo', 'altura', 'etnicidad', 'talla_copa',
  'color_cabello', 'color_ojos', 'talla_calzado', 'idiomas', 'ubicacion', 'se_adapta_a',
  'disponibilidad', 'servicios', 'movil', 'redes'];
const PERFIL_TEXTO = {
  genero: 40, tipo_cuerpo: 40, altura: 20, etnicidad: 40, talla_copa: 10,
  color_cabello: 30, color_ojos: 30, talla_calzado: 10, idiomas: 120,
  ubicacion: 120, se_adapta_a: 120,
};
function perfilVals(p) {
  return PERFIL_COLS.map((k) => {
    if (k === 'disponibilidad' || k === 'servicios' || k === 'redes') return JSON.stringify(p[k]);
    return p[k];
  });
}
// Normaliza los campos del perfil. `base` es la fila existente (al editar)
// o null (al crear). Los campos no enviados conservan el valor de `base`.
function normPerfil(args, base) {
  const get = (k) => (args[k] !== undefined && args[k] !== null ? args[k] : (base ? base[k] : undefined));
  const out = {};
  const edadRaw = get('edad');
  let edad = null;
  if (edadRaw !== undefined && edadRaw !== null && String(edadRaw).trim() !== '') {
    const n = Number(edadRaw);
    if (!Number.isInteger(n) || n < 18 || n > 99) throw err('La edad debe ser un número entre 18 y 99.');
    edad = n;
  }
  out.edad = edad;
  for (const [k, max] of Object.entries(PERFIL_TEXTO)) {
    const v = get(k);
    out[k] = v === undefined || v === null ? '' : String(v).trim().slice(0, max);
  }
  const movilRaw = get('movil');
  out.movil = movilRaw === undefined || movilRaw === null ? '' : String(movilRaw).trim().slice(0, 20);
  out.disponibilidad = normDisponibilidad(
    args.disponibilidad, base ? parseJSON(base.disponibilidad, DISP_TODO) : DISP_TODO);
  out.servicios = args.servicios !== undefined ? normServicios(args.servicios)
    : (base ? parseJSON(base.servicios, []) : []);
  out.redes = args.redes !== undefined ? normRedes(args.redes)
    : (base ? parseJSON(base.redes, {}) : {});
  return out;
}
// Migración sin borrar datos: agrega las columnas nuevas a `chicas` si faltan.
// En bases nuevas la tabla ya las trae del SCHEMA; en la base viva de Turso
// (donde la tabla existe desde antes) las agrega con su valor por defecto.
async function migrate() {
  const cols = await db.prepare('PRAGMA table_info(chicas)').all();
  const have = new Set(cols.map((c) => c.name));
  const dispDef = JSON.stringify(DISP_TODO).replace(/'/g, "''");
  const adds = [
    ['edad', 'INTEGER'],
    ['genero', 'TEXT'], ['tipo_cuerpo', 'TEXT'], ['altura', 'TEXT'],
    ['etnicidad', 'TEXT'], ['talla_copa', 'TEXT'], ['color_cabello', 'TEXT'],
    ['color_ojos', 'TEXT'], ['talla_calzado', 'TEXT'], ['idiomas', 'TEXT'],
    ['ubicacion', 'TEXT'], ['se_adapta_a', 'TEXT'],
    ['disponibilidad', `TEXT NOT NULL DEFAULT '${dispDef}'`],
    ['servicios', `TEXT NOT NULL DEFAULT '[]'`],
    ['movil', 'TEXT'],
    ['redes', `TEXT NOT NULL DEFAULT '{}'`],
  ];
  for (const [name, def] of adds) {
    if (!have.has(name)) await db.exec(`ALTER TABLE chicas ADD COLUMN ${name} ${def}`);
  }
}

function publicChica(c, cover, count) {
  return {
    id: c.id, nombre: c.nombre, descripcion: c.descripcion,
    telefono: c.telefono, whatsapp: waLink(c.telefono),
    estado: c.estado, origen: c.origen, creado_en: c.creado_en,
    foto: cover, foto_count: count,
    edad: c.edad ?? null,
    genero: c.genero || '', tipo_cuerpo: c.tipo_cuerpo || '', altura: c.altura || '',
    etnicidad: c.etnicidad || '', talla_copa: c.talla_copa || '',
    color_cabello: c.color_cabello || '', color_ojos: c.color_ojos || '',
    talla_calzado: c.talla_calzado || '', idiomas: c.idiomas || '',
    ubicacion: c.ubicacion || '', se_adapta_a: c.se_adapta_a || '',
    disponibilidad: parseJSON(c.disponibilidad, DISP_TODO),
    servicios: parseJSON(c.servicios, []),
    movil: c.movil || '', redes: parseJSON(c.redes, {}),
  };
}

// Semilla: admin + primera modelo con las dos fotos que mandó el usuario.
// Idempotente: solo siembra si la base está vacía. Nunca pisa datos del admin.
async function seed() {
  const n = await db.prepare('SELECT COUNT(*) AS n FROM usuarios').get();
  if (Number(n?.n || 0) > 0) return;
  const ahora = sdNow().stamp;
  await db.prepare(
    "INSERT INTO usuarios (nombre, usuario, contrasena, rol, activo, creado_en) VALUES (?, 'admin', ?, 'admin', 1, ?)"
  ).run('Admin', sha256('admin'), ahora);
  const chica = await db.prepare(
    "INSERT INTO chicas (nombre, descripcion, telefono, estado, origen, creado_en) VALUES (?, ?, '', 'aprobada', 'admin', ?)"
  ).run('Primera modelo', 'Edita esta descripción desde el panel de admin.', ahora);
  const chicaId = Number(chica.lastInsertRowid);
  const seedFotos = ['foto1.jpg', 'foto2.jpg'];
  for (let i = 0; i < seedFotos.length; i++) {
    const p = path.join(SEED_DIR, seedFotos[i]);
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    await db.prepare(
      'INSERT INTO fotos (chica_id, datos, mime, es_principal, creado_en) VALUES (?, ?, ?, ?, ?)'
    ).run(chicaId, buf, 'image/jpeg', i === 0 ? 1 : 0, ahora);
  }
  console.log(`[seed] admin creado, primera modelo id=${chicaId}`);
}

async function getAdminByToken(token) {
  if (!token) throw err('Sesión no válida. Inicia sesión de nuevo.');
  const ses = await db.prepare('SELECT usuario_id FROM sesiones WHERE token = ?').get(token);
  if (!ses) throw err('Sesión no válida. Inicia sesión de nuevo.');
  const u = await db.prepare("SELECT * FROM usuarios WHERE id = ? AND rol = 'admin' AND activo = 1").get(ses.usuario_id);
  if (!u) throw err('Sesión no válida. Inicia sesión de nuevo.');
  return u;
}

// ---------------------------------------------------------------------------
// Acciones (POST /actions)
// ---------------------------------------------------------------------------
const actions = {
  async loginAdmin(args) {
    const u = await db.prepare('SELECT * FROM usuarios WHERE usuario = ?').get(String(args.usuario || '').trim());
    if (!u || u.contrasena !== sha256(args.contrasena || '') || !u.activo) {
      throw err('Usuario o contraseña incorrectos.');
    }
    const ahora = sdNow().stamp;
    const token = crypto.randomBytes(32).toString('hex');
    await db.prepare('INSERT INTO sesiones (token, usuario_id, creado_en) VALUES (?, ?, ?)')
      .run(token, u.id, ahora);
    return { token, usuario: { id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol } };
  },

  async logout(args) {
    if (args.token) await db.prepare('DELETE FROM sesiones WHERE token = ?').run(args.token);
    return { ok: true };
  },

  // Directorio público: solo aprobadas, con portada y cantidad de fotos.
  async getDirectorio() {
    const rows = await db.prepare(
      "SELECT * FROM chicas WHERE estado = 'aprobada' ORDER BY id ASC"
    ).all();
    const chicas = [];
    for (const c of rows) {
      chicas.push(publicChica(c, await fotoCover(c.id), await fotoCount(c.id)));
    }
    return { chicas };
  },

  // Perfil público de una chica aprobada, con todas sus fotos.
  async getChica(args) {
    const c = await db.prepare('SELECT * FROM chicas WHERE id = ?').get(Number(args.id));
    if (!c || c.estado !== 'aprobada') throw err('Ese perfil no existe o no está publicado.');
    const fotos = await db.prepare(
      'SELECT id, mime, es_principal FROM fotos WHERE chica_id = ? ORDER BY es_principal DESC, id ASC'
    ).all(c.id);
    const cover = fotos.length ? `/foto/${fotos[0].id}` : null;
    return {
      chica: {
        ...publicChica(c, cover, fotos.length),
        fotos: fotos.map((f) => ({ id: f.id, url: `/foto/${f.id}`, es_principal: f.es_principal })),
      },
    };
  },

  async getChicaAdmin(args) {
    await getAdminByToken(args.token);
    const c = await db.prepare('SELECT * FROM chicas WHERE id = ?').get(Number(args.id));
    if (!c) throw err('Ese perfil no existe.');
    const fotos = await db.prepare(
      'SELECT id, mime, es_principal FROM fotos WHERE chica_id = ? ORDER BY es_principal DESC, id ASC'
    ).all(c.id);
    const cover = fotos.length ? `/foto/${fotos[0].id}` : null;
    return {
      chica: {
        ...publicChica(c, cover, fotos.length),
        fotos: fotos.map((f) => ({ id: f.id, url: `/foto/${f.id}`, es_principal: f.es_principal })),
      },
    };
  },

  // Registro público de una chica: crea la invitación PENDIENTE para el admin.
  async registrarChica(args) {
    const nombre = String(args.nombre || '').trim();
    if (!nombre) throw err('Escribe tu nombre.');
    if (nombre.length > 60) throw err('El nombre es muy largo.');
    const descripcion = String(args.descripcion || '').trim().slice(0, 1000);
    const telefono = validarTelefono(args.telefono, true);
    const fotos = validarFotos(args.fotos, true);
    const p = normPerfil(args, null);
    const ahora = sdNow().stamp;
    const r = await db.prepare(
      `INSERT INTO chicas (nombre, descripcion, telefono, estado, origen, creado_en, ${PERFIL_COLS.join(', ')}) VALUES (?, ?, ?, 'pendiente', 'registro', ?, ${PERFIL_COLS.map(() => '?').join(', ')})`
    ).run(nombre, descripcion, telefono, ahora, ...perfilVals(p));
    const id = Number(r.lastInsertRowid);
    await insertFotos(id, fotos, ahora);
    return { id, estado: 'pendiente', mensaje: 'Tu solicitud quedó pendiente. El admin la revisa y la aprueba.' };
  },

  // ---- Admin ----
  async listSolicitudes(args) {
    await getAdminByToken(args.token);
    const rows = await db.prepare(
      "SELECT * FROM chicas WHERE estado = 'pendiente' ORDER BY id ASC"
    ).all();
    const out = [];
    for (const c of rows) {
      out.push(publicChica(c, await fotoCover(c.id), await fotoCount(c.id)));
    }
    return { solicitudes: out };
  },

  async listPerfiles(args) {
    await getAdminByToken(args.token);
    const rows = await db.prepare('SELECT * FROM chicas ORDER BY id ASC').all();
    const out = [];
    for (const c of rows) {
      out.push(publicChica(c, await fotoCover(c.id), await fotoCount(c.id)));
    }
    return { perfiles: out };
  },

  async setEstadoChica(args) {
    await getAdminByToken(args.token);
    const estado = String(args.estado || '');
    if (!['pendiente', 'aprobada', 'rechazada'].includes(estado)) throw err('Estado no válido.');
    const r = await db.prepare('UPDATE chicas SET estado = ? WHERE id = ?').run(estado, Number(args.id));
    if (Number(r.changes || 0) === 0) throw err('Ese perfil no existe.');
    return { ok: true, estado };
  },

  async deleteChica(args) {
    await getAdminByToken(args.token);
    const id = Number(args.id);
    await db.prepare('DELETE FROM fotos WHERE chica_id = ?').run(id);
    const r = await db.prepare('DELETE FROM chicas WHERE id = ?').run(id);
    if (Number(r.changes || 0) === 0) throw err('Ese perfil no existe.');
    return { ok: true };
  },

  // El admin agrega una modelo directo: queda aprobada y visible al instante.
  async createChicaAdmin(args) {
    await getAdminByToken(args.token);
    const nombre = String(args.nombre || '').trim();
    if (!nombre) throw err('Escribe el nombre de la modelo.');
    if (nombre.length > 60) throw err('El nombre es muy largo.');
    const descripcion = String(args.descripcion || '').trim().slice(0, 1000);
    const telefono = validarTelefono(args.telefono, false);
    const fotos = validarFotos(args.fotos, false);
    const p = normPerfil(args, null);
    const ahora = sdNow().stamp;
    const r = await db.prepare(
      `INSERT INTO chicas (nombre, descripcion, telefono, estado, origen, creado_en, ${PERFIL_COLS.join(', ')}) VALUES (?, ?, ?, 'aprobada', 'admin', ?, ${PERFIL_COLS.map(() => '?').join(', ')})`
    ).run(nombre, descripcion, telefono, ahora, ...perfilVals(p));
    const id = Number(r.lastInsertRowid);
    if (fotos.length) await insertFotos(id, fotos, ahora);
    return { id, estado: 'aprobada' };
  },

  async updateChica(args) {
    await getAdminByToken(args.token);
    const id = Number(args.id);
    const c = await db.prepare('SELECT * FROM chicas WHERE id = ?').get(id);
    if (!c) throw err('Ese perfil no existe.');
    const nombre = String(args.nombre ?? c.nombre).trim();
    if (!nombre) throw err('Escribe el nombre de la modelo.');
    const descripcion = String(args.descripcion ?? c.descripcion).trim().slice(0, 1000);
    const telefono = validarTelefono(args.telefono ?? c.telefono, false);
    const p = normPerfil(args, c);
    await db.prepare(
      `UPDATE chicas SET nombre = ?, descripcion = ?, telefono = ?, ${PERFIL_COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`
    ).run(nombre, descripcion, telefono, ...perfilVals(p), id);
    return { ok: true };
  },

  async uploadFoto(args) {
    await getAdminByToken(args.token);
    const chicaId = Number(args.chica_id);
    const c = await db.prepare('SELECT * FROM chicas WHERE id = ?').get(chicaId);
    if (!c) throw err('Ese perfil no existe.');
    const count = await fotoCount(chicaId);
    if (count >= MAX_FOTOS_POR_CHICA) throw err(`Máximo ${MAX_FOTOS_POR_CHICA} fotos por perfil.`);
    const fotos = validarFotos([{ b64: args.b64, mime: args.mime }], true);
    const ahora = sdNow().stamp;
    const esPrincipal = count === 0 ? 1 : 0;
    const r = await db.prepare(
      'INSERT INTO fotos (chica_id, datos, mime, es_principal, creado_en) VALUES (?, ?, ?, ?, ?)'
    ).run(chicaId, fotos[0].buf, fotos[0].mime, esPrincipal, ahora);
    return { id: Number(r.lastInsertRowid), url: `/foto/${Number(r.lastInsertRowid)}` };
  },

  async deleteFoto(args) {
    await getAdminByToken(args.token);
    const f = await db.prepare('SELECT * FROM fotos WHERE id = ?').get(Number(args.foto_id));
    if (!f) throw err('Esa foto no existe.');
    await db.prepare('DELETE FROM fotos WHERE id = ?').run(f.id);
    if (f.es_principal) {
      const otra = await db.prepare(
        'SELECT id FROM fotos WHERE chica_id = ? ORDER BY id ASC LIMIT 1'
      ).get(f.chica_id);
      if (otra) await db.prepare('UPDATE fotos SET es_principal = 1 WHERE id = ?').run(otra.id);
    }
    return { ok: true };
  },

  async setFotoPrincipal(args) {
    await getAdminByToken(args.token);
    const f = await db.prepare('SELECT * FROM fotos WHERE id = ?').get(Number(args.foto_id));
    if (!f) throw err('Esa foto no existe.');
    await db.prepare('UPDATE fotos SET es_principal = 0 WHERE chica_id = ?').run(f.chica_id);
    await db.prepare('UPDATE fotos SET es_principal = 1 WHERE id = ?').run(f.id);
    return { ok: true };
  },
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(err('El envío es muy grande.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/actions') {
      const body = JSON.parse(await readBody(req));
      const fn = actions[body.action];
      if (!fn) throw err('Acción no válida.');
      const out = await fn(body.args || {});
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, ...out }));
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/foto/')) {
      const id = Number(url.pathname.slice(6));
      if (!Number.isInteger(id) || id <= 0) { res.writeHead(404); res.end('no encontrada'); return; }
      const row = await db.prepare('SELECT datos, mime FROM fotos WHERE id = ?').get(id);
      if (!row) { res.writeHead(404); res.end('no encontrada'); return; }
      const buf = Buffer.isBuffer(row.datos) ? row.datos : Buffer.from(row.datos);
      res.writeHead(200, { 'Content-Type': row.mime || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
      return;
    }
    // Estáticos del cliente
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    p = path.normalize(p).replace(/^(\.\.[\/\\])+/, '');
    const file = path.join(CLIENT_DIR, p);
    if (!file.startsWith(CLIENT_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('no encontrado');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  } catch (e) {
    const msg = e?.isApp ? e.message : 'Error interno del servidor.';
    if (!e?.isApp) console.error(e);
    if (!res.headersSent) res.writeHead(e?.isApp ? 400 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: msg }));
  }
});

await db.exec(SCHEMA);
await migrate();
await seed();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Sex ads escuchando en 0.0.0.0:${PORT} (DB: ${TURSO_URL ? 'Turso remoto' : DB_PATH})`);
});
