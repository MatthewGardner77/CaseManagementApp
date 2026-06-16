# glibc-based image (bookworm) for the broadest OneAgent Node.js
# auto-instrumentation compatibility.
FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV PORT=3002
EXPOSE 3002

CMD ["node", "server.js"]
