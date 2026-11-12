# PromoPanel Lite

Panel web liviano para gestionar contactos y enviar mensajes/estados mediante Evolution API. Incluye importación CSV, selección de clientes autorizados, texto, imágenes, video MP4, historial y conexión por QR o código de vinculación.

> **Importante:** Evolution API con conexión WhatsApp Web es una integración no oficial. Meta puede restringir cuentas que utilicen clientes no oficiales o envíen mensajes no deseados. No hay garantía de evitar bloqueos. Usá únicamente contactos que hayan dado consentimiento y respetá las bajas. La publicación de estados y los formatos aceptados pueden variar según la versión de Evolution API y WhatsApp.

## Requisitos

- Node.js 24 o superior (usa el módulo `node:sqlite` integrado).
- VPS con Docker y Docker Compose, o Coolify.
- Una instancia Evolution API ya instalada y accesible desde PromoPanel.
- Nombre de instancia y API key de Evolution API.
- Dominio/HTTPS recomendado para el acceso al panel.

## Instalación rápida con Docker Compose

1. Descomprimí el ZIP en el VPS.
2. Entrá a la carpeta `promopanel-lite`.
3. Copiá `.env.example` como `.env`.
4. Editá `.env` y configurá:
   - `PANEL_USER` y `PANEL_PASSWORD`: credenciales del panel.
   - `EVOLUTION_URL`: URL interna de Evolution API, por ejemplo `http://evolution-api:8080` si comparten red Docker.
   - `EVOLUTION_API_KEY`: clave API.
   - `EVOLUTION_INSTANCE`: nombre exacto de la instancia.
   - `ENCRYPTION_KEY`: clave de 32 bytes (hex) para cifrar teléfono y DNI. Si la dejás vacía, se genera `data/.key` automáticamente. No la cambies una vez cargados los datos.
   - `DEFAULT_COUNTRY`: país para normalizar teléfonos (por defecto `AR`).
   - `SEND_DELAY_MS`: pausa base entre envíos (por defecto `1500`).
   - `SEND_DELAY_JITTER_MS`: aleatoriedad extra sobre la pausa, para no enviar con un patrón fijo (por defecto `2500`).
   - `SEND_BATCH_SIZE` y `SEND_BATCH_PAUSE_MS`: descanso largo cada N mensajes (por defecto `20` mensajes y `60000` ms).
   - `MAX_UPLOAD_MB`: tamaño máximo por archivo adjunto (por defecto `25`).
   - `MAX_SEND_FILES`: máximo de imágenes/videos por campaña (por defecto `10`).
   - `MAX_TOTAL_UPLOAD_MB`: peso máximo del conjunto de archivos de una campaña (por defecto `60`).
   - `TRUST_PROXY`: dejalo en `false` salvo que estés detrás de un proxy inverso; ahí poné `true`.
5. Ejecutá:

```bash
docker compose up -d --build
```

6. Abrí `http://IP-DE-TU-VPS:3000`. Aparecerá una pantalla de ingreso; usá el usuario y la contraseña configurados en `.env`. El botón **Salir** cierra la sesión.

En producción, publicá el servicio detrás de un proxy HTTPS (por ejemplo, el proxy de Coolify). No expongas el puerto 3000 directamente a Internet sin HTTPS.

## Despliegue en VPS con Coolify

La app está pensada para un VPS chico: es **un solo contenedor liviano** (Node + SQLite, sin base de datos externa), con healthcheck y consumo de memoria acotado (el `Dockerfile` limita el heap de Node a 384 MB).

> **Recomendado:** crear una **Application** con build pack **Dockerfile** (no Docker Compose). Es más simple y Coolify gestiona puerto, dominio y volumen desde la interfaz.

### 1. Subir el código a GitHub
Usá un repositorio **privado**. El proyecto ya trae `.gitignore` y `.dockerignore` listos: nunca subas `.env` ni `data/`.

### 2. Conectar GitHub en Coolify
Coolify → **Keys & Tokens** → conectá tu cuenta (GitHub App o Deploy Key privada).

### 3. Crear la aplicación
1. **Projects** → tu proyecto → **New Resource** → **Application**.
2. Origen: **Private Repository (GitHub)** → elegí el repo → rama `main`.
3. **Build Pack**: `Dockerfile`.
4. **Base Directory**: `/` (el `Dockerfile` está en la raíz).

