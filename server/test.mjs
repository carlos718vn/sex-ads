// Pruebas de punta a punta del servidor Sex ads (base local de prueba).
// Uso: node test.mjs   (instala dependencias primero: npm install)
// Levanta el servidor en el puerto 18082 con DB_PATH=sexads.test.db (nueva),
// corre las verificaciones y lo apaga. Sale con código 1 si algo falla.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18082;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, 'sexads.test.db');
for (const suf of ['', '-shm', '-wal']) { try { fs.unlinkSync(DB + suf); } catch {} }

const foto1 = fs.readFileSync(path.join(__dirname, 'seed', 'foto1.jpg')).toString('base64');
const foto2 = fs.readFileSync(path.join(__dirname, 'seed', 'foto2.jpg')).toString('base64');

let pass = 0, fail = 0;
function check(nombre, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${nombre}`); }
  else { fail++; console.log(`  FAIL ${nombre} ${extra}`); }
}
async function action(nombre, args, token) {
  const r = await fetch(`${BASE}/actions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: nombre, args: { ...(args || {}), ...(token ? { token } : {}) } }),
  });
  return r.json();
}
async function getFoto(id) {
  const r = await fetch(`${BASE}/foto/${id}`);
  return { status: r.status, type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) };
}

const server = spawn('node', ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(PORT), DB_PATH: DB },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
server.stdout.on('data', (d) => { out += d; });
server.stderr.on('data', (d) => { out += d; });

async function waitReady(tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`${BASE}/`); if (r.status === 200) return true; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

