// The model did not answer at all (server off, asleep, unreachable, or failing), as opposed to
// answering something unusable. Processing stops so the remaining transactions are left untouched
// and tried again next run, instead of each being tagged as "not guessed" for good.
export default class ModelUnavailableException extends Error {
  public readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'ModelUnavailableException';
    this.cause = options?.cause;
  }
}
