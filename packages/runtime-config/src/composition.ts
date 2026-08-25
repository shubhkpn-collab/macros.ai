import { allowsSyntheticProviders, type RuntimeConfig } from './config.js';
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
    // A tablet build never holds privileged credentials; only a server may.
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
