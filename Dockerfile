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

# Build Tailwind CSS (devDependencies needed only for this step)
COPY package.json tailwind.config.js ./
COPY frontend/tailwind.input.css ./frontend/
RUN npm install --include=dev && \
    node_modules/.bin/tailwindcss -i frontend/tailwind.input.css -o frontend/tailwind.css --minify && \
    npm prune --production

# Copy all files
COPY . .

# Create data directory
RUN mkdir -p backend/data

EXPOSE 3337

CMD ["node", "backend/server.js"]
