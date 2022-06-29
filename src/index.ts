import {
  EvaluationPair,
  ExecutionOutput,
  extractJsEvaluationPairsWithTokenizer,
  IntegrationError,
  JavascriptDatasourceConfiguration
} from '@superblocksteam/shared';
import { LanguagePlugin, PluginExecutionProps } from '@superblocksteam/shared-backend';
import { tokenize } from 'esprima';
import { JavascriptProcessInput } from './bootstrap';
import { WorkerPool } from './pool';

export default class JavascriptPlugin extends LanguagePlugin {
  async init(): Promise<void> {
    WorkerPool.configure();
  }

  async shutdown(): Promise<void> {
    await WorkerPool.shutdown();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async evaluateBindingPairs(code: string, entitiesToExtract: Set<string>, dataContext: Record<string, any>): Promise<EvaluationPair[]> {
    return await extractJsEvaluationPairsWithTokenizer(code, entitiesToExtract, dataContext, tokenize);
  }

  async execute({
    context,
    actionConfiguration,
    files
  }: PluginExecutionProps<JavascriptDatasourceConfiguration>): Promise<ExecutionOutput> {
    try {
      const executionTimeout = Number(this.pluginConfiguration.javascriptExecutionTimeoutMs);
      // TODO: Wrap the user's code in a library that handles the FileReader abstraction
      const output = await this.executeInWorkerPool(
        {
          context: context,
          code: actionConfiguration.body,
          files,
          executionTimeout
        },
        executionTimeout
      );
      return output;
    } catch (err) {
      throw new IntegrationError(err);
    }
  }

  async executeInWorkerPool(input: JavascriptProcessInput, timeout: number): Promise<ExecutionOutput> {
    const abortController = new AbortController();
    const { signal } = abortController;

    const timeoutWatcher = setTimeout(() => {
      abortController.abort();
      clearTimeout(timeoutWatcher);
    }, timeout);

    try {
      const outputJSON = await WorkerPool.run(input, signal);
      return ExecutionOutput.fromJSONString(outputJSON);
    } catch (err) {
      // Annotate the AbortError, which is triggered by the timeout.
      if (err.name === 'AbortError') {
        throw new IntegrationError(`Timed out after ${timeout}ms`);
      }
      throw err;
    } finally {
      // Always attempt to clear timeout once the execution
      // has completed.
      clearTimeout(timeoutWatcher);
    }
  }
}
