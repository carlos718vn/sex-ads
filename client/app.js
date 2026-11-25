// Sex ads — cliente web.
// Directorio público, registro de chicas (invitación pendiente), panel admin.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

async function api(action, args = {}) {
  const r = await fetch('/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Error del servidor.');
  return j;
}

const token = () => localStorage.getItem('sexads_token') || '';

function showView(name) {
  $$('.view').forEach((v) => { v.hidden = true; });
  const el = $('#view-' + name);
  if (el) el.hidden = false;
  window.scrollTo({ top: 0 });
  if (name === 'directorio') loadDirectorio();
  if (name === 'admin') { if (token()) showPanel(); }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) { e.preventDefault(); showView(b.dataset.view); }
});
$('#logoHome').addEventListener('click', (e) => { e.preventDefault(); showView('directorio'); });
$('#heroVer').addEventListener('click', () => { $('#grid').scrollIntoView({ behavior: 'smooth' }); });

// ---------------------------------------------------------------------------
// Fotos: comprimir en el cliente (máx 1200 px, JPEG 0.8) antes de subir.
// ---------------------------------------------------------------------------
function fileToFoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const max = 1200;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      const url = cv.toDataURL('image/jpeg', 0.8);
      resolve({ b64: url.split(',')[1], mime: 'image/jpeg', preview: url });
    };
    img.onerror = () => reject(new Error('No se pudo leer una foto.'));
    img.src = URL.createObjectURL(file);
  });
}
async function leerFotos(input) {
  const files = [...(input.files || [])].filter((f) => f.type.startsWith('image/'));
  const out = [];
  for (const f of files) out.push(await fileToFoto(f));
  return out;
}
function pintarPreview(cont, fotos) {
  cont.innerHTML = fotos.map((f) => `<img src="${f.preview}" class="thumb" alt="">`).join('');
}

// ---------------------------------------------------------------------------
// Directorio público
// ---------------------------------------------------------------------------
let heroPuesto = false;
async function loadDirectorio() {
  try {
    const { chicas } = await api('getDirectorio');
    const grid = $('#grid');
    $('#gridVacio').hidden = chicas.length > 0;
    grid.innerHTML = chicas.map((c) => `
      <article class="card-modelo" data-id="${c.id}">
        <div class="foto-portada">${c.foto ? `<img src="${c.foto}" alt="${esc(c.nombre)}" loading="lazy">` : '<div class="sinfoto">Sin foto</div>'}</div>
        <div class="card-body">
          <h3>${esc(c.nombre)}</h3>
          <p>${esc((c.descripcion || '').slice(0, 120))}</p>
          <div class="row">
            <button class="btn btn-red btn-sm" data-perfil="${c.id}">Ver perfil</button>
            ${c.whatsapp ? `<a class="btn btn-wa btn-sm" href="${c.whatsapp}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
          </div>
        </div>
      </article>`).join('');
    // Fondo del hero: la portada de la primera modelo.
    if (!heroPuesto && chicas.length && chicas[0].foto) {
      $('#hero').style.backgroundImage = `linear-gradient(rgba(0,0,0,.55), rgba(0,0,0,.75)), url('${chicas[0].foto}')`;
      heroPuesto = true;
    }
  } catch (e) {
    $('#grid').innerHTML = `<p class="msg error">${esc(e.message)}</p>`;
  }
}
$('#grid').addEventListener('click', (e) => {
  const card = e.target.closest('[data-perfil]');
  if (card) showPerfil(Number(card.dataset.perfil));
  const modelo = e.target.closest('.card-modelo');
  if (modelo && !e.target.closest('a') && !e.target.closest('button')) {
    showPerfil(Number(modelo.dataset.id));
  }
});

async function showPerfil(id) {
  showView('perfil');
  const box = $('#perfilBox');
  box.innerHTML = '<p class="muted">Cargando...</p>';
  try {
    const { chica } = await api('getChica', { id });
    const fotos = chica.fotos || [];
    box.innerHTML = `
      <div class="perfil-grid">
        <div>
          <div class="foto-grande">${fotos.length ? `<img id="fotoGrande" src="${fotos[0].url}" alt="">` : '<div class="sinfoto">Sin foto</div>'}</div>
          <div class="thumbs">${fotos.map((f, i) => `<img src="${f.url}" class="thumb ${i === 0 ? 'sel' : ''}" data-foto="${f.url}" alt="">`).join('')}</div>
        </div>
        <div>
          <h2>${esc(chica.nombre)}</h2>
          <p class="desc">${esc(chica.descripcion || '')}</p>
          ${chica.whatsapp
            ? `<a class="btn btn-wa btn-big" href="${chica.whatsapp}" target="_blank" rel="noopener">💬 Escríbeme por WhatsApp</a>`
            : '<p class="muted">Esta modelo aún no tiene número de WhatsApp.</p>'}
          <p class="muted">Publicado en Sex ads</p>
        </div>
      </div>`;
    box.querySelectorAll('[data-foto]').forEach((t) => t.addEventListener('click', () => {
      $('#fotoGrande').src = t.dataset.foto;
      box.querySelectorAll('.thumb').forEach((x) => x.classList.remove('sel'));
      t.classList.add('sel');
    }));
  } catch (e) {
    box.innerHTML = `<p class="msg error">${esc(e.message)}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Registro de chica
// ---------------------------------------------------------------------------
let regFotos = [];
$('#regFotos').addEventListener('change', async (e) => {
  try { regFotos = await leerFotos(e.target); pintarPreview($('#regPreview'), regFotos); }
  catch (err) { $('#regMsg').textContent = err.message; $('#regMsg').className = 'msg error'; }
});
$('#formRegistro').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#regMsg');
  msg.textContent = 'Enviando...'; msg.className = 'msg';
  const fd = new FormData(e.target);
  try {
    const r = await api('registrarChica', {
      nombre: fd.get('nombre'), descripcion: fd.get('descripcion'),
      telefono: fd.get('telefono'), fotos: regFotos,
    });
    msg.textContent = '¡Listo! Tu solicitud quedó pendiente. El admin la aprueba y tu perfil sale publicado.';
    msg.className = 'msg ok';
    e.target.reset(); regFotos = []; $('#regPreview').innerHTML = '';
  } catch (err) { msg.textContent = err.message; msg.className = 'msg error'; }
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
$('#formLogin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#loginMsg');
  const fd = new FormData(e.target);
  try {
    const r = await api('loginAdmin', { usuario: fd.get('usuario'), contrasena: fd.get('contrasena') });
    localStorage.setItem('sexads_token', r.token);
    showPanel();
  } catch (err) { msg.textContent = err.message; msg.className = 'msg error'; }
});
$('#btnSalir').addEventListener('click', async () => {
  try { await api('logout', { token: token() }); } catch {}
  localStorage.removeItem('sexads_token');
  showView('directorio');
});
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $$('.tabpane').forEach((p) => { p.hidden = true; });
  $('#tab-' + t.dataset.tab).hidden = false;
  if (t.dataset.tab === 'solicitudes') loadSolicitudes();
  if (t.dataset.tab === 'perfiles') loadPerfiles();
}));

