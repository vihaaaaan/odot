import { generateKeyBetween } from "fractional-indexing";
import type { Transaction } from "../db/connection.js";
import { getAdjacentOrderKey, getBoundaryOrderKey, getLastOrderKey, getTaskOrThrow } from "./queries.js";
import type { MoveTaskInput } from "./inputs.js";

export async function getAppendOrderKey(transaction: Transaction) {
  return generateKeyBetween(await getLastOrderKey(transaction), null);
}

export async function getMovedOrderKey(transaction: Transaction, id: string, placement: MoveTaskInput) {
  if (placement.placement === "first") {
    return generateKeyBetween(null, await getBoundaryOrderKey(transaction, id, "first"));
  }
  if (placement.placement === "last") {
    return generateKeyBetween(await getBoundaryOrderKey(transaction, id, "last"), null);
  }

  const target = await getTaskOrThrow(transaction, placement.targetId);
  const neighbor = await getAdjacentOrderKey(transaction, id, target.orderKey, placement.placement);
  return placement.placement === "before"
    ? generateKeyBetween(neighbor, target.orderKey)
    : generateKeyBetween(target.orderKey, neighbor);
}
