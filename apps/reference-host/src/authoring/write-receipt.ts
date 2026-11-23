import { AsyncLocalStorage } from "node:async_hooks";
import type { StoredWalkthrough } from "./store.js";

/** The Gateway exposes only a closed result category. The host reads the exact committed write
 * via this request-scoped receipt, so a later concurrent writer cannot replace its reply. */
type Receipt = { tenantId: string; id: string; action: string; row?: StoredWalkthrough; currentRevision?: number; failure?: string };
const receipts = new AsyncLocalStorage<Receipt>();
export const authoringReceipt = (tenantId: string, id: string, action: string): Receipt | undefined => {
  const receipt = receipts.getStore();
  return receipt?.tenantId === tenantId && receipt.id === id && receipt.action === action ? receipt : undefined;
};
export async function withAuthoringReceipt<T>(tenantId: string, id: string, action: string, run: () => Promise<T>) {
  const receipt: Receipt = { tenantId, id, action };
  const result = await receipts.run(receipt, run);
  return { result, row: receipt.row, currentRevision: receipt.currentRevision, failure: receipt.failure };
}
