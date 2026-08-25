/**
 * COMPATIBILITY IDENTITIES.
 *
 * A deployed appliance must be diagnosable from a single record of exactly
 * which contracts were running when something went wrong. This is a manifest,
 * not a compatibility service.
 */
export interface VersionManifest {
  readonly appVersion: string;
  readonly apiVersion: string;
  readonly schemaVersion: string;
  readonly scaleProtocolVersion: string;
  readonly nutritionCalcVersion: string;
  readonly energyPolicyVersion: string;
  readonly voiceParserVersion: string;
  readonly assistantContractVersion: string;
  readonly foodLogFoldVersion: string;
}

export const ASSISTANT_CONTRACT_VERSION = 'assistant-tool-router@1.0.0';
export const API_VERSION = 'macros-api@1.0.0';
