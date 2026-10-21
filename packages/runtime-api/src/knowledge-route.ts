import {MASTER_KNOWLEDGE} from '@macros/tablet-voice';
import {appError} from '@macros/runtime-config';
import type {Route} from './server.js';
/** Register on the production authenticated HTTPS host. No model credential or personal data. */
export function nutritionKnowledgeRoute():Route {
  return {method:'GET',path:'/knowledge/nutrition',handler:async ctx=>ctx.subject===undefined
    ? appError('authentication','missing_credential','Not signed in.') : MASTER_KNOWLEDGE};
}