function showPanel() {
  showView('panel');
  loadSolicitudes();
}

async function loadSolicitudes() {
  const box = $('#listaSol');
  box.innerHTML = '<p class="muted">Cargando...</p>';
  try {
    const { solicitudes } = await api('listSolicitudes', { token: token() });
    const badge = $('#badgeSol');
    badge.hidden = solicitudes.length === 0;
    badge.textContent = solicitudes.length;
    box.innerHTML = solicitudes.length ? solicitudes.map((c) => tarjetaAdmin(c, true)).join('') : '<p class="muted">No hay solicitudes pendientes.</p>';
  } catch (e) {
    box.innerHTML = `<p class="msg error">${esc(e.message)}</p>`;
    if (/Sesión/.test(e.message)) { localStorage.removeItem('sexads_token'); showView('admin'); }
  }
}
async function loadPerfiles() {
  const box = $('#listaPerfiles');
  box.innerHTML = '<p class="muted">Cargando...</p>';
  try {
    const { perfiles } = await api('listPerfiles', { token: token() });
    box.innerHTML = perfiles.length ? perfiles.map((c) => tarjetaAdmin(c, false)).join('') : '<p class="muted">No hay perfiles.</p>';
  } catch (e) { box.innerHTML = `<p class="msg error">${esc(e.message)}</p>`; }
}
function estadoTag(c) {
  return c.estado === 'aprobada' ? '<span class="tag ok">Publicada</span>'
    : c.estado === 'pendiente' ? '<span class="tag warn">Pendiente</span>'
    : '<span class="tag bad">Rechazada</span>';
}
function tarjetaAdmin(c, esSolicitud) {
  return `
  <article class="card admin-card" data-id="${c.id}">
    <div class="admin-card-in">
      ${c.foto ? `<img src="${c.foto}" class="admin-foto" alt="">` : '<div class="admin-foto sinfoto">Sin foto</div>'}
      <div>
        <h3>${esc(c.nombre)} ${estadoTag(c)}</h3>
        <p class="muted">${esc((c.descripcion || '').slice(0, 140))}</p>
        <p class="muted">WhatsApp: ${esc(c.telefono || '—')} · Fotos: ${c.foto_count} · ${c.origen === 'admin' ? 'Agregada por admin' : 'Se registró sola'}</p>
        <div class="row">
          ${c.estado !== 'aprobada' ? `<button class="btn btn-red btn-sm" data-act="aprobar" data-id="${c.id}">Aprobar</button>` : ''}
          ${c.estado !== 'rechazada' ? `<button class="btn btn-ghost btn-sm" data-act="rechazar" data-id="${c.id}">Rechazar</button>` : ''}
          <button class="btn btn-ghost btn-sm" data-act="editar" data-id="${c.id}">Editar</button>
          <button class="btn btn-ghost btn-sm" data-act="borrar" data-id="${c.id}">Borrar</button>
        </div>
      </div>
    </div>
  </article>`;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = Number(b.dataset.id);
  const act = b.dataset.act;
  try {
    if (act === 'aprobar') { await api('setEstadoChica', { token: token(), id, estado: 'aprobada' }); }
    if (act === 'rechazar') { await api('setEstadoChica', { token: token(), id, estado: 'rechazada' }); }
    if (act === 'borrar') {
      if (!confirm('¿Borrar este perfil y todas sus fotos?')) return;
      await api('deleteChica', { token: token(), id });
    }
    if (act === 'editar') { abrirEditar(id); return; }
    loadSolicitudes(); loadPerfiles();
  } catch (err) { alert(err.message); }
});

