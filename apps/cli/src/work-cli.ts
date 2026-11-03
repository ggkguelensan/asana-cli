import { z } from 'zod';
import { createWorkSchema, workActionSchema } from '@asana-cli/core/workflow';
import { stringFlag, requirePositional, type ParsedArgs } from './args';
import { readJsonInput } from './io';
import { CliError } from './errors';
import { serviceRequest } from './service-cli';

function workInput(args: ParsedArgs): string {
  const input = stringFlag(args, 'input');
  if (!input) throw new CliError('usage', 'Work mutations require --input <@file|->');
  return input;
}
export async function runWorkCommand(args: ParsedArgs) {
  const action = args.positionals[1];
  if (action === 'list') return serviceRequest('/api/v1/work');
  const inputPath = workInput(args);
  if (action === 'wait') return serviceRequest('/api/v1/work', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await readJsonInput(inputPath, "work input", createWorkSchema)) });
  if (action !== 'action') throw new CliError('usage', 'Use work list|wait|action');
  const id = z.uuid().parse(requirePositional(args, 2, 'work id'));
  return serviceRequest(`/api/v1/work/${id}/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await readJsonInput(inputPath, "work action", workActionSchema)) });
}