try {
  console.log('Esperando al servidor...');
  check('servidor arranca y sirve el cliente', await waitReady(), out.slice(-500));

  // 1. Login admin
  const bad = await action('loginAdmin', { usuario: 'admin', contrasena: 'mal' });
  check('login con clave mala es rechazado', bad.ok === false);
  const login = await action('loginAdmin', { usuario: 'admin', contrasena: 'admin' });
  check('login admin/admin funciona', login.ok === true && !!login.token);
  const token = login.token;

  // 2. Directorio inicial: primera modelo sembrada con 2 fotos
  const dir0 = await action('getDirectorio', {});
  check('directorio inicial trae 1 modelo', dir0.ok && dir0.chicas.length === 1, JSON.stringify(dir0));
  const primera = dir0.chicas[0];
  check('primera modelo se llama Primera modelo', primera?.nombre === 'Primera modelo');
  check('primera modelo tiene 2 fotos', primera?.foto_count === 2, JSON.stringify(primera));
  check('primera modelo sin WhatsApp (sin número inventado)', primera?.whatsapp === null, JSON.stringify(primera));
  check('portada es URL /foto/', typeof primera?.foto === 'string' && primera.foto.startsWith('/foto/'));
  const hero = await getFoto(Number(primera.foto.split('/').pop()));
  check('la foto de portada se sirve (200, image/jpeg)', hero.status === 200 && (hero.type || '').includes('image/jpeg'));
  check('la foto servida es la semilla', hero.buf.equals(Buffer.from(foto1, 'base64')));

  // Perfil público con galería
  const perfil = await action('getChica', { id: primera.id });
  check('perfil público trae 2 fotos', perfil.ok && perfil.chica.fotos.length === 2);

  // 3. Registro de una chica -> invitación pendiente, NO visible en el directorio
  const reg = await action('registrarChica', {
    nombre: 'Prueba Modelo', descripcion: 'Hola, soy nueva.',
    telefono: '809-555-1234',
    fotos: [{ b64: foto2, mime: 'image/jpeg' }],
  });
  check('registro crea invitación pendiente', reg.ok && reg.estado === 'pendiente', JSON.stringify(reg));
  const dir1 = await action('getDirectorio', {});
  check('la pendiente NO sale en el directorio', dir1.chicas.length === 1);
  const sol = await action('listSolicitudes', {}, token);
  check('admin ve 1 solicitud pendiente', sol.ok && sol.solicitudes.length === 1, JSON.stringify(sol));
  check('la solicitud trae el teléfono normalizado', sol.solicitudes[0]?.telefono === '18095551234');

  // 4. Aprobar -> aparece en el directorio con WhatsApp correcto
  const apr = await action('setEstadoChica', { id: reg.id, estado: 'aprobada' }, token);
  check('admin aprueba la solicitud', apr.ok === true);
  const dir2 = await action('getDirectorio', {});
  check('tras aprobar hay 2 modelos en el directorio', dir2.chicas.length === 2);
  const nueva = dir2.chicas.find((c) => c.id === reg.id);
  check('el botón de WhatsApp apunta a wa.me/18095551234', nueva?.whatsapp === 'https://wa.me/18095551234', JSON.stringify(nueva));
  // La foto que subió la chica al registrarse quedó guardada en la DB y se sirve igual
  const perfNueva = await action('getChica', { id: reg.id });
  check('el perfil aprobado trae la foto subida', perfNueva.ok && perfNueva.chica.fotos.length === 1);
  const fotoSubida = await getFoto(perfNueva.chica.fotos[0].id);
  check('la foto del registro se guardó byte a byte en la DB', fotoSubida.status === 200 && fotoSubida.buf.equals(Buffer.from(foto2, 'base64')));

  // 5. Rechazar otra solicitud
  const reg2 = await action('registrarChica', {
    nombre: 'Rechazada', descripcion: 'x', telefono: '8295550000',
    fotos: [{ b64: foto1, mime: 'image/jpeg' }],
  });
  const rej = await action('setEstadoChica', { id: reg2.id, estado: 'rechazada' }, token);
  check('admin rechaza una solicitud', rej.ok === true);
  const dir3 = await action('getDirectorio', {});
  check('la rechazada NO sale en el directorio', dir3.chicas.length === 2);

  // 6. Admin agrega modelo directo -> visible al instante
  const creada = await action('createChicaAdmin', {
    nombre: 'Modelo Admin', descripcion: 'Agregada por el admin.',
    telefono: '+1 (849) 555-7777',
    fotos: [{ b64: foto1, mime: 'image/jpeg' }, { b64: foto2, mime: 'image/jpeg' }],
  }, token);
  check('admin crea modelo aprobada al instante', creada.ok && creada.estado === 'aprobada', JSON.stringify(creada));
  const dir4 = await action('getDirectorio', {});
  check('la modelo del admin ya está en el directorio', dir4.chicas.length === 3);
  const adm = dir4.chicas.find((c) => c.id === creada.id);
  check('teléfono del admin normalizado a 18495557777', adm?.telefono === '18495557777' && adm?.whatsapp === 'https://wa.me/18495557777');

  // 7. Subir foto, ponerla principal, borrarla
  const up = await action('uploadFoto', { chica_id: creada.id, b64: foto2, mime: 'image/jpeg' }, token);
  check('admin sube una foto más', up.ok && !!up.url, JSON.stringify(up));
  const fotoAdmin = await getFoto(up.id);
  check('la foto del admin se guardó byte a byte en la DB', fotoAdmin.status === 200 && fotoAdmin.buf.equals(Buffer.from(foto2, 'base64')));
  const p1 = await action('getChica', { id: creada.id });
  check('la modelo tiene 3 fotos', p1.chica.fotos.length === 3);
  const setP = await action('setFotoPrincipal', { foto_id: up.id }, token);
  check('se puede poner una foto como principal', setP.ok === true);
  const p2 = await action('getChica', { id: creada.id });
  check('la principal cambió', p2.chica.fotos[0].id === up.id);
  const delF = await action('deleteFoto', { foto_id: up.id }, token);
  check('se puede borrar una foto', delF.ok === true);
  const p3 = await action('getChica', { id: creada.id });
  check('quedan 2 fotos tras borrar', p3.chica.fotos.length === 2);

  // 8. Editar perfil (ponerle WhatsApp a la primera modelo)
  const upd = await action('updateChica', { id: primera.id, nombre: 'Primera modelo', descripcion: 'Nueva descripción.', telefono: '8091112222' }, token);
  check('admin edita el perfil de la primera modelo', upd.ok === true);
  const p4 = await action('getChica', { id: primera.id });
  check('la primera modelo ya tiene WhatsApp', p4.chica.whatsapp === 'https://wa.me/18091112222', JSON.stringify(p4.chica));

  // 9b. getChicaAdmin ve el perfil pendiente con sus fotos (para el modal de edición)
  const reg3 = await action('registrarChica', {
    nombre: 'Pendiente Edit', descripcion: 'para editar', telefono: '8095559999',
    fotos: [{ b64: foto1, mime: 'image/jpeg' }],
  });
  const admChica = await action('getChicaAdmin', { id: reg3.id }, token);
  check('admin ve perfil pendiente con fotos', admChica.ok && admChica.chica.fotos.length === 1 && admChica.chica.estado === 'pendiente', JSON.stringify(admChica));
  const pubChica = await action('getChica', { id: reg3.id });
  check('el público NO ve el perfil pendiente', pubChica.ok === false);
  await action('deleteChica', { id: reg3.id }, token);

  // 9. Borrar una modelo
  const del = await action('deleteChica', { id: reg2.id }, token);
  check('admin borra un perfil rechazado', del.ok === true);
  const sol2 = await action('listSolicitudes', {}, token);
  check('no quedan solicitudes pendientes', sol2.solicitudes.length === 0);

  // 10. Seguridad: acciones de admin sin token fallan; foto inexistente 404
  const sinToken = await action('listSolicitudes', {});
  check('listSolicitudes sin token es rechazado', sinToken.ok === false);
  const foto404 = await getFoto(999999);
  check('foto inexistente da 404', foto404.status === 404);
  const regSinFoto = await action('registrarChica', { nombre: 'Sin foto', descripcion: '', telefono: '8095550000', fotos: [] });
  check('registro sin foto es rechazado', regSinFoto.ok === false);

  console.log(`\n${pass} PASS, ${fail} FAIL`);
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  for (const suf of ['', '-shm', '-wal']) { try { fs.unlinkSync(DB + suf); } catch {} }
}
process.exit(fail ? 1 : 0);
