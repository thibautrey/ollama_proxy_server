import { Model } from "@prisma/client";

import { prisma } from "./prismaClient.js";

export async function createModel(
  name: string,
  size: number,
  serverId?: string
): Promise<Model> {
  return prisma.model.create({
    data: {
      name,
      size,
      serverId: serverId || null,
    },
  });
}

export async function getModelById(id: string): Promise<Model | null> {
  return prisma.model.findUnique({
    where: { id },
    include: { Server: true },
  });
}

export async function listModels(): Promise<Model[]> {
  return prisma.model.findMany({ include: { Server: true } });
}

export async function updateModel(
  id: string,
  data: Partial<Model>
): Promise<Model> {
  return prisma.model.update({
    where: { id },
    data,
    include: { Server: true },
  });
}

export async function deleteModel(id: string): Promise<Model> {
  return prisma.model.delete({
    where: { id },
  });
}
