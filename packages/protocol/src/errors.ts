/**
 * Persistence adapters throw this only when a mutation id loses an atomic
 * uniqueness race. Sync adapters may then acknowledge that duplicate without
 * hiding unrelated database failures.
 */
export const DUPLICATE_MUTATION_ERROR_CODE = 'MAAYO_DUPLICATE_MUTATION' as const;

export class DuplicateMutationError extends Error {
  readonly code = DUPLICATE_MUTATION_ERROR_CODE;

  constructor(message = 'Mutation id already exists') {
    super(message);
    this.name = 'DuplicateMutationError';
  }
}

/** Recognizes the public conflict signal across ESM/CJS and duplicated package instances. */
export function isDuplicateMutationError(error: unknown): error is DuplicateMutationError {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === DUPLICATE_MUTATION_ERROR_CODE;
}
