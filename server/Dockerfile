# Use the official Debian Bookworm image
FROM debian:stable

# Install the apt package to allow fetching packages without updating
RUN apt-get install -y --no-install-recommends apt

# Download and install the debian-archive-keyring package directly
RUN apt install -y --no-install-recommends debian-archive-keyring

# Now that the keyring and sources are configured, perform a secure apt-get update
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl gnupg ca-certificates lsb-release wget && \
    rm -rf /var/lib/apt/lists/*

# Add NodeSource repository for Node.js 18
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash -

# Install Node.js and other required packages
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    nodejs \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxi6 \
    libxtst6 \
    libnss3 \
    libxrandr2 \
    libasound2 \
    libatk1.0-0 \
    libpangocairo-1.0-0 \
    libcups2 \
    libxss1 \
    libgconf-2-4 \
    libxshmfence1 \
    chromium && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy server source code and related files into the container
COPY . .

# Install Node.js dependencies
RUN npm install

RUN npm run build

# Generate Prisma client
RUN npx prisma generate

# Expose the application's port (adjust as needed)
EXPOSE 8080

# Start the application
# If you have a "start" script in package.json:
CMD ["sh", "-c", "sleep 10 && npx prisma generate && npx prisma migrate deploy && node dist/node.js"]

