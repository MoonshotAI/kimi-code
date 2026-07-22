import { describe, expect, it, vi } from 'vitest';

import { abortError } from '#/_base/utils/abort';
import { CoreErrors } from '#/_base/errors/codes';
import { Error2 } from '#/_base/errors/errors';
import { type IModelCatalog, type ModelCatalogItem } from '#/kosong/model/catalog';
import { type QuestionRequest, type QuestionResult } from '#/session/question/question';
import { createSubagentBindingAsker } from '#/session/subagent/bindingAsk';

import { stubWorkspaceLocalConfig } from '../../app/workspaceLocalConfig/stubs';
import { stubQuestionService } from '../question/stubs';

const WORK_DIR = '/repo/work';
const INHERIT_LABEL = 'Keep inheriting from the main agent';

function modelItem(model: string, supportEfforts?: string[]): ModelCatalogItem {
  return {
    provider: 'mock',
    model,
    max_context_size: 8192,
    support_efforts: supportEfforts,
  };
}

function stubCatalog(items: readonly ModelCatalogItem[]): IModelCatalog {
  return {
    _serviceBrand: undefined,
    listModels: vi.fn(async () => items),
  } as unknown as IModelCatalog;
}

function answer(req: QuestionRequest, label: string): QuestionResult {
  return { answers: { [req.questions[0]?.question ?? '']: label } };
}

