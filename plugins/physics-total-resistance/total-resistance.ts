// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  PhysicsStepError,
  type ResistanceBreakdown,
  type ResistanceContribution,
  type ResistanceInput,
  type ResistanceProvider,
} from '@ridrs/contracts';

/**
 * Asks every provider for its signed force and sums them in source order, so the result does not
 * depend on registration order. A provider that throws or answers a non-finite force fails the
 * step, named as the failing plugin; it is never skipped.
 */
export function totalResistance(
  providers: readonly ResistanceProvider[],
  input: ResistanceInput,
): ResistanceBreakdown {
  const contributions: ResistanceContribution[] = [...providers]
    .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0))
    .map((provider) => {
      let force: number;
      try {
        force = provider.force(input);
      } catch (error) {
        if (error instanceof PhysicsStepError) {
          throw error;
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new PhysicsStepError(`Resistance "${provider.source}" failed: ${reason}`, {
          pluginId: provider.source,
          cause: error,
        });
      }
      if (!Number.isFinite(force)) {
        throw new PhysicsStepError(`Resistance "${provider.source}" returned the force ${force}`, {
          pluginId: provider.source,
        });
      }
      return { source: provider.source, force };
    });
  return {
    total: contributions.reduce((sum, contribution) => sum + contribution.force, 0),
    contributions,
  };
}
