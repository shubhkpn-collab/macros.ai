/** Privacy-minimal pilot accounting: token counts only, never conversation text. */
export interface PilotUsage {responses:number;inputTokens:number;outputTokens:number;cachedInputTokens:number;inputAudioTokens:number;outputAudioTokens:number;missingUsageResponses:number}
export const emptyPilotUsage = (): PilotUsage => ({responses:0,inputTokens:0,outputTokens:0,cachedInputTokens:0,inputAudioTokens:0,outputAudioTokens:0,missingUsageResponses:0});
const object = (value:unknown):Record<string,unknown> => value !== null && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
const count = (value:unknown):number => typeof value==='number' && Number.isSafeInteger(value) && value>=0 ? value : 0;
export function addPilotUsage(total:PilotUsage,raw:unknown):PilotUsage {
  const usage=object(raw),input=object(usage.input_token_details),output=object(usage.output_token_details);
  const valid=typeof usage.input_tokens==='number' && typeof usage.output_tokens==='number' && Number.isSafeInteger(usage.input_tokens) && Number.isSafeInteger(usage.output_tokens) && usage.input_tokens>=0 && usage.output_tokens>=0;
  return {responses:total.responses+1,inputTokens:total.inputTokens+count(usage.input_tokens),outputTokens:total.outputTokens+count(usage.output_tokens),cachedInputTokens:total.cachedInputTokens+count(input.cached_tokens),inputAudioTokens:total.inputAudioTokens+count(input.audio_tokens),outputAudioTokens:total.outputAudioTokens+count(output.audio_tokens),missingUsageResponses:total.missingUsageResponses+(valid?0:1)};
}
