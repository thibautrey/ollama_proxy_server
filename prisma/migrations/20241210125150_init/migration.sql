-- CreateTable
CREATE TABLE "User" (
    "username" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "id" TEXT NOT NULL PRIMARY KEY
);

-- CreateTable
CREATE TABLE "Server" (
    "url" TEXT NOT NULL,
    "queueSize" INTEGER NOT NULL,
    "isDefault" BOOLEAN NOT NULL,
    "id" TEXT NOT NULL PRIMARY KEY
);

-- CreateTable
CREATE TABLE "Model" (
    "name" TEXT NOT NULL,
    "size" REAL NOT NULL,
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT,
    CONSTRAINT "Model_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Server_url_key" ON "Server"("url");
