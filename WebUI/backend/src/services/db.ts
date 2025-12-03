// WebUI/backend/src/services/db.ts

import { PrismaClient } from "@prisma/client/extension";

// Prisma v7: datasourceUrl をコンストラクタで渡す
export const prisma = new PrismaClient({
	datasourceUrl: process.env.DATABASE_URL || "file:./dev.db",
});