# PromoPanel Lite

Panel web liviano para gestionar contactos y enviar mensajes/estados mediante Evolution API. Incluye importación CSV, selección de clientes autorizados, texto, imágenes, video MP4, historial y conexión QR.

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
   - `SEND_DELAY_MS`: pausa entre envíos (por defecto `1500`).
   - `TRUST_PROXY`: dejalo en `false` salvo que estés detrás de un proxy inverso; ahí poné `true`.
5. Ejecutá:

```bash
docker compose up -d --build
```

6. Abrí `http://IP-DE-TU-VPS:3000`. Aparecerá una pantalla de ingreso; usá el usuario y la contraseña configurados en `.env`. El botón **Salir** cierra la sesión.

En producción, publicá el servicio detrás de un proxy HTTPS (por ejemplo, el proxy de Coolify). No expongas el puerto 3000 directamente a Internet sin HTTPS.

## Instalación en Coolify

La opción más simple es subir el proyecto a un repositorio Git privado y crear un recurso Docker Compose o aplicación Dockerfile en Coolify. Configurá las variables de entorno del `.env` y conservá el volumen persistente `./data`.

Si Evolution API está en otro recurso/stack, asegurate de que ambos contenedores compartan una red Docker y usá su nombre de servicio como `EVOLUTION_URL`. Si no comparten red, usá una URL accesible desde el contenedor PromoPanel.

## Importar contactos

El CSV debe tener encabezados. Columnas admitidas:
- `nombre` (también `name`)
- `telefono` (también `phone`, `celular` o `whatsapp`)
- `dni` (opcional; 7 u 8 dígitos)
- `optin` (si/no, true/false, 1/0)

Los teléfonos se normalizan automáticamente con `libphonenumber-js`: se aceptan con `+`, espacios, guiones o paréntesis, y se guardan en formato canónico (código de país + área + número, solo dígitos). Para Argentina se usa `DEFAULT_COUNTRY=AR`, así que `351 123 4567` y `+54 9 351 123-4567` se reconocen como el mismo número. Si un número no se puede interpretar con la librería pero tiene entre 10 y 15 dígitos, se guarda tal cual.

El **DNI es opcional**. Si lo completás, debe tener 7 u 8 dígitos (se ignoran puntos, guiones y espacios) y no puede repetirse. Los DNI vacíos no cuentan como duplicados.

Por seguridad, si `optin` no indica claramente que la persona aceptó recibir promociones, el contacto queda deshabilitado para envíos. Podés habilitarlo manualmente solo cuando tengas constancia de autorización.

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

## Experiencia de uso

- **Vista previa en vivo** y **contador de caracteres** en los cuadros de mensaje y estado (avisa si superás 1024, el límite de las descripciones de imagen/video).
- **Buscador de destinatarios** en "Enviar mensaje": filtrá por nombre o teléfono y usá "Seleccionar visibles". La selección se mantiene aunque cambies el filtro.
- **Resumen de selección**: muestra cuántos elegiste sobre el total de autorizados.
- **Prevención de doble envío**: los botones de guardar, importar y editar se deshabilitan mientras la operación está en curso.
- **Deshacer al eliminar**: al borrar un cliente aparece un aviso con el botón **Deshacer** durante unos segundos; restaura el contacto con sus datos (nombre, teléfono, DNI y autorización).
- **Teclado y accesibilidad**: `Esc` cierra el modal y el selector de emojis; los botones de formato y emoji tienen etiquetas `aria`; el aviso (toast) se anuncia con `aria-live`.

## Datos y almacenamiento

- Los datos viven en **SQLite** (`data/promopanel.db`), usando el módulo `node:sqlite` integrado en Node 24 (sin dependencias nativas ni servidor de base de datos).
- **Teléfono y DNI se guardan cifrados** con AES-256-GCM. Para detectar duplicados y garantizar la unicidad sin descifrar, se usa un **índice ciego** (HMAC-SHA256).
- La clave sale de `ENCRYPTION_KEY`; si no la definís, se genera y guarda en `data/.key` (con permisos restringidos). **Si perdés la clave, los datos cifrados no se pueden recuperar.**
- La búsqueda y el filtrado se hacen en el navegador sobre los datos ya descifrados por la API, así que el cifrado no afecta la experiencia de uso.
- **Migración automática:** si la base está vacía y existen `data/contacts.json` / `data/history.json` del formato anterior, se importan al arrancar. Los JSON **no se borran**: quedan como respaldo.
- El historial se recorta automáticamente a los últimos 1000 registros.

## Funciones

- Mensajes individuales de texto, imagen y video MP4 a los clientes seleccionados que estén habilitados.
- Publicar texto, imagen o video MP4 en el estado del número conectado (allContacts=true en Evolution API).
- Historial local de operaciones.
- Normalización de teléfonos y detección de duplicados por teléfono **y DNI**.
- Edición de contactos (nombre, teléfono, DNI y autorización) desde la interfaz.
- Formato de texto estilo WhatsApp (negrita, cursiva, tachado, monoespaciado, citas y listas) con vista previa en vivo y selector de emojis compatibles.
- Inicio de sesión con cookie de sesión (`HttpOnly`, `SameSite=Strict`) y cierre de sesión.
- Envío de campañas en segundo plano con progreso en vivo; la petición HTTP responde al instante.
- Límite de intentos de acceso y de solicitudes a la API para mitigar abuso.
- Cabeceras de seguridad (CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, HSTS sobre HTTPS) y `Cache-Control: no-store` en la API.
- Base de datos transaccional con cifrado de datos sensibles en reposo.

## Límites de esta versión

- No es un CRM completo ni una plataforma multiusuario.
- Los datos se guardan en SQLite dentro de `data/`; hacé backup de esa carpeta (y de la clave de cifrado).
- Los trabajos de envío viven en memoria: si el servidor se reinicia durante una campaña, el progreso en curso se pierde (lo ya enviado queda en el historial). No hay reintentos automáticos.
- Entre envíos se aplica una pausa (`SEND_DELAY_MS`) para reducir el riesgo de bloqueos; por eso una campaña grande tarda proporcionalmente.
- El estado se publica para la audiencia que permita la privacidad del WhatsApp conectado; no es un envío individual a cada cliente.
- El panel registra la respuesta de la API, pero no recibe confirmaciones finales de entrega/lectura mediante webhooks.
- Para video se limita a MP4. Respetá los límites de tamaño de tu instancia Evolution API y de WhatsApp.
- El QR puede requerir adaptar la lectura de respuesta según la versión de Evolution API instalada.

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
