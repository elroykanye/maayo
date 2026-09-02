/**
 * Persistence adapters throw this only when a mutation id loses an atomic
 * uniqueness race. Sync adapters may then acknowledge that duplicate without
 * hiding unrelated database failures.
 */
export class DuplicateMutationError extends Error {
  constructor(message = 'Mutation id already exists') {
    super(message);
    this.name = 'DuplicateMutationError';
  }
}