describe('createSubagentBindingAsker', () => {
  it('offers inherit first, then every catalog model, under the Subagent header', async () => {
    const question = stubQuestionService({ respond: (req) => answer(req, 'kimi-k2') });
    const config = stubWorkspaceLocalConfig();
    const asker = createSubagentBindingAsker({
      question,
      workspaceLocalConfig: config,
      modelCatalog: stubCatalog([modelItem('kimi-k2'), modelItem('gpt-x')]),
      workDir: WORK_DIR,
      agentId: 'agent-caller',
    });

    await asker('coder');

    expect(question.request).toHaveBeenCalledOnce();
    const item = question.request.mock.calls[0]?.[0].questions[0];
    expect(item?.header).toBe('Subagent');
    expect(item?.question).toBe(
      'Subagent type "coder" has no model binding in this workspace. Bind a model for it?',
    );
    expect(item?.options).toEqual([
      {
        label: INHERIT_LABEL,
        description: 'Recorded as the choice for this workspace; you will not be asked again',
      },
      { label: 'kimi-k2' },
      { label: 'gpt-x' },
    ]);
  });

  it('persists the chosen model under the type section and returns the binding', async () => {
    const question = stubQuestionService({ respond: (req) => answer(req, 'kimi-k2') });
    const config = stubWorkspaceLocalConfig();
    const writeType = vi.spyOn(config, 'writeSubagentBinding');
    const asker = createSubagentBindingAsker({
      question,
      workspaceLocalConfig: config,
      modelCatalog: stubCatalog([modelItem('kimi-k2')]),
      workDir: WORK_DIR,
      agentId: 'agent-caller',
    });

    await expect(asker('coder')).resolves.toEqual({
      model: 'kimi-k2',
      thinkingEffort: undefined,
    });
    expect(writeType).toHaveBeenCalledWith(WORK_DIR, 'coder', {
      model: 'kimi-k2',
      thinkingEffort: undefined,
    });
  });

  it('persists under the slot section and names the slot when the ask carries a slot context', async () => {
    const question = stubQuestionService({ respond: (req) => answer(req, 'kimi-k2') });
    const config = stubWorkspaceLocalConfig();
    const writeType = vi.spyOn(config, 'writeSubagentBinding');
    const writeSlot = vi.spyOn(config, 'writeSubagentSlotBinding');
    const asker = createSubagentBindingAsker({
      question,
      workspaceLocalConfig: config,
      modelCatalog: stubCatalog([modelItem('kimi-k2')]),
      workDir: WORK_DIR,
      agentId: 'agent-caller',
    });

    await asker('coder', { slot: 'fast' });

    expect(question.request.mock.calls[0]?.[0].questions[0]?.question).toBe(
      'Binding slot "fast" has no model binding in this workspace. Bind a model for it?',
    );
    expect(writeSlot).toHaveBeenCalledWith(WORK_DIR, 'fast', {
      model: 'kimi-k2',
      thinkingEffort: undefined,
    });
    expect(writeType).not.toHaveBeenCalled();
  });

  it('explains the missing model in the repair question', async () => {
    const question = stubQuestionService({ respond: (req) => answer(req, INHERIT_LABEL) });
    const asker = createSubagentBindingAsker({
      question,
      workspaceLocalConfig: stubWorkspaceLocalConfig(),
      modelCatalog: stubCatalog([modelItem('kimi-k2')]),
      workDir: WORK_DIR,
      agentId: 'agent-caller',
    });

    await asker('coder', { missingModel: 'gone/model' });

    expect(question.request.mock.calls[0]?.[0].questions[0]?.question).toBe(
      'Subagent type "coder" is bound to model "gone/model", but that alias no longer exists in your models config or cannot be resolved. Bind a model for it?',
    );
  });

  it('persists inherit:true when the user keeps inheriting and skips the effort question', async () => {
    const question = stubQuestionService({ respond: (req) => answer(req, INHERIT_LABEL) });
    const config = stubWorkspaceLocalConfig();
    const writeType = vi.spyOn(config, 'writeSubagentBinding');
    const asker = createSubagentBindingAsker({
      question,
      workspaceLocalConfig: config,
      modelCatalog: stubCatalog([modelItem('kimi-k2', ['low', 'high'])]),
      workDir: WORK_DIR,
      agentId: 'agent-caller',
    });

    await expect(asker('coder')).resolves.toEqual({ inherit: true });
    expect(writeType).toHaveBeenCalledWith(WORK_DIR, 'coder', { inherit: true });
    expect(question.request).toHaveBeenCalledOnce();
  });

  it('asks the thinking effort when the chosen model supports efforts', async () => {
    const question = stubQuestionService({
      respond: (req) =>
        req.questions[0]?.question.startsWith('Thinking effort') === true
          ? answer(req, 'high')
          : answer(req, 'kimi-k2'),
    });
    const config = stubWorkspaceLocalConfig();
    const writeType = vi.spyOn(config, 'writeSubagentBinding');
    const asker = createSubagentBindingAsker({
      question,
      workspaceLocalConfig: config,
      modelCatalog: stubCatalog([modelItem('kimi-k2', ['low', 'high'])]),
      workDir: WORK_DIR,
      agentId: 'agent-caller',
    });

    await expect(asker('coder')).resolves.toEqual({ model: 'kimi-k2', thinkingEffort: 'high' });
    expect(question.request).toHaveBeenCalledTimes(2);
    const effortItem = question.request.mock.calls[1]?.[0].questions[0];
    expect(effortItem?.question).toBe('Thinking effort for Subagent type "coder" on kimi-k2?');
    expect(effortItem?.options).toEqual([
      { label: INHERIT_LABEL, description: 'Inherit the main agent thinking effort' },
      { label: 'low' },
      { label: 'high' },
    ]);
    expect(writeType).toHaveBeenCalledWith(WORK_DIR, 'coder', {
      model: 'kimi-k2',
      thinkingEffort: 'high',
    });
  });

  it('leaves the effort unset when the effort question keeps inheriting', async () => {
    const question = stubQuestionService({
      respond: (req) =>
        req.questions[0]?.question.startsWith('Thinking effort') === true
          ? answer(req, INHERIT_LABEL)
          : answer(req, 'kimi-k2'),
    });
    const config = stubWorkspaceLocalConfig();
    const writeType = vi.spyOn(config, 'writeSubagentBinding');
    const asker = createSubagentBindingAsker({
      question,
      workspaceLocalConfig: config,
      modelCatalog: stubCatalog([modelItem('kimi-k2', ['low', 'high'])]),
      workDir: WORK_DIR,
      agentId: 'agent-caller',
    });

    await expect(asker('coder')).resolves.toEqual({
      model: 'kimi-k2',
      thinkingEffort: undefined,
    });
    expect(writeType).toHaveBeenCalledWith(WORK_DIR, 'coder', {
      model: 'kimi-k2',
      thinkingEffort: undefined,
    });
  });

  it('returns undefined without persisting when the client does not support questions', async () => {
    const question = stubQuestionService({
      error: new Error2(CoreErrors.codes.NOT_IMPLEMENTED, 'questions are not supported'),
    });
    const config = stubWorkspaceLocalConfig();
    const writeType = vi.spyOn(config, 'writeSubagentBinding');
    const asker = createSubagentBindingAsker({
      question,
      workspaceLocalConfig: config,
      modelCatalog: stubCatalog([modelItem('kimi-k2')]),
      workDir: WORK_DIR,
      agentId: 'agent-caller',
    });

    await expect(asker('coder')).resolves.toBeUndefined();
    expect(writeType).not.toHaveBeenCalled();
  });

  it('returns undefined without persisting when the user dismisses the question', async () => {
    const question = stubQuestionService();
    const config = stubWorkspaceLocalConfig();
    const writeType = vi.spyOn(config, 'writeSubagentBinding');
    const asker = createSubagentBindingAsker({
      question,
      workspaceLocalConfig: config,
      modelCatalog: stubCatalog([modelItem('kimi-k2')]),
      workDir: WORK_DIR,
      agentId: 'agent-caller',
    });

    await expect(asker('coder')).resolves.toBeUndefined();
    expect(question.request).toHaveBeenCalledOnce();
    expect(writeType).not.toHaveBeenCalled();
  });

  it('returns undefined without asking when the catalog lists no models', async () => {
    const question = stubQuestionService();
    const asker = createSubagentBindingAsker({
      question,
      workspaceLocalConfig: stubWorkspaceLocalConfig(),
      modelCatalog: stubCatalog([]),
      workDir: WORK_DIR,
      agentId: 'agent-caller',
    });

    await expect(asker('coder')).resolves.toBeUndefined();
    expect(question.request).not.toHaveBeenCalled();
  });

  it('routes the question to the asking agent under the spawn signal', async () => {
    const signal = new AbortController().signal;
    const question = stubQuestionService({ respond: (req) => answer(req, INHERIT_LABEL) });
    const asker = createSubagentBindingAsker({
      question,
      workspaceLocalConfig: stubWorkspaceLocalConfig(),
      modelCatalog: stubCatalog([modelItem('kimi-k2')]),
      workDir: WORK_DIR,
      agentId: 'agent-caller',
      signal,
    });

    await asker('coder');

    expect(question.request).toHaveBeenCalledWith(expect.anything(), {
      agentId: 'agent-caller',
      signal,
    });
  });

  it('propagates abort errors without persisting', async () => {
    const question = stubQuestionService({ error: abortError() });
    const config = stubWorkspaceLocalConfig();
    const writeType = vi.spyOn(config, 'writeSubagentBinding');
    const asker = createSubagentBindingAsker({
      question,
      workspaceLocalConfig: config,
      modelCatalog: stubCatalog([modelItem('kimi-k2')]),
      workDir: WORK_DIR,
      agentId: 'agent-caller',
    });

    await expect(asker('coder')).rejects.toThrow('Aborted');
    expect(writeType).not.toHaveBeenCalled();
  });

  it('throws when the spawn signal is already aborted instead of inheriting', async () => {
    const controller = new AbortController();
    controller.abort(abortError());
    const config = stubWorkspaceLocalConfig();
    const writeType = vi.spyOn(config, 'writeSubagentBinding');
    const asker = createSubagentBindingAsker({
      question: stubQuestionService(),
      workspaceLocalConfig: config,
      modelCatalog: stubCatalog([modelItem('kimi-k2')]),
      workDir: WORK_DIR,
      agentId: 'agent-caller',
      signal: controller.signal,
    });

    await expect(asker('coder')).rejects.toThrow('Aborted');
    expect(writeType).not.toHaveBeenCalled();
  });

  it('assigns distinct request ids to consecutive asks', async () => {
    const question = stubQuestionService({ respond: (req) => answer(req, 'kimi-k2') });
    const asker = createSubagentBindingAsker({
      question,
      workspaceLocalConfig: stubWorkspaceLocalConfig(),
      modelCatalog: stubCatalog([modelItem('kimi-k2')]),
      workDir: WORK_DIR,
      agentId: 'agent-caller',
    });

    await asker('coder');
    await asker('explorer');

    const firstId = question.request.mock.calls[0]?.[0].id;
    const secondId = question.request.mock.calls[1]?.[0].id;
    expect(firstId).toMatch(/^subagent-binding:agent-caller:\d+$/);
    expect(secondId).toMatch(/^subagent-binding:agent-caller:\d+$/);
    expect(firstId).not.toBe(secondId);
  });
});
