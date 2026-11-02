import fs from 'fs';
import { APICallError, RetryError } from 'ai';
import { TransactionEntity } from '@actual-app/core/src/types/models';
import TransactionService from '../src/transaction-service';
import ActualAiService from '../src/actual-ai';
import InMemoryActualApiService from './test-doubles/in-memory-actual-api-service';
import MockedLlmService from './test-doubles/mocked-llm-service';
import MockedPromptGenerator from './test-doubles/mocked-prompt-generator';
import GivenActualData from './test-doubles/given/given-actual-data';
import SimilarityCalculator from '../src/similarity-calculator';
import CategorySuggestionOptimizer from '../src/category-suggestion-optimizer';
import TagService from '../src/transaction/tag-service';
import RuleMatchStrategy from '../src/transaction/processing-strategy/rule-match-strategy';
import ExistingCategoryStrategy from '../src/transaction/processing-strategy/existing-category-strategy';
import NewCategoryStrategy from '../src/transaction/processing-strategy/new-category-strategy';
import CategorySuggester from '../src/transaction/category-suggester';
import BatchTransactionProcessor from '../src/transaction/batch-transaction-processor';
import TransactionProcessor from '../src/transaction/transaction-processor';
import TransactionFilterer from '../src/transaction/transaction-filterer';
import PayeeHistory, { normalizeImportedPayee } from '../src/transaction/payee-history';
import PromptGenerator from '../src/prompt-generator';
import ModelUnavailableException from '../src/exceptions/model-unavailable-exception';
import { isModelUnreachable, ModelHealthCheck } from '../src/utils/model-reachability';
import { PayeeHistoryEntry } from '../src/types';

const tagService = new TagService('#actual-ai-miss', '#actual-ai', '#ai-suggest');

// What the AI SDK throws when LM Studio's port is closed:
// an APICallError wrapping undici's TypeError.
function connectionRefused(): Error {
  const fetchFailed = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 192.168.60.124:1234'), { code: 'ECONNREFUSED' }),
  });
  return new APICallError({
    message: 'Cannot connect to API: connect ECONNREFUSED',
    url: 'http://doitall-prod-01.internal:1234/v1/chat/completions',
    requestBodyValues: {},
    cause: fetchFailed,
    isRetryable: true,
  });
}

function apiError(statusCode: number): Error {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'http://x/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
  });
}

describe('isModelUnreachable', () => {
  it.each([
    ['connection refused', connectionRefused()],
    ['retries exhausted on it', new RetryError({ message: 'Failed after 3 attempts', reason: 'maxRetriesExceeded', errors: [connectionRefused()] })],
    ['a timeout abort', Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })],
    ['a 503', apiError(503)],
    ['a 404 for the model', apiError(404)],
    ['DNS failure', Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })],
  ])('is true for %s', (_name, error) => {
    expect(isModelUnreachable(error)).toBe(true);
  });

  it.each([
    ['an unusable answer', new Error('Could not find category in LLM response: hello')],
    ['a 400 for this prompt', apiError(400)],
    ['a 429, which the rate limiter owns', apiError(429)],
    ['a non-error', 'oops'],
  ])('is false for %s', (_name, error) => {
    expect(isModelUnreachable(error)).toBe(false);
  });
});

