# glibc-based image (bookworm) for the broadest OneAgent Node.js
# auto-instrumentation compatibility.
FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY loadgen.js ./

CMD ["node", "loadgen.js"]
