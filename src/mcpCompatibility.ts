import metadata from '../plugin/compatibility.json';
import { version } from '../package.json';

export interface CompatibilityInfo { version?: string; features?: readonly string[]; formatGuideSha256?: string }
export interface PluginMetadata extends CompatibilityInfo { version: string; features: string[] }
export const CURRENT_COMPATIBILITY = {version, features: metadata.features, formatGuideSha256: metadata.formatGuideSha256};
const validVersion = (value: unknown): value is string => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value) && value.length < 100;
export function parsePluginMetadata(value: unknown): PluginMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!validVersion(item.version) || !Array.isArray(item.features) || item.features.length > 32 ||
      !item.features.every(feature => typeof feature === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(feature))) return undefined;
  if (item.formatGuideSha256 !== undefined && (typeof item.formatGuideSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.formatGuideSha256))) return undefined;
  return {version: item.version, features: [...item.features], ...(item.formatGuideSha256 ? {formatGuideSha256: item.formatGuideSha256 as string} : {})};
}
export function pluginFromEnvironment(raw: string | undefined): PluginMetadata | undefined {
  if (!raw || raw.length > 8192) return undefined;
  try { return parsePluginMetadata(JSON.parse(raw)); } catch { return undefined; }
}
export function compatibilityWarnings(remote: CompatibilityInfo, current: CompatibilityInfo = CURRENT_COMPATIBILITY): string[] {
  const warnings: string[] = [];
  if (!remote.version) warnings.push('Version was not reported. Update the component and reconnect to verify compatibility.');
  else if (remote.version !== current.version) warnings.push(`Release versions differ (${remote.version} / ${current.version}). Update the extension and plugin together, then reconnect the MCP client.`);
  if (!remote.features) warnings.push('Supported features were not reported. Read the current rr_get_format guide before creating requests.');
  else {
    const missing = (current.features ?? []).filter(feature => !remote.features!.includes(feature));
    if (missing.length) warnings.push('Missing supported features: ' + missing.join(', ') + '. Update before using these features.');
  }
  if (remote.formatGuideSha256 && current.formatGuideSha256 && remote.formatGuideSha256 !== current.formatGuideSha256) {
    warnings.push('The bundled format guides differ. Refresh the plugin and read rr_get_format from the current adapter.');
  }
  return warnings;
}
