import { expect, test } from 'bun:test';
import { enforceAgentPolicy } from '../apps/cli/src/agent-mode';
import { parseArgs } from '../apps/cli/src/args';

test('agent read policy permits workflow reads and rejects local workflow mutations', () => {
  const old = process.env.ASANA_CLI_AGENT_POLICY; process.env.ASANA_CLI_AGENT_POLICY = 'read';
  try {
    expect(() => enforceAgentPolicy(parseArgs(['work','list','--agent']))).not.toThrow();
    expect(() => enforceAgentPolicy(parseArgs(['work','wait','--input','-','--agent']))).toThrow('Local workflow writes require');
    process.env.ASANA_CLI_AGENT_POLICY = 'read-write';
    expect(() => enforceAgentPolicy(parseArgs(['work','wait','--input','-','--agent']))).not.toThrow();
  } finally { if (old === undefined) delete process.env.ASANA_CLI_AGENT_POLICY; else process.env.ASANA_CLI_AGENT_POLICY = old; }
});
