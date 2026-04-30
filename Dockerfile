FROM node:20-alpine

WORKDIR /app

# Backend dependencies
COPY backend/package.json ./backend/
RUN cd backend && npm install --production

# Copy all files
COPY . .

# Create data directory
RUN mkdir -p backend/data

EXPOSE 3337

CMD ["node", "backend/server.js"]
