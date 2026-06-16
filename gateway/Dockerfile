# glibc-based image (bookworm) for the broadest OneAgent Node.js
# auto-instrumentation compatibility.
FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
