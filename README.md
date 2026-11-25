# Sex ads — Directorio de modelos

Directorio público de modelos: el cliente entra, ve la chica que le gusta y
le escribe directo por WhatsApp. La chica se registra con sus fotos, su
descripción y su número; su solicitud queda pendiente hasta que el admin la
aprueba. El admin también puede agregar modelos directo desde su panel.

## Cómo funciona

- **Directorio público**: tarjetas con foto, nombre y descripción. Cada
  perfil tiene un botón de WhatsApp que abre WhatsApp directo con el número
  de esa chica (`wa.me`).
- **Registro de chica**: nombre, descripción, número de WhatsApp y fotos.
  Al registrarse se crea una invitación **pendiente**; no sale en el
  directorio hasta que el admin la aprueba.
- **Admin**: entra con `admin` / `admin` a un panel privado. Ahí ve las
  solicitudes pendientes y las aprueba, rechaza o borra; agrega modelos
  directo (quedan visibles al instante); les sube fotos sin límite, les
  cambia la foto principal y edita cualquier perfil.
- **Fotos sin límite y sin pago**: se guardan como blobs en la base de
  datos propia del sitio (Turso en producción, SQLite local en desarrollo).
  El cliente las comprime antes de subirlas (máx 1200 px, JPEG 0.8).
- **Primera modelo**: el sitio arranca con la modelo "Primera modelo" y las
  dos fotos que mandó el dueño (también son el fondo del hero). El admin le
  pone su nombre real, su WhatsApp y su descripción desde el panel; no se
  inventó ningún número.

## Estructura

```
sex-ads-public/
├── server/           # Servidor Node (sin framework, solo http + @libsql/client)
│   ├── server.js     # API POST /actions + GET /foto/:id + estáticos
│   ├── test.mjs      # Pruebas de punta a punta (38 checks)
│   ├── seed/         # Las 2 fotos de la primera modelo (se siembran en la DB)
│   └── package.json
├── client/           # Web: index.html, app.js, style.css
├── render.yaml       # Blueprint de Render (Web Service gratis)
└── DEPLOY.md         # Pasos de despliegue (GitHub + Turso + Render)
```

## Desarrollo local

```bash
cd server
npm install
npm start          # http://localhost:8080
npm test           # pruebas (base de prueba aparte, se borra al final)
```

Sin variables de entorno usa `sexads.db` local. Con `TURSO_DATABASE_URL` y
`TURSO_AUTH_TOKEN` usa Turso remoto.

## Despliegue

Ver `DEPLOY.md`. Resumen: subir este repo a GitHub, crear una base Turso
`sex-ads`, crear el Web Service en Render con esas dos variables y hacer
Manual Deploy. La URL pública queda como `https://sex-ads.onrender.com`.
