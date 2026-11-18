/** Exact settings bytes shared by the transaction engine and read-only audit.
 * Inputs are already schema-validated; this helper grants no authorization.
 */
import { prettyJson, type JsonObject, type JsonValue } from './json.ts';
import { invalid } from './errors.ts';
import { LIMITS, type PackageDecl } from './schema.ts';

export function renderSettings(settings: JsonObject, packages: readonly PackageDecl[]): Buffer | null {
  if (Object.keys(settings).length === 0 && packages.length === 0) return null;
  const doc = Object.create(null) as JsonObject;
  for (const key of Object.keys(settings)) doc[key] = settings[key];
  if (packages.length > 0) doc.packages = packages as JsonValue[];
  const bytes = Buffer.from(prettyJson(doc), 'utf8');
  if (bytes.length > LIMITS.fileBytes) throw invalid('settings-too-large');
  return bytes;
}
