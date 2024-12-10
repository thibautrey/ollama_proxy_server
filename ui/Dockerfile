# Stage 1: Build the React UI
FROM node:18 as build
WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm install

# Copy the rest of the UI source code
COPY . .

# Build the production-ready files
RUN npm run build

# Stage 2: Serve the UI with Nginx
FROM nginx:stable-alpine
# Copy build output from previous stage
COPY --from=build /app/dist /usr/share/nginx/html

# Expose port 80 for the UI
EXPOSE 80

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]