describe('ModelHealthCheck', () => {
  const ok = (body: unknown) => jest.fn().mockResolvedValue({
    ok: true, status: 200, json: () => Promise.resolve(body),
  });
  const lmStudio = { data: [{ id: 'google/gemma-4-26b-a4b' }, { id: 'text-embedding' }] };

  it('passes when LM Studio lists the model', async () => {
    const fetchFn = ok(lmStudio);
    const check = new ModelHealthCheck('openai', 'http://doitall:1234/v1/', 'google/gemma-4-26b-a4b', 'lm-studio', 1000, fetchFn);
    await expect(check.check()).resolves.toBeNull();
    expect(fetchFn).toHaveBeenCalledWith('http://doitall:1234/v1/models', expect.objectContaining({
      headers: { Authorization: 'Bearer lm-studio' },
    }));
  });

  it('fails when the model is not listed', async () => {
    const check = new ModelHealthCheck('openai', 'http://doitall:1234/v1', 'other-model', '', 1000, ok(lmStudio));
    await expect(check.check()).resolves.toMatch(/does not list model "other-model"/);
  });

  it('fails when the server does not answer', async () => {
    const fetchFn = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    const check = new ModelHealthCheck('openai', 'http://doitall:1234/v1', 'm', '', 1000, fetchFn);
    await expect(check.check()).resolves.toMatch(/did not answer within 1s \(fetch failed\)/);
  });

  it('fails on an HTTP error', async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: false, status: 502, json: () => Promise.resolve({}),
    });
    const check = new ModelHealthCheck('openai', 'http://doitall:1234/v1', 'm', '', 1000, fetchFn);
    await expect(check.check()).resolves.toMatch(/HTTP 502/);
  });

  it('probes Ollama at /tags and accepts a name without :latest', async () => {
    const fetchFn = ok({ models: [{ name: 'llama3.1:latest' }] });
    const check = new ModelHealthCheck('ollama', 'http://h:11434/api', 'llama3.1', '', 1000, fetchFn);
    await expect(check.check()).resolves.toBeNull();
    expect(fetchFn).toHaveBeenCalledWith('http://h:11434/api/tags', expect.anything());
  });

  it.each([
    ['anthropic', 'https://api.anthropic.com/v1'],
    ['openai', 'https://api.openai.com/v1'],
  ])('does not probe hosted %s', async (provider, base) => {
    const fetchFn = jest.fn();
    await expect(new ModelHealthCheck(provider, base, 'm', 'k', 1000, fetchFn).check()).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('when the model stops answering', () => {
  let api: InMemoryActualApiService;
  let llm: MockedLlmService;
  let transactionService: TransactionService;

  beforeEach(() => {
    api = new InMemoryActualApiService();
    llm = new MockedLlmService();
    const processor = new TransactionProcessor(api, llm, new MockedPromptGenerator(), tagService, [
      new RuleMatchStrategy(api, tagService),
      new ExistingCategoryStrategy(api, tagService),
      new NewCategoryStrategy(api, tagService),
    ]);
    transactionService = new TransactionService(
      api,
      new CategorySuggester(
        api,
        new CategorySuggestionOptimizer(new SimilarityCalculator()),
        tagService,
      ),
      new BatchTransactionProcessor(processor, 20),
      new TransactionFilterer(tagService),
      false,
      tagService,
    );
    api.setCategoryGroups(GivenActualData.createSampleCategoryGroups());
    api.setCategories(GivenActualData.createSampleCategories());
    api.setPayees(GivenActualData.createSamplePayees());
    api.setAccounts(GivenActualData.createSampleAccounts());
    api.setRules([]);
    api.setTransactions([
      GivenActualData.createTransaction('1', -100, 'Carrefour 1', 'note one'),
      GivenActualData.createTransaction('2', -200, 'Carrefour 2', 'note two'),
    ]);
  });

  it('stops the run and leaves every transaction untouched', async () => {
    llm.setError(connectionRefused());

    await expect(transactionService.processTransactions())
      .rejects.toBeInstanceOf(ModelUnavailableException);

    const notes = (await api.getTransactions()).map((t) => t.notes);
    expect(notes).toEqual(['note one', 'note two']);
  });

  it('still marks a transaction as missed when the answer was merely unusable', async () => {
    llm.setError(new Error('Could not find category in LLM response: hmm'));

    await transactionService.processTransactions();

    const notes = (await api.getTransactions()).map((t) => t.notes);
    expect(notes).toEqual(['note one #actual-ai-miss', 'note two #actual-ai-miss']);
  });

  it('skips the whole run, without opening the budget, when the health check fails', async () => {
    const initializeApi = jest.spyOn(api, 'initializeApi');
    const processTransactions = jest.spyOn(transactionService, 'processTransactions');
    const healthCheck = { check: jest.fn().mockResolvedValue('down') } as unknown as ModelHealthCheck;

    await new ActualAiService(transactionService, api, healthCheck).classify();

    expect(initializeApi).not.toHaveBeenCalled();
    expect(processTransactions).not.toHaveBeenCalled();
  });

  it('runs as usual when the health check passes', async () => {
    llm.setUnifiedResponse({ type: 'existing', categoryId: GivenActualData.CATEGORY_GROCERIES });
    const healthCheck = { check: jest.fn().mockResolvedValue(null) } as unknown as ModelHealthCheck;

    await new ActualAiService(transactionService, api, healthCheck).classify();

    const categories = (await api.getTransactions()).map((t) => t.category);
    const { CATEGORY_GROCERIES } = GivenActualData;
    expect(categories).toEqual([CATEGORY_GROCERIES, CATEGORY_GROCERIES]);
  });
});

describe('PayeeHistory', () => {
  const categories = GivenActualData.createSampleCategories();
  const { CATEGORY_GROCERIES: GROCERIES, CATEGORY_TRAVEL: TRAVEL } = GivenActualData;
  const tx = (
    id: string,
    importedPayee: string,
    category: string | undefined,
    extra: Partial<TransactionEntity> = {},
  ): TransactionEntity => ({
    ...GivenActualData.createTransaction(id, -1, importedPayee, '', undefined, undefined, undefined, false, category),
    ...extra,
  });

  it('counts how each payee was categorized, most used first', () => {
    const history = new PayeeHistory([
      tx('1', 'x', TRAVEL, { payee: 'p1' }),
      tx('2', 'x', GROCERIES, { payee: 'p1' }),
      tx('3', 'x', GROCERIES, { payee: 'p1' }),
    ], categories, tagService);

    expect(history.lookup(tx('new', 'whatever', undefined, { payee: 'p1' }))).toEqual([
      { categoryId: GROCERIES, categoryName: 'Groceries', count: 2 },
      { categoryId: TRAVEL, categoryName: 'Travel', count: 1 },
    ]);
  });

  it('falls back to the bank description without store numbers and dates', () => {
    const history = new PayeeHistory([tx('1', 'TST* DOS EQUIS #123 04/12', GROCERIES)], categories, tagService);

    expect(normalizeImportedPayee('TST* DOS EQUIS #123 04/12')).toBe('dos equis');
    expect(history.lookup(tx('new', 'TST* Dos Equis #77 11/01', undefined))).toHaveLength(1);
    expect(history.lookup(tx('new', 'Something Else', undefined))).toEqual([]);
  });

  it('learns only from categories a person set', () => {
    const history = new PayeeHistory([
      tx('guessed', 'Shop', TRAVEL, { notes: 'x #actual-ai' }),
      tx('missed then set by hand', 'Shop', GROCERIES, { notes: 'x #actual-ai-miss' }),
      tx('approved suggestion', 'Shop', GROCERIES, { notes: '#ai-suggest Groceries' }),
      tx('transfer', 'Shop', TRAVEL, { transfer_id: 't' }),
      tx('uncategorized', 'Shop', undefined),
      tx('deleted category', 'Shop', 'gone'),
    ], categories, tagService);

    expect(history.size).toBe(2);
    expect(history.lookup(tx('new', 'Shop', undefined))).toEqual([
      { categoryId: GROCERIES, categoryName: 'Groceries', count: 2 },
    ]);
  });

  it('learns from the parts of a split, not the parent', () => {
    const history = new PayeeHistory([
      tx('parent', 'Costco', undefined, {
        is_parent: true,
        subtransactions: [tx('a', 'Costco', GROCERIES), tx('b', 'Costco', TRAVEL)],
      }),
    ], categories, tagService);

    expect(history.size).toBe(2);
  });
});

describe('history in the prompt', () => {
  const template = fs.readFileSync('./src/templates/prompt.hbs', 'utf8').trim();
  const generator = new PromptGenerator(template);
  const transaction = GivenActualData.createTransaction('1', -500, 'Carrefour');
  const generate = (history?: PayeeHistoryEntry[]) => generator.generate(
    GivenActualData.createSampleCategoryGroups(),
    transaction,
    GivenActualData.createSamplePayees(),
    [],
    history,
  );

  it('lists earlier categories for the payee', () => {
    const prompt = generate([
      { categoryId: 'g', categoryName: 'Groceries', count: 5 },
      { categoryId: 't', categoryName: 'Travel', count: 1 },
    ]);
    expect(prompt).toContain('How I categorized earlier transactions from this payee');
    expect(prompt).toContain('* Groceries (ID: "g"): 5 times');
    expect(prompt).toContain('* Travel (ID: "t"): 1 time\n');
  });

  it('leaves the section out without history', () => {
    expect(generate()).not.toContain('earlier transactions');
    expect(generate([])).not.toContain('earlier transactions');
  });

  it('is passed the history of the transaction being processed', async () => {
    const api = new InMemoryActualApiService();
    const llm = new MockedLlmService();
    llm.setUnifiedResponse({ type: 'existing', categoryId: GivenActualData.CATEGORY_GROCERIES });
    const promptGenerator = new MockedPromptGenerator();
    const generateSpy = jest.spyOn(promptGenerator, 'generate');
    const history = new PayeeHistory([
      { ...transaction, id: 'old', category: GivenActualData.CATEGORY_GROCERIES },
    ], GivenActualData.createSampleCategories(), tagService);
    api.setTransactions([transaction]);

    await new TransactionProcessor(api, llm, promptGenerator, tagService, [
      new ExistingCategoryStrategy(api, tagService),
    ]).process(
      transaction,
      [],
      [],
      [],
      GivenActualData.createSampleCategories(),
      new Map(),
      history,
    );

    expect(generateSpy.mock.calls[0][4]).toEqual([
      { categoryId: GivenActualData.CATEGORY_GROCERIES, categoryName: 'Groceries', count: 1 },
    ]);
  });
});

describe('TagService.isGuessed', () => {
  it.each([
    ['note #actual-ai', true],
    ['note #actual-ai (rule: X)', true],
    ['note #actual-ai-miss', false],
    ['#ai-suggest Groceries', false],
    ['', false],
  ])('%s -> %s', (notes, expected) => {
    expect(tagService.isGuessed(notes)).toBe(expected);
  });
});
