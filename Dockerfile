FROM node:18-alpine

# Install MongoDB tools and wget for health check
RUN apk add --no-cache mongodb-tools wget

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy application code
COPY backup.js ./
COPY public/ ./public/

# Create backup directory
RUN mkdir -p /backups

# Set up logging directory
RUN mkdir -p /var/log

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S backup -u 1001 -G nodejs

# Change ownership of app and backup directories
RUN chown -R backup:nodejs /app /backups

# Switch to non-root user
USER backup

# Expose web UI port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/current || exit 1

# Start the application
CMD ["node", "backup.js"]