// Agregar modelo (admin, visible al instante)
let addFotos = [];
$('#addFotos').addEventListener('change', async (e) => {
  try { addFotos = await leerFotos(e.target); pintarPreview($('#addPreview'), addFotos); }
  catch (err) { $('#addMsg').textContent = err.message; $('#addMsg').className = 'msg error'; }
});
$('#formAgregar').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#addMsg');
  msg.textContent = 'Agregando...'; msg.className = 'msg';
  const fd = new FormData(e.target);
  try {
    const r = await api('createChicaAdmin', {
      token: token(), nombre: fd.get('nombre'), descripcion: fd.get('descripcion'),
      telefono: fd.get('telefono'), fotos: addFotos,
    });
    msg.textContent = 'Modelo agregada y ya visible en el directorio.';
    msg.className = 'msg ok';
    e.target.reset(); addFotos = []; $('#addPreview').innerHTML = '';
  } catch (err) { msg.textContent = err.message; msg.className = 'msg error'; }
});

// Editar perfil (modal)
let editandoId = null;
async function abrirEditar(id) {
  editandoId = id;
  const { perfiles } = await api('listPerfiles', { token: token() });
  const c = perfiles.find((p) => p.id === id);
  if (!c) return;
  const f = $('#formEditar');
  f.id.value = c.id; f.nombre.value = c.nombre;
  f.descripcion.value = c.descripcion || ''; f.telefono.value = c.telefono || '';
  $('#editMsg').textContent = '';
  await pintarEditFotos(id);
  $('#modalEditar').hidden = false;
}
async function pintarEditFotos(id) {
  const box = $('#editFotos');
  try {
    const { chica } = await api('getChicaAdmin', { token: token(), id });
    box.innerHTML = chica.fotos.length ? chica.fotos.map((f) => `
    <div class="thumb-wrap">
      <img src="${f.url}" class="thumb ${f.es_principal ? 'sel' : ''}" alt="">
      <div class="thumb-btns">
        ${f.es_principal ? '<span class="tag ok">Principal</span>' : `<button data-principal="${f.id}">Principal</button>`}
        <button data-borrar-foto="${f.id}">✕</button>
      </div>
    </div>`).join('') : '<p class="muted">Sin fotos todavía. Súbele una abajo.</p>';
  } catch (e) { box.innerHTML = `<p class="msg error">${esc(e.message)}</p>`; }
}
$('#editFotos').addEventListener('click', async (e) => {
  const p = e.target.closest('[data-principal]');
  const d = e.target.closest('[data-borrar-foto]');
  try {
    if (p) { await api('setFotoPrincipal', { token: token(), foto_id: Number(p.dataset.principal) }); }
    if (d) {
      if (!confirm('¿Borrar esta foto?')) return;
      await api('deleteFoto', { token: token(), foto_id: Number(d.dataset.borrarFoto) });
    }
    await pintarEditFotos(editandoId); loadPerfiles();
  } catch (err) { alert(err.message); }
});
$('#editFotoInput').addEventListener('change', async (e) => {
  try {
    const fotos = await leerFotos(e.target);
    for (const f of fotos) await api('uploadFoto', { token: token(), chica_id: editandoId, b64: f.b64, mime: f.mime });
    e.target.value = '';
    await pintarEditFotos(editandoId); loadPerfiles();
  } catch (err) { alert(err.message); }
});
$('#formEditar').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#editMsg');
  const fd = new FormData(e.target);
  try {
    await api('updateChica', {
      token: token(), id: Number(fd.get('id')), nombre: fd.get('nombre'),
      descripcion: fd.get('descripcion'), telefono: fd.get('telefono'),
    });
    msg.textContent = 'Guardado.'; msg.className = 'msg ok';
    loadPerfiles(); loadSolicitudes();
  } catch (err) { msg.textContent = err.message; msg.className = 'msg error'; }
});
$('#btnCerrarModal').addEventListener('click', () => { $('#modalEditar').hidden = true; });
$('#modalEditar').addEventListener('click', (e) => { if (e.target.id === 'modalEditar') e.target.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#modalEditar').hidden = true; });

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Inicio
showView('directorio');
