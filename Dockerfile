FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        fonts-dejavu-core \
        fonts-liberation \
        wget \
        wkhtmltopdf \
    && wkhtmltopdf --version \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Backend dependencies
COPY backend/package.json ./backend/
RUN cd backend && npm install --production

# Outils de build (couche mise en cache tant que package.json ne change pas)
COPY package.json tailwind.config.js ./
RUN npm install --include=dev

# Copy all files
COPY . .

# Build Tailwind CSS : impérativement après la copie des sources, sinon
# tailwind.config.js n'a aucun markup à scanner et le COPY précédent
# écraserait le résultat par le fichier versionné.
RUN node_modules/.bin/tailwindcss -i frontend/tailwind.input.css -o frontend/tailwind.css --minify && \
    npm prune --production

# Create data directory
RUN mkdir -p backend/data

EXPOSE 3337

CMD ["node", "backend/server.js"]
