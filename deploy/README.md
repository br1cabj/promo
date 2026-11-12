# Despliegue en VPS con Coolify (stack completo)

Este stack levanta **todo en un solo recurso de Coolify**: PromoPanel + Evolution
API v2 + PostgreSQL + Redis. Los servicios comparten la red interna del recurso,
así que el panel habla con Evolution por su nombre de servicio
(`http://evolution-api:8080`) sin exponer Evolution a Internet. **Solo el panel
necesita un dominio.**

Archivos:

- `docker-compose.coolify.yml` — el stack.
- `env.example` — la lista de variables que hay que cargar en Coolify.

---

## 0. Requisitos del VPS

- Docker + Coolify instalados (Coolify ya los gestiona).
- **Recomendado: 2 GB de RAM** (Evolution API + PostgreSQL + Redis + panel). Con
  1 GB puede funcionar, pero ajustá los límites del paso 4 y considerá limitar la
  memoria de cada contenedor en Coolify.
- Un dominio o subdominio apuntando a la IP del VPS (ver *Dominio gratis*).

---

## 1. Dominio gratis

Cualquiera de estas opciones sirve para el panel (Coolify emite el certificado
HTTPS con Let's Encrypt automáticamente):

| Opción | Nombre resultante | Costo | Notas |
|---|---|---|---|
| **DuckDNS** | `tupanel.duckdns.org` | Gratis | La más simple y probada. Te deja hasta 5 subdominios. Creás uno, ponés la IP del VPS y listo. |
| **is-a.dev** | `tupanel.is-a.dev` | Gratis | Se pide con un pull request en GitHub. Se ve más "profesional". |
| **thedev.id** | `tupanel.thedev.id` | Gratis | Igual que is-a.dev (fork + PR). Para proyectos de devs. |
| **eu.org** | `tupanel.eu.org` | Gratis | El más "serio", pero la aprobación tarda ~2 semanas. |
| **sslip.io** | `panel.TU-IP.sslip.io` | Gratis | Cero configuración: el nombre ya resuelve a tu IP. Ideal para probar ya. |

> **Recomendación:** empezá con **DuckDNS** (5 minutos) o **sslip.io** (instantáneo,
> sin registro) para probar, y si querés algo más lindo pedí un **is-a.dev**.

### DuckDNS paso a paso
1. Entrá a <https://www.duckdns.org> e iniciá sesión (Google/GitHub).
2. Creá un subdominio, por ejemplo `promopanel`. Queda `promopanel.duckdns.org`.
3. En el campo **current ip**, poné la **IP pública de tu VPS** y guardá.
4. Verificá con `nslookup promopanel.duckdns.org` (debe devolver la IP del VPS).

> Coolify puede emitir certificados para `*.duckdns.org`, `*.is-a.dev`, `*.eu.org`
> y `*.sslip.io` sin problema porque están en la lista de sufijos públicos.

---

## 2. Subir el código a GitHub

Usá un repositorio **privado** (este proyecto ya está preparado: `.gitignore` y
`.dockerignore` dejan afuera `.env` y `data/`).

---

## 3. Crear el recurso en Coolify

1. Coolify → **Keys & Tokens** → conectá tu GitHub (GitHub App o Deploy Key).
2. **Projects** → tu proyecto → **New Resource** → **Docker Compose** (o
   *Docker Compose from Git*).
3. Elegí el repositorio y la rama `main`.
4. **Base Directory**: `/deploy`
5. **Docker Compose Location**: `docker-compose.coolify.yml`

---

## 4. Variables de entorno

En **Environment Variables**, cargá las de `deploy/env.example`. Las
imprescindibles:

| Variable | Qué poner |
|---|---|
| `PANEL_USER` | tu usuario |
| `PANEL_PASSWORD` | contraseña larga y única |
| `ENCRYPTION_KEY` | 64 hex (ver comando abajo) |
| `EVOLUTION_API_KEY` | una clave larga y aleatoria (la usan panel y Evolution) |
| `POSTGRES_PASSWORD` | otra clave larga |
| `DEFAULT_COUNTRY` | `AR` (o tu país) |
| `EVOLUTION_INSTANCE` | `promociones` |

Generá las claves:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Los límites de subida y el ritmo de envío ya vienen con valores pensados para un
VPS chico; podés ajustarlos.

---

## 5. Dominio y deploy

1. En el recurso → **Domains** → **Add domain**.
2. Elegí el servicio **`promopanel`**, protocolo `https`, el hostname
   (ej. `promopanel.duckdns.org`) y puerto interno **3000**.
3. **Deploy**. En los **Deployment Logs** esperá a que arranquen los 4 servicios
   (la primera vez Evolution tarda 1–2 minutos en migrar la base).
4. Abrí `https://promopanel.duckdns.org` e ingresá con `PANEL_USER` / `PANEL_PASSWORD`.

---

## 6. Conectar WhatsApp

1. En el panel, entrá a la página **WhatsApp**.
2. Tocá **Conectar**. El panel crea la instancia automáticamente (si no existe) y
   muestra el **QR**.
3. Escanealo desde el teléfono: WhatsApp → **Dispositivos vinculados** → **Vincular
   un dispositivo**.
4. Cuando la página muestre *"WhatsApp conectado"*, ya podés importar contactos y enviar.

---

## 7. Actualizaciones y backups

- **Actualizar:** `git push` a `main` y en Coolify tocá **Redeploy** (o activá
  *Auto Deploy* con el webhook). Los datos quedan en los volúmenes.
- **Backups:** respaldá los volúmenes `promopanel_data` (base del panel + clave),
  `evolution_postgres`, `evolution_instances` y `evolution_redis`. Y guardá
  `ENCRYPTION_KEY` y `EVOLUTION_API_KEY` aparte.

---

## Alternativa: recursos separados

Si preferís desplegar Evolution por un lado y el panel por otro (por ejemplo, para
reusar Evolution en otros proyectos), podés:

1. Usar el **servicio de un clic "Evolution API"** que trae Coolify (ya incluye
   Postgres + Redis).
2. Crear el panel como **Application** con Build Pack **Dockerfile**
   (Base Directory `/`).
3. Conectar ambos: en el panel, `EVOLUTION_URL` apuntando a Evolution. Lo más
   simple es darle a Evolution un dominio propio
   (ej. `https://evo.tudominio.com`) y usar esa URL; o activar **Connect To
   Predefined Network** en el servicio de Evolution y usar el nombre interno.

El stack de este `deploy/` es la opción recomendada para un VPS chico porque todo
queda en una sola red privada y necesita un solo dominio.
