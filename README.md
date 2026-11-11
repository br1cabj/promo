# PromoPanel Lite

Panel web liviano para gestionar contactos y enviar mensajes/estados mediante Evolution API. Incluye importación CSV, selección de clientes autorizados, texto, imágenes, video MP4, historial y conexión QR.

> **Importante:** Evolution API con conexión WhatsApp Web es una integración no oficial. Meta puede restringir cuentas que utilicen clientes no oficiales o envíen mensajes no deseados. No hay garantía de evitar bloqueos. Usá únicamente contactos que hayan dado consentimiento y respetá las bajas. La publicación de estados y los formatos aceptados pueden variar según la versión de Evolution API y WhatsApp.

## Requisitos

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
5. Ejecutá:

```bash
docker compose up -d --build
```

6. Abrí `http://IP-DE-TU-VPS:3000`. El navegador solicitará usuario y contraseña configurados en `.env`.

En producción, publicá el servicio detrás de un proxy HTTPS (por ejemplo, el proxy de Coolify). No expongas el puerto 3000 directamente a Internet sin HTTPS.

## Instalación en Coolify

La opción más simple es subir el proyecto a un repositorio Git privado y crear un recurso Docker Compose o aplicación Dockerfile en Coolify. Configurá las variables de entorno del `.env` y conservá los volúmenes persistentes `./data` y `./uploads`.

Si Evolution API está en otro recurso/stack, asegurate de que ambos contenedores compartan una red Docker y usá su nombre de servicio como `EVOLUTION_URL`. Si no comparten red, usá una URL accesible desde el contenedor PromoPanel.

## Importar contactos

El CSV debe tener encabezados. Columnas admitidas:
- `nombre` (también `name`)
- `telefono` (también `phone`, `celular` o `whatsapp`)
- `dni` (opcional)
- `optin` (si/no, true/false, 1/0)

Los números deben incluir código de país y área, solo dígitos. Para Argentina, normalmente se guardan con 54 + código de área + número, sin `+` ni espacios. Verificá el formato con tus propios números antes de importar toda la base.

Por seguridad, si `optin` no indica claramente que la persona aceptó recibir promociones, el contacto queda deshabilitado para envíos. Podés habilitarlo manualmente solo cuando tengas constancia de autorización.

## Funciones

- Mensajes individuales de texto, imagen y video MP4 a los clientes seleccionados que estén habilitados.
- Publicar texto, imagen o video MP4 en el estado del número conectado (allContacts=true en Evolution API).
- Historial local de operaciones.
- Detección de teléfonos duplicados durante la importación.
- Credenciales del panel mediante autenticación básica HTTP.

## Límites de esta versión

- No es un CRM completo ni una plataforma multiusuario.
- Los datos se guardan en archivos JSON locales; hacé backup de la carpeta `data/` y `uploads/`.
- No hay cola persistente ni reintentos automáticos. Los mensajes de una campaña se procesan secuencialmente.
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

Documentación de referencia:
- https://github.com/EvolutionAPI/evolution-api
- https://docs.evoapicloud.com/api-reference/message-controller/send-status

## Seguridad y mantenimiento

- Cambiá la contraseña de ejemplo antes de publicar.
- Usá HTTPS y restringí el acceso al panel.
- No subas `.env` a GitHub.
- Protegé el VPS y hacé copias de seguridad periódicas de `data/` y `uploads/`.
- El DNI es opcional para esta herramienta; evitá almacenar datos que no sean necesarios.
