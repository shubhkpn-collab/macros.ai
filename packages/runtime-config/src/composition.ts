import {
  allowsSyntheticProviders, isServerConfig,
  type AnyRuntimeConfig, type RuntimeConfig,
} from './config.js';
import { appError, type AppError } from './errors.js';

/**
 * COMPOSITION ROOT CONTRACT.
 *
 * Dependency construction belongs at the edge. Domain and application code
 * never reads `process.env`, never constructs a database client and never
 * instantiates a provider SDK — everything is assembled here and injected.
 *
 * This module stays PURE: it decides WHAT should be built and refuses illegal
 * combinations. The actual construction happens in the executable edge, which
 * is the only place allowed to touch IO.
 */

export type ComponentKind = 'auth' | 'assistant' | 'scale' | 'activity' | 'catalog';

export interface ComponentPlan {
  readonly component: ComponentKind;
  readonly implementation: 'synthetic' | 'real';
}

export interface CompositionPlan {
  readonly environment: RuntimeConfig['environment'];
  readonly components: readonly ComponentPlan[];
  /** Whether this runtime is permitted to hold privileged DB credentials. */
  readonly privilegedDatabaseAllowed: boolean;
}

/**
 * Known synthetic implementations. Named explicitly so the production guard is
 * a lookup rather than a naming convention that a new class could slip past.
 */
export const SYNTHETIC_IMPLEMENTATIONS: readonly string[] = [
  'FakeAssistantInterpreter',
  'AdversarialAssistantInterpreter',
  'ThrowingAssistantInterpreter',
  'FakeAuthSessionProvider',
  'DevScaleAdapter',
  'ScaleSimulator',
  'SyntheticSourceAdapter',
  'InMemoryFoodLogRepository',
  'InMemoryProductVersionRepository',
  'InMemoryUserProfileRepository',
  'InMemoryEnergyGoalRepository',
];

export const isSyntheticImplementation = (name: string): boolean =>
  SYNTHETIC_IMPLEMENTATIONS.includes(name);

/**
 * Build the plan, refusing anything unsafe for the environment.
 *
 * Fails CLOSED: a production runtime that cannot be assembled safely does not
 * start in a partially functional state.
 */
export function planComposition(config: RuntimeConfig): CompositionPlan | AppError {
  const components: ComponentPlan[] = (['auth', 'assistant', 'scale', 'activity', 'catalog'] as const)
    .map((component) => ({ component, implementation: config[component] }));

  if (!allowsSyntheticProviders(config.environment)) {
    const offender = components.find((c) => c.implementation === 'synthetic');
    if (offender !== undefined) {
      return appError(
        'internal',
        'synthetic_provider_in_production',
        'Runtime refused to start.',
        `synthetic ${offender.component} in ${config.environment}`,
      );
    }
  }

  return {
    environment: config.environment,
    components,
    // Presence of a URL is NOT authority. See privilegedDatabaseAuthority.
    privilegedDatabaseAllowed: config.database.privilegedUrl !== null,
  };
}

/**
 * Guard invoked at construction time with the concrete class name.
 *
 * Config validation alone is not enough: it checks what was REQUESTED, while
 * this checks what is actually being INSTANTIATED. A miswired factory that
 * returns a simulator despite `real` config is caught here.
 */
export function assertImplementationAllowed(
  environment: RuntimeConfig['environment'],
  implementationName: string,
): AppError | null {
  if (allowsSyntheticProviders(environment)) return null;
  if (!isSyntheticImplementation(implementationName)) return null;
  return appError(
    'internal',
    'synthetic_provider_in_production',
    'Runtime refused to start.',
    `${implementationName} is not permitted in ${environment}`,
  );
}

/**
 * PRIVILEGED DATABASE AUTHORITY.
 *
 * Authority requires a SERVER role AND an explicitly configured privileged
 * connection. A connection string alone never confers it: possession of a
 * credential is not the same as being permitted to use it, and a tablet must
 * not be able to construct a privileged factory even if one is somehow present.
 */
export type PrivilegedAuthority =
  | { readonly granted: true; readonly connection: string }
  | { readonly granted: false; readonly reason: 'not_server_role' | 'not_configured' };

export function privilegedDatabaseAuthority(config: AnyRuntimeConfig): PrivilegedAuthority {
  if (!isServerConfig(config)) return { granted: false, reason: 'not_server_role' };
  const url = config.database.privilegedUrl;
  if (url === null || url.length === 0) return { granted: false, reason: 'not_configured' };
  return { granted: true, connection: url };
}

/**
 * The only way to obtain a privileged database client.
 *
 * Returns null rather than throwing, so a tablet code path that asks for one
 * simply cannot have it — there is no branch in which it receives a client.
 */
export function createPrivilegedDatabaseFactory<T>(
  config: AnyRuntimeConfig,
  construct: (connection: string) => T,
): T | null {
  const authority = privilegedDatabaseAuthority(config);
  return authority.granted ? construct(authority.connection) : null;
}
