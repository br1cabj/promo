FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# Límite de heap para no agotar la RAM de un VPS chico (se puede subir por env).
ENV NODE_OPTIONS=--max-old-space-size=384
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