### 4. Puerto y dominio
- **Ports Exposes**: `3000`.
- **Domains**: `https://panel.tudominio.com` (Coolify emite el certificado Let's Encrypt solo). Apuntá el DNS del subdominio a la IP del VPS antes de desplegar.
- No expongas el puerto 3000 a Internet: dejá que el proxy de Coolify maneje el HTTPS.

### 5. Variables de entorno
En **Environment Variables** de la app:

| Variable | Valor |
|---|---|
| `PANEL_USER` | tu usuario |
| `PANEL_PASSWORD` | contraseña larga y única |
| `ENCRYPTION_KEY` | 64 caracteres hex (ver abajo) |
| `DEFAULT_COUNTRY` | `AR` (o tu país) |
| `EVOLUTION_URL` | URL de tu Evolution API |
| `EVOLUTION_API_KEY` | tu API key |
| `EVOLUTION_INSTANCE` | nombre exacto de la instancia |
| `TRUST_PROXY` | `true` (Coolify usa proxy inverso) |
| `SESSION_HOURS` | `12` |
| `PUBLIC_URL` | opcional: URL pública exacta, ej. `https://panel.tudominio.com` (solo si el panel rechaza con *Origen no permitido*) |

Generá la clave de cifrado con:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Para un VPS chico conviene bajar los límites de subida (opcionales):
`MAX_UPLOAD_MB=10`, `MAX_TOTAL_UPLOAD_MB=20`, `MAX_SEND_FILES=5`.

### 6. Almacenamiento persistente
**Persistent Storage** → agregá un volumen:
- **Name**: `promopanel-data`
- **Destination**: `/app/data`

Ahí viven la base SQLite, la clave (si no la definís por env) y los borradores. **Sin este volumen perdés los datos en cada redeploy.**

### 7. Desplegar
- **Deploy**. Mirá los **Logs**: deberías ver `PromoPanel Lite escuchando en puerto 3000`.
- Abrí `https://panel.tudominio.com` e ingresá con `PANEL_USER` / `PANEL_PASSWORD`.

### 8. Conectar con Evolution API
- **Mismo VPS / mismo Coolify** (recomendado): usá la URL interna, p. ej. `EVOLUTION_URL=http://evolution-api:8080`.
  1. Poné los dos recursos (panel y Evolution) en el **mismo proyecto/entorno** de Coolify, o conectalos a la **misma red** desde la pestaña *Network* de cada recurso.
  2. El nombre de host es el **nombre del servicio/contenedor** de Evolution (en su `docker-compose.yml` suele ser `evolution-api`). Para confirmarlo: `docker ps --format '{{.Names}}'`.
  3. Probá la conexión desde el panel:
     ```bash
     docker exec <contenedor-del-panel> node -e "fetch('http://evolution-api:8080').then(r=>console.log(r.status)).catch(e=>console.log('ERROR',e.message))"
     ```
- **Otra máquina** (p. ej. tu PC): usá una URL accesible desde el contenedor (HTTPS público o `http://IP:puerto`) y permití el acceso.
- Verificá el estado en la página **WhatsApp** del panel. Si la instancia ya está conectada, **no hace falta reescanear el QR**.
- **Vincular desde el celular (sin escanear):** si estás en el celular, el QR queda en la misma pantalla y no podés escanearlo. Para eso está la **Opción 1 · Código de vinculación**: en la página **WhatsApp** escribí el número a vincular (con código de país, solo dígitos) y el panel te devuelve un **código de 8 dígitos**. En WhatsApp del teléfono: *Dispositivos vinculados → Vincular un dispositivo → Vincular con número de teléfono*, y escribí ese código. El **código QR** (Opción 2) queda para cuando tenés **otra pantalla** (PC o tablet) donde mostrarlo y lo escaneás con el teléfono.
- **Cuenta conectada:** cuando la sesión está activa, la página **WhatsApp** muestra el **número y el nombre de perfil** de la cuenta vinculada, así confirmás que es la correcta.
- **Desvincular:** el botón **Desvincular** cierra la sesión de WhatsApp de la instancia (equivale a *logout*, **no borra** la instancia ni sus datos). Después podés volver a vincular con QR o con código de vinculación.

### 9. Copias de seguridad
- Respaldá el volumen `promopanel-data` (o al menos `promopanel.db` + `data/.key`).
- Guardá `ENCRYPTION_KEY` aparte: sin ella, los datos cifrados no se recuperan.

### Alternativa: recurso Docker Compose
Si preferís usar el `docker-compose.yml`, creá un recurso **Docker Compose** apuntando a ese archivo. Vas a necesitar montar el volumen persistente en `/app/data` y cargar las mismas variables.

## Importar contactos

El CSV debe tener encabezados. Columnas admitidas:
- `nombre` (también `name`)
- `telefono` (también `phone`, `celular` o `whatsapp`)
- `dni` (opcional; 7 u 8 dígitos)
- `optin` (si/no, true/false, 1/0)

Los teléfonos se normalizan automáticamente con `libphonenumber-js`: se aceptan con `+`, espacios, guiones o paréntesis, y se guardan en formato canónico (código de país + área + número, solo dígitos). Para Argentina se usa `DEFAULT_COUNTRY=AR`, así que `351 123 4567` y `+54 9 351 123-4567` se reconocen como el mismo número. Si un número no se puede interpretar con la librería pero tiene entre 10 y 15 dígitos, se guarda tal cual.

El **DNI es opcional**. Si lo completás, debe tener 7 u 8 dígitos (se ignoran puntos, guiones y espacios) y no puede repetirse. Los DNI vacíos no cuentan como duplicados.

Por seguridad, si `optin` no indica claramente que la persona aceptó recibir promociones, el contacto queda deshabilitado para envíos. Podés habilitarlo manualmente solo cuando tengas constancia de autorización.

### Exportar contactos

En la lista de clientes, el botón **Exportar CSV** descarga **todos** los contactos en un archivo con el mismo formato de la importación (`nombre, telefono, dni, optin`). Sirve para respaldar la agenda o moverla a otro equipo, y el archivo se puede volver a importar tal cual.

## Editar contactos

Desde la página **Clientes** podés editar cualquier contacto con el botón **Editar** de la tabla: se abre un formulario para cambiar **nombre, teléfono, DNI y autorización**. La lista muestra además la columna **DNI**.

Las mismas validaciones del alta se aplican al editar: el teléfono se normaliza (mismo número en distintos formatos cuenta como duplicado) y el DNI debe tener 7 u 8 dígitos. Si el teléfono o el DNI ya pertenecen a **otro** contacto, la edición se rechaza con un aviso. Dejar el DNI vacío lo borra del contacto.

## Formato de texto

Al escribir un mensaje o un estado tenés una **barra de formato** con los estilos que entiende WhatsApp y una **vista previa en vivo**:

- **Negrita** (`*texto*`), *Cursiva* (`_texto_`), ~~Tachado~~ (`~texto~`) y `Monoespaciado` (``` ```texto``` ```).
- **Cita** (`> texto`) y **listas** con viñetas (`- texto`) o numeradas (`1. texto`).
- **Título** y **Subtítulo**: WhatsApp no tiene títulos nativos, así que se generan con negrita/cursiva en su propia línea.

Seleccioná el texto y tocá un botón para aplicarlo (volver a tocar el mismo botón lo quita). Sin selección, el botón actúa sobre la línea actual o inserta los marcadores en el cursor. La vista previa muestra cómo quedará; los caracteres especiales se escapan, así que pegar texto con `<` o `>` no rompe nada.

## Emojis

El botón **😀** abre un selector de emojis organizado por categorías (caras, gestos, corazones, promos y compras, comida y símbolos). Se insertan en la posición del cursor y respetan el formato del texto.

El set está **curado a propósito**: usa emojis antiguos y muy extendidos (Unicode 6–9), sin secuencias combinadas (ZWJ), sin modificadores de tono de piel y sin banderas. Esto evita el problema clásico de emojis que se ven bien en iOS pero no renderizan en Android (o al revés). Aun así, el render final siempre depende de la versión de WhatsApp y del sistema del destinatario.

## Borradores

Mientras redactás un mensaje o un estado, el panel **guarda el borrador automáticamente en el servidor** (SQLite). Como queda en el servidor y no en el navegador, el mismo borrador está disponible desde la PC y desde el celular.

- Se guardan el **texto**, el **tipo** (texto/imagen/video) y, en "Enviar mensaje", los **destinatarios** seleccionados. **No se guardan imágenes ni videos**: el navegador no puede volver a cargar un archivo por seguridad, así que solo se conserva el estado de redacción.
- El guardado es **automático** (unos 800 ms después de que dejás de escribir) y se fuerza al salir o cambiar de pestaña. Debajo del cuadro ves el estado: "Guardando…", "Borrador guardado", "Borrador restaurado" o "Sin borrador".
- El borrador **se mantiene después de enviar** para que puedas reutilizarlo. El botón **Vaciar borrador** lo elimina y limpia el formulario.
- Un borrador totalmente vacío (sin texto ni destinatarios) no se guarda: se elimina solo.
- El **texto del borrador se cifra** en reposo, igual que el teléfono y el DNI.

## Plantillas de texto

Además del borrador, podés guardar **plantillas**: mensajes ya escritos y reutilizables, para no reescribir lo mismo cada vez.

- Desde **Enviar mensaje** y **Estados**, el desplegable **Plantilla…** carga un texto guardado en el cuadro (también aplica a los destinatarios que ya tengas seleccionados).
- **Guardar como plantilla** crea una nueva a partir del texto actual (te pide un nombre). Si tenés una plantilla cargada, el botón pasa a **Actualizar plantilla** y aparece **Eliminar**.
- Las plantillas viven en el **servidor** (SQLite) y su texto se cifra en reposo, así están disponibles desde la PC y el celular.

## Experiencia de uso

- **Vista previa en vivo** y **contador de caracteres** en los cuadros de mensaje y estado (avisa si superás 1024, el límite de las descripciones de imagen/video).
- **Buscador de destinatarios** en "Enviar mensaje": filtrá por nombre o teléfono y usá "Seleccionar visibles". La selección se mantiene aunque cambies el filtro.
- **Resumen de selección**: muestra cuántos elegiste sobre el total de autorizados.
- **Prevención de doble envío**: los botones de guardar, importar y editar se deshabilitan mientras la operación está en curso.
- **Deshacer al eliminar**: al borrar un cliente aparece un aviso con el botón **Deshacer** durante unos segundos; restaura el contacto con sus datos (nombre, teléfono, DNI y autorización).
- **Borradores en el servidor**: el texto y los destinatarios que estás redactando se guardan solos y se restauran al volver, estés en la PC o en el celular (ver *Borradores*).
- **Teclado y accesibilidad**: `Esc` cierra el modal y el selector de emojis; los botones de formato y emoji tienen etiquetas `aria`; el aviso (toast) se anuncia con `aria-live`.
- **Pensado para celulares**: la barra de navegación queda fija abajo; las listas de **Clientes** e **Historial** se muestran como **tarjetas** (una por registro, con etiquetas) en lugar de una tabla con scroll horizontal; el selector de emojis se abre como una hoja inferior (nunca se sale de la pantalla) y se cierra al elegir; el aviso con **Deshacer** aparece por encima de la barra para no taparla; y todos los botones y campos tienen un tamaño táctil de ~44px.

## Datos y almacenamiento

- Los datos viven en **SQLite** (`data/promopanel.db`), usando el módulo `node:sqlite` integrado en Node 24 (sin dependencias nativas ni servidor de base de datos).
- **Teléfono y DNI se guardan cifrados** con AES-256-GCM. Para detectar duplicados y garantizar la unicidad sin descifrar, se usa un **índice ciego** (HMAC-SHA256).
- Los **borradores de redacción** también viven en la base (tabla `drafts`, uno por sección) y su texto se cifra con el mismo esquema.
- La clave sale de `ENCRYPTION_KEY`; si no la definís, se genera y guarda en `data/.key` (con permisos restringidos). **Si perdés la clave, los datos cifrados no se pueden recuperar.**
- La búsqueda y el filtrado se hacen en el navegador sobre los datos ya descifrados por la API, así que el cifrado no afecta la experiencia de uso.
- **Migración automática:** si la base está vacía y existen `data/contacts.json` / `data/history.json` del formato anterior, se importan al arrancar. Los JSON **no se borran**: quedan como respaldo.
- El historial se recorta automáticamente a los últimos 1000 registros.

## Funciones

- **Mensajes individuales** de texto, imagen y video MP4 a los clientes seleccionados que estén habilitados. Podés adjuntar **varias imágenes** en una misma campaña (se envían una por una, con el texto como pie de la primera).
- **Plantillas de texto** reutilizables y preseleccionables (ver *Plantillas de texto*).
- Publicar texto, imagen o video MP4 en el estado del número conectado (allContacts=true en Evolution API).
- Historial local de operaciones.
- Normalización de teléfonos y detección de duplicados por teléfono **y DNI**.
- Exportación de la lista de contactos a CSV (mismo formato que la importación).
- Conexión de WhatsApp por **código QR** o **código de vinculación** (para vincular desde el mismo celular), con la **cuenta conectada** visible (número y nombre) y botón para **desvincular**.
- Edición de contactos (nombre, teléfono, DNI y autorización) desde la interfaz.
- Formato de texto estilo WhatsApp (negrita, cursiva, tachado, monoespaciado, citas y listas) con vista previa en vivo y selector de emojis compatibles.
- Borradores de redacción guardados en el servidor, disponibles desde cualquier equipo (texto, tipo y destinatarios; sin adjuntos).
- Inicio de sesión con cookie de sesión (`HttpOnly`, `SameSite=Strict`) y cierre de sesión.
- Envío de campañas en segundo plano con progreso en vivo; la petición HTTP responde al instante.
- Límite de intentos de acceso y de solicitudes a la API para mitigar abuso.
- Cabeceras de seguridad (CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, HSTS sobre HTTPS) y `Cache-Control: no-store` en la API.
- Base de datos transaccional con cifrado de datos sensibles en reposo.

## Límites de esta versión

- No es un CRM completo ni una plataforma multiusuario.
- Los datos se guardan en SQLite dentro de `data/`; hacé backup de esa carpeta (y de la clave de cifrado).
- Los trabajos de envío viven en memoria: si el servidor se reinicia durante una campaña, el progreso en curso se pierde (lo ya enviado queda en el historial). No hay reintentos automáticos.
- Entre envíos se aplica una pausa **aleatoria** (`SEND_DELAY_MS` + jitter) y un descanso largo cada `SEND_BATCH_SIZE` mensajes, para reducir el riesgo de bloqueos y no enviar con un patrón constante. Por eso una campaña grande tarda proporcionalmente.
- El estado se publica para la audiencia que permita la privacidad del WhatsApp conectado; no es un envío individual a cada cliente.
- El panel registra la respuesta de la API, pero no recibe confirmaciones finales de entrega/lectura mediante webhooks.
- Para video se limita a MP4. Respetá los límites de tamaño de tu instancia Evolution API y de WhatsApp.
- En una campaña con imágenes/videos se envían **una por una** a cada persona (no como álbum) y hay un máximo de archivos por envío (`MAX_SEND_FILES`, 10 por defecto).
- El QR o el código de vinculación pueden requerir adaptar la lectura de respuesta según la versión de Evolution API instalada. El código de vinculación solo se genera si la instancia está desconectada; si ya se generó un QR, la instancia queda en estado *connecting* y puede no devolver código.

## Endpoints Evolution API utilizados

- `GET /instance/connectionState/{instance}`
- `GET /instance/connect/{instance}`
- `POST /message/sendText/{instance}`
- `POST /message/sendMedia/{instance}`
- `POST /message/sendStatus/{instance}`

## Endpoints propios del panel

- `GET /health` — estado del servicio (sin autenticación, para healthchecks).
- `GET /login`, `POST /login`, `POST /logout` — sesión del panel.
- `POST /api/send` — inicia una campaña y devuelve `{ jobId, total }`.
- `GET /api/jobs/{id}` — progreso y resultado de una campaña.
- `GET /api/drafts` — lista los borradores guardados.
- `PUT /api/drafts/{section}` — guarda el borrador de `send` o `status` (un borrador vacío lo elimina).
- `DELETE /api/drafts/{section}` — elimina el borrador de una sección.
- `GET /api/templates`, `POST /api/templates` — listar y crear plantillas de texto.
- `PATCH /api/templates/{id}`, `DELETE /api/templates/{id}` — editar y borrar una plantilla.

Documentación de referencia:
- https://github.com/EvolutionAPI/evolution-api
- https://docs.evoapicloud.com/api-reference/message-controller/send-status

## Seguridad y mantenimiento

- Cambiá la contraseña de ejemplo antes de publicar.
- Usá HTTPS y restringí el acceso al panel. Las cookies se marcan `Secure` automáticamente detrás de HTTPS.
- No subas `.env` a GitHub (ya está en `.gitignore` y `.dockerignore`).
- Protegé el VPS y hacé copias de seguridad periódicas de `data/` (base de datos y clave de cifrado).
- Guardá la clave de cifrado (`ENCRYPTION_KEY` o `data/.key`) en un lugar seguro y fuera de los respaldos en la nube si querés que el cifrado sea realmente útil: quien tenga la clave y la base puede descifrar los datos.
- El DNI es opcional para esta herramienta; evitá almacenar datos que no sean necesarios.
