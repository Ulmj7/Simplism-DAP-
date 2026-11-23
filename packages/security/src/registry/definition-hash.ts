import type { AnyActionDefinition, JsonValue, Sha256Hex } from "@dap/contracts";
import { sha256Canonical } from "../validation/canonical.js";

export function definitionHash(definition: AnyActionDefinition, inputSchemaJson: JsonValue): Sha256Hex {
  const { id, version, risk, requiredPermission, allowedPages, confirmation, changesState } = definition;
  return sha256Canonical({ id, version, risk, requiredPermission, allowedPages, confirmation, changesState, inputSchemaJson });
}

export function registryFingerprint(hashes: readonly Sha256Hex[]): Sha256Hex {
  return sha256Canonical([...hashes].sort());
}
