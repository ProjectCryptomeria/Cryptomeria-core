-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "address" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'client',
    "encryptedMnemonic" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Scenario" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "config" TEXT NOT NULL,
    "lastModified" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Result" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scenarioName" TEXT NOT NULL,
    "executedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "uploadType" TEXT NOT NULL,
    "allocator" TEXT NOT NULL,
    "transmitter" TEXT NOT NULL,
    "targetChainCount" INTEGER NOT NULL,
    "usedChains" TEXT NOT NULL,
    "dataSizeMB" INTEGER NOT NULL,
    "chunkSizeKB" INTEGER NOT NULL,
    "totalTxCount" INTEGER NOT NULL,
    "uploadTimeMs" INTEGER NOT NULL,
    "downloadTimeMs" INTEGER NOT NULL,
    "throughputBps" REAL NOT NULL,
    "totalGasUsed" REAL,
    "logs" TEXT,
    "errorMessage" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "User_address_key" ON "User"("address");

-- CreateIndex
CREATE UNIQUE INDEX "Scenario_name_key" ON "Scenario"("name");
