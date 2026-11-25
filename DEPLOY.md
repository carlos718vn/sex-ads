# Despliegue en Render (gratis) — Sex ads

El servidor ya está listo para Render: lee el puerto de `PORT`, escucha en
`0.0.0.0`, y la base de datos es Turso (libSQL, persistente). Las fotos se
guardan en la base de datos, así que no hace falta ningún servicio de
almacenamiento de pago. Este documento lista los pasos exactos que faltan.
**No se crea ninguna cuenta aquí**: los pasos que piden cuenta se hacen con
el navegador (las cuentas ya existen: GitHub `carlos718vn`, Render con
Google `carlos718vn@gmail.com`, Turso).

## Cuentas (todas gratis, sin tarjeta)

| Cuenta | Para qué | Estado |
|---|---|---|
| Render | Alojar el servidor (Web Service gratis) | **Ya creada** (entra con Google) |
| GitHub | Guardar el código para que Render lo tome | **Ya creada** (`carlos718vn`) |
| Turso | La base de datos persistente (libSQL) | **Ya creada** (hay una base `banca-de-loteria`; crear una **nueva** `sex-ads`) |

## Paso 1 — Subir el código a GitHub

1. Crear un repositorio nuevo **público** llamado `sex-ads` en la cuenta
   `carlos718vn`.
2. Subir el contenido de `~/workspace/sex-ads-public/` al repo:
   - La forma fácil: en la página del repo, "Add file" → "Upload files" y
     subir las carpetas `server/`, `client/`, y los archivos `render.yaml`,
     `README.md`, `DEPLOY.md`, `.gitignore`.
   - No subir `node_modules/` ni `*.db` (ya están ignorados por
     `.gitignore`).
   - **Sí subir `server/seed/`** (las 2 fotos de la primera modelo; el
     servidor las siembra en la base de datos al arrancar por primera vez).

## Paso 2 — Crear la base de datos en Turso

1. Entrar a https://turso.tech (cuenta ya creada, con GitHub).
2. Crear una base de datos **nueva** llamada `sex-ads` (región `iad` —
   Virginia, EE. UU. — igual que la de la lotería). No reutilizar la base
   `banca-de-loteria`: este proyecto tiene su propio esquema.
3. Conseguir los dos valores (en el panel de Turso, en la base creada):
   - **URL**: se ve como `libsql://sex-ads-<usuario>.turso.io`
   - **Token**: en la base, "Create token" (o `turso db tokens create`).
     Es un secreto: no se pega en el chat, se pone directo en Render.
4. Guardar esos dos valores para el Paso 3.

Límites del plan gratis de Turso (verificados nov 2026): 100 bases, 5 GB de
almacenamiento, 500 millones de filas leídas y 10 millones escritas por mes,
sin tarjeta y sin vencimiento. Las fotos se comprimen en el navegador antes
de subirlas (máx 1200 px, JPEG 0.8, ~100-300 KB cada una), así que 5 GB
alcanzan para miles de fotos. Aviso: una base sin uso por 10 días se
archiva (se restaura desde el panel, no se borra).

## Paso 3 — Crear el servicio en Render

1. Entrar a https://dashboard.render.com (cuenta ya creada, con Google).
2. **New +** → **Web Service** → conectar el repositorio de GitHub
   `sex-ads`.
   - Ojo (aprendido con la lotería): si Render se conecta por **URL
     pública del repo**, el despliegue **no se dispara solo** al subir
     cambios; hay que pulsar **Manual Deploy** → **Deploy latest commit**
     cada vez.
3. Configuración del servicio:
   - **Name**: `sex-ads`
   - **Root Directory**: `server`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
   - (Ojo: el archivo `render.yaml` de este repo ya trae estos valores; si
     Render ofrece crear por Blueprint, también vale y pide lo mismo.)
4. **Environment Variables** (botón "Add Environment Variable"):
   - `TURSO_DATABASE_URL` = la URL de Turso del Paso 2
   - `TURSO_AUTH_TOKEN` = el token de Turso del Paso 2 (marcarlo secreto)
   - Render pone `PORT` solo.
5. **Create Web Service**. El primer despliegue tarda unos minutos.
   La URL pública será algo como `https://sex-ads.onrender.com`.

Notas del plan gratis de Render: el servicio **duerme tras 15 minutos sin
tráfico** y tarda ~1 minuto en despertar con la primera visita. Los datos
viven en **Turso** (base aparte, no se duerme ni se borra); Render es solo
el programa que atiende. Al despertar lee los mismos datos. No se usa la
base Postgres gratis de Render porque **expira a los 30 días y se borra con
todos los datos**.

## Paso 4 — Verificar que está en vivo

1. Abrir la URL pública en el navegador: debe cargar el directorio con la
   primera modelo ("Primera modelo") y sus 2 fotos, y el hero con su foto
   de fondo.
2. Entrar al Admin con `admin` / `admin` (la siembra inicial; cambiar la
   contraseña no está en el panel todavía — si se quiere, pedirlo).
3. Probar el flujo completo:
   - Registrarse como una chica de prueba (nombre, descripción, teléfono,
     1 foto) → debe quedar pendiente y NO verse en el directorio.
   - En el panel, aprobarla → debe aparecer en el directorio con su botón
     de WhatsApp (`wa.me/...`).
   - Borrar la chica de prueba.
4. Verificar por API (curl) si hace falta:
   - `GET /` → 200 con el HTML.
   - `POST /actions {"action":"loginAdmin","args":{"usuario":"admin","contrasena":"admin"}}` → `ok:true` con token.
   - `POST /actions {"action":"getDirectorio","args":{}}` → la primera modelo con `foto_count: 2`.

## Resumen (checklist)

- [ ] Repo público `sex-ads` creado en GitHub + código subido (Paso 1)
- [ ] Base Turso `sex-ads` creada + URL y token (Paso 2)
- [ ] Web Service creado en Render con las 2 variables (Paso 3)
- [ ] Manual Deploy hecho y URL pública verificada (Paso 4)
